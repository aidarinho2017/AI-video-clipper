import json
import logging
import shutil
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import settings
from .models import EditorExportRequest, JobRequest, PipelineError
from .services import analysis, editor, jobs, video
from .services.youtube import canonical_url

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app):
    jobs.recover()
    editor.recover()
    yield


app = FastAPI(title="Local AI Video Clipper", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Range"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Disposition"],
)

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ai/models")
def ai_models():
    return analysis.catalog()


@app.post("/jobs", status_code=202)
def create_job(body: JobRequest, background: BackgroundTasks):
    try:
        url = canonical_url(body.youtube_url)
    except PipelineError as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        analysis.get_model(body.model)
    except PipelineError as exc:
        status = 503 if body.model in analysis.MODELS else 422
        raise HTTPException(status, str(exc)) from exc
    missing = [name for name in ("ffmpeg", "ffprobe") if not shutil.which(name)]
    if missing:
        raise HTTPException(503, f"Install missing dependencies: {', '.join(missing)}.")
    if not jobs.lock.acquire(blocking=False):
        raise HTTPException(409, "A video is already processing. Wait for it to finish.")
    try:
        state = jobs.create(url, body.model, body.clip_length, body.clip_count)
        background.add_task(jobs.process, state["id"], url, body.model, body.instructions,
                            body.clip_length, body.clip_count)
        return state
    except Exception:
        jobs.lock.release()
        raise


@app.get("/jobs/{job_id}")
def get_job(job_id: UUID):
    try:
        return jobs.read(str(job_id))
    except FileNotFoundError as exc:
        raise HTTPException(404, "Job not found. Generate a new set of clips.") from exc


@app.get("/jobs/{job_id}/clips/{index}")
def get_clip(job_id: UUID, index: int, download: bool = False):
    state = get_job(job_id)
    if state["status"] != "completed" or index not in {c["index"] for c in state["clips"]}:
        raise HTTPException(404, "Clip not available.")
    path = settings.data_dir / str(job_id) / f"clip-{index}.mp4"
    if not path.is_file():
        raise HTTPException(404, "Clip file is missing. Generate again.")
    return FileResponse(path, media_type="video/mp4", filename=f"clip-{index}.mp4", content_disposition_type="attachment" if download else "inline")


@app.post("/editor/sources", status_code=201)
async def upload_editor_source(request: Request):
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
        metadata.update(id=str(source_id), media_type=media_type)
        (folder / "metadata.json").write_text(json.dumps(metadata, allow_nan=False), encoding="utf-8")
        return metadata
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
def get_editor_source(source_id: UUID):
    try:
        path, metadata = editor.read_source(source_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "Editor source not found.") from exc
    return FileResponse(path, media_type=metadata.get("media_type") or "application/octet-stream")


@app.get("/editor/sources/{source_id}/waveform")
def get_editor_source_waveform(source_id: UUID):
    try:
        return FileResponse(editor.source_waveform(source_id), media_type="image/png")
    except FileNotFoundError as exc:
        raise HTTPException(404, "Editor source not found.") from exc
    except PipelineError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/editor/jobs/{job_id}/source")
def get_editor_job_source(job_id: UUID):
    try:
        path = editor.job_source(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "AI job not found.") from exc
    except PipelineError as exc:
        raise HTTPException(409, str(exc)) from exc
    return FileResponse(path)


@app.get("/editor/jobs/{job_id}/waveform")
def get_editor_job_waveform(job_id: UUID):
    try:
        return FileResponse(editor.job_waveform(job_id), media_type="image/png")
    except FileNotFoundError as exc:
        raise HTTPException(404, "AI job not found.") from exc
    except PipelineError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/editor/exports", status_code=202)
def create_editor_export(body: EditorExportRequest, background: BackgroundTasks):
    if not jobs.lock.acquire(blocking=False):
        raise HTTPException(409, "Another video is already processing. Wait for it to finish.")
    try:
        state = editor.create_export(body)
        background.add_task(editor.process_export, state["id"], body)
        return state
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
def get_editor_export(export_id: UUID):
    try:
        return editor.read_export(export_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "Export not found.") from exc


@app.get("/editor/exports/{export_id}/video")
def get_editor_export_video(export_id: UUID, download: bool = False):
    state = get_editor_export(export_id)
    if state["status"] != "completed":
        raise HTTPException(404, "Export is not ready.")
    path = settings.data_dir / "editor-exports" / str(export_id) / "video.mp4"
    if not path.is_file():
        raise HTTPException(404, "Exported video is missing.")
    return FileResponse(path, media_type="video/mp4", filename="edited-video.mp4",
                        content_disposition_type="attachment" if download else "inline")
