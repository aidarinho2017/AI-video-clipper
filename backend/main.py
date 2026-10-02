import json
import logging
import shutil
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import auth, billing
from .config import settings
from .models import CheckoutRequest, EditorExportRequest, GoogleCredential, JobRequest, PipelineError
from .services import analysis, editor, jobs, video
from .services.youtube import canonical_url

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app):
    auth.init()
    try:
        jobs.recover()
        editor.recover()
        yield
    finally:
        auth.close()


app = FastAPI(title="Local AI Video Clipper", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Range"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Disposition"],
)

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/auth/config")
def auth_config():
    return {"google_client_id": settings.google_client_id}


@app.post("/auth/google")
def google_login(body: GoogleCredential, response: Response):
    user = auth.upsert_user(auth.verify_google(body.credential))
    response.set_cookie(auth.COOKIE, auth.issue_session(user["google_sub"]), httponly=True,
                        secure=settings.auth_cookie_secure, samesite="lax", max_age=30 * 24 * 60 * 60)
    return {"user": {**auth.public_user(user), **billing.subscription_payload(user)}}


@app.get("/auth/me")
def me(user: dict = Depends(auth.current_user)):
    return {**auth.public_user(user), **billing.subscription_payload(user)}


@app.post("/auth/logout", status_code=204)
def logout(response: Response):
    response.delete_cookie(auth.COOKIE, secure=settings.auth_cookie_secure, samesite="lax")


@app.get("/ai/models")
def ai_models():
    return analysis.catalog()


@app.get("/billing/plans")
def billing_plans():
    return {"plans": billing.catalog()}


@app.post("/billing/checkout")
def create_checkout(body: CheckoutRequest, user: dict = Depends(auth.current_user)):
    return {"url": billing.checkout(user, body.plan)}


@app.post("/billing/portal")
def create_billing_portal(user: dict = Depends(auth.current_user)):
    return {"url": billing.portal(user)}


@app.post("/billing/webhook")
async def stripe_webhook(request: Request):
    billing.webhook(await request.body(), request.headers.get("stripe-signature"))
    return {"received": True}


def editor_user(user: dict = Depends(auth.current_user)):
    return billing.require_editor(user)


@app.post("/jobs", status_code=202)
def create_job(body: JobRequest, background: BackgroundTasks, user: dict = Depends(auth.current_user)):
    try:
        url = canonical_url(body.youtube_url)
    except PipelineError as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        model = analysis.get_model(body.model)
    except PipelineError as exc:
        status = 503 if body.model in analysis.MODELS else 422
        raise HTTPException(status, str(exc)) from exc
    billing.ensure_job(user, model[3], body.clip_count, body.clip_length)
    missing = [name for name in ("ffmpeg", "ffprobe") if not shutil.which(name)]
    if missing:
        raise HTTPException(503, f"Install missing dependencies: {', '.join(missing)}.")
    if not jobs.lock.acquire(blocking=False):
        raise HTTPException(409, "A video is already processing. Wait for it to finish.")
    charged = False
    try:
        credits = auth.charge(user["google_sub"], body.clip_count)
        charged = True
        state = jobs.create(url, body.model, body.clip_length, body.clip_count, user["google_sub"])
        background.add_task(jobs.process, state["id"], url, body.model, body.instructions,
                            body.clip_length, body.clip_count)
        return {**{key: value for key, value in state.items() if key != "owner_id"}, "credits": credits}
    except Exception:
        if charged:
            auth.refund(user["google_sub"], body.clip_count)
        jobs.lock.release()
        raise


@app.get("/jobs/{job_id}")
def get_job(job_id: UUID, user: dict = Depends(auth.current_user)):
    try:
        state = jobs.read(str(job_id))
        if state.get("owner_id") != user["google_sub"]:
            raise FileNotFoundError
        return {**{key: value for key, value in state.items() if key != "owner_id"},
                "credits": user["credits"]}
    except FileNotFoundError as exc:
        raise HTTPException(404, "Job not found. Generate a new set of clips.") from exc


@app.get("/jobs/{job_id}/clips/{index}")
def get_clip(job_id: UUID, index: int, download: bool = False,
             user: dict = Depends(auth.current_user)):
    state = get_job(job_id, user)
    if state["status"] != "completed" or index not in {c["index"] for c in state["clips"]}:
        raise HTTPException(404, "Clip not available.")
    path = settings.data_dir / str(job_id) / f"clip-{index}.mp4"
    if not path.is_file():
        raise HTTPException(404, "Clip file is missing. Generate again.")
    return FileResponse(path, media_type="video/mp4", filename=f"clip-{index}.mp4", content_disposition_type="attachment" if download else "inline")


@app.post("/editor/sources", status_code=201)
async def upload_editor_source(request: Request, user: dict = Depends(editor_user)):
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) > settings.max_upload_bytes:
                raise HTTPException(413, "Media exceeds the configured upload limit.")
        except ValueError as exc:
            raise HTTPException(400, "Invalid Content-Length header.") from exc
    source_id, folder = editor.create_source()
    temporary, size = folder / "source.partial", 0
    try:
        with temporary.open("wb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(413, "Media exceeds the configured upload limit.")
                output.write(chunk)
        if not size:
            raise HTTPException(422, "Choose a non-empty video or audio file.")
        source = folder / "source"
        metadata = video.probe_source(temporary)
        if metadata["kind"] == "audio":
            video.normalize_audio(temporary, source)
            temporary.unlink()
            metadata = video.probe_source(source)
        else:
            temporary.replace(source)
        if metadata["duration"] > settings.max_video_seconds:
            raise HTTPException(422, f"Media must be no longer than {settings.max_video_seconds // 60} minutes.")
        media_type = "audio/mp4" if metadata["kind"] == "audio" else request.headers.get("content-type", "application/octet-stream")
        metadata.update(id=str(source_id), media_type=media_type, owner_id=user["google_sub"])
        (folder / "metadata.json").write_text(json.dumps(metadata, allow_nan=False), encoding="utf-8")
        return {key: value for key, value in metadata.items() if key != "owner_id"}
    except HTTPException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    except PipelineError as exc:
        shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(422, str(exc)) from exc
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


@app.get("/editor/sources/{source_id}")
def get_editor_source(source_id: UUID, user: dict = Depends(editor_user)):
    try:
        path, metadata = editor.read_source(source_id)
        if metadata.get("owner_id") != user["google_sub"]:
            raise FileNotFoundError
    except FileNotFoundError as exc:
        raise HTTPException(404, "Editor source not found.") from exc
    return FileResponse(path, media_type=metadata.get("media_type") or "application/octet-stream")


@app.get("/editor/sources/{source_id}/waveform")
def get_editor_source_waveform(source_id: UUID, user: dict = Depends(editor_user)):
    try:
        _, metadata = editor.read_source(source_id)
        if metadata.get("owner_id") != user["google_sub"]:
            raise FileNotFoundError
        return FileResponse(editor.source_waveform(source_id), media_type="image/png")
    except FileNotFoundError as exc:
        raise HTTPException(404, "Editor source not found.") from exc
    except PipelineError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/editor/jobs/{job_id}/source")
def get_editor_job_source(job_id: UUID, user: dict = Depends(editor_user)):
    try:
        if jobs.read(str(job_id)).get("owner_id") != user["google_sub"]:
            raise FileNotFoundError
        path = editor.job_source(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "AI job not found.") from exc
    except PipelineError as exc:
        raise HTTPException(409, str(exc)) from exc
    return FileResponse(path)


@app.get("/editor/jobs/{job_id}/waveform")
def get_editor_job_waveform(job_id: UUID, user: dict = Depends(editor_user)):
    try:
        if jobs.read(str(job_id)).get("owner_id") != user["google_sub"]:
            raise FileNotFoundError
        return FileResponse(editor.job_waveform(job_id), media_type="image/png")
    except FileNotFoundError as exc:
        raise HTTPException(404, "AI job not found.") from exc
    except PipelineError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/editor/exports", status_code=202)
def create_editor_export(body: EditorExportRequest, background: BackgroundTasks,
                         user: dict = Depends(editor_user)):
    if not jobs.lock.acquire(blocking=False):
        raise HTTPException(409, "Another video is already processing. Wait for it to finish.")
    try:
        state = editor.create_export(body, user["google_sub"])
        background.add_task(editor.process_export, state["id"], body)
        return {key: value for key, value in state.items() if key != "owner_id"}
    except FileNotFoundError as exc:
        jobs.lock.release()
        raise HTTPException(404, "Editor source not found.") from exc
    except PipelineError as exc:
        jobs.lock.release()
        raise HTTPException(422, str(exc)) from exc
    except Exception:
        jobs.lock.release()
        raise


@app.get("/editor/exports/{export_id}")
def get_editor_export(export_id: UUID, user: dict = Depends(editor_user)):
    try:
        state = editor.read_export(export_id)
        if state.get("owner_id") != user["google_sub"]:
            raise FileNotFoundError
        return {key: value for key, value in state.items() if key != "owner_id"}
    except FileNotFoundError as exc:
        raise HTTPException(404, "Export not found.") from exc


@app.get("/editor/exports/{export_id}/video")
def get_editor_export_video(export_id: UUID, download: bool = False,
                            user: dict = Depends(editor_user)):
    state = get_editor_export(export_id, user)
    if state["status"] != "completed":
        raise HTTPException(404, "Export is not ready.")
    path = settings.data_dir / "editor-exports" / str(export_id) / "video.mp4"
    if not path.is_file():
        raise HTTPException(404, "Exported video is missing.")
    return FileResponse(path, media_type="video/mp4", filename="edited-video.mp4",
                        content_disposition_type="attachment" if download else "inline")
