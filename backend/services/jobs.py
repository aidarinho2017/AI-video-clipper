import json
import logging
import threading
from pathlib import Path
from uuid import uuid4

from .. import auth
from ..config import settings
from ..models import PipelineError
from . import analysis, transcription, video, youtube

# ponytail: one process and one active job; use a durable worker queue if concurrency becomes necessary.
lock = threading.Lock()
log = logging.getLogger(__name__)


def save(folder: Path, state: dict):
    temporary = folder / "status.tmp"
    temporary.write_text(json.dumps(state, allow_nan=False), encoding="utf-8")
    temporary.replace(folder / "status.json")


def read(job_id: str) -> dict:
    return json.loads((settings.data_dir / job_id / "status.json").read_text(encoding="utf-8"))


def recover():
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    for path in settings.data_dir.glob("*/status.json"):
        try:
            state = json.loads(path.read_text())
            if state["status"] in {"queued", "processing"}:
                if state.get("source_type") == "upload":
                    (path.parent / "source.partial").unlink(missing_ok=True)
                refunded = auth.refund_once(state.get("owner_id", ""), state.get("credits_reserved", 0),
                                            f"job:{state['id']}:refund") if state.get("owner_id") else 0
                state.update(status="failed", error="Backend restarted during processing. Please generate again.")
                state["credits_refunded"] = refunded
                save(path.parent, state)
        except (OSError, ValueError, KeyError):
            log.exception("Could not recover job %s", path.parent.name)


def create(url: str, model_id: str = analysis.DEFAULT_MODEL, clip_length: str = "short",
           clip_count: int = 5, owner_id: str = "", source_type: str = "youtube") -> dict:
    job_id = str(uuid4())
    folder = settings.data_dir / job_id
    folder.mkdir(parents=True)
    state = dict(id=job_id, status="queued", stage="uploading" if source_type == "upload" else "downloading", model=model_id,
                 source_type=source_type,
                 clip_length=clip_length, clip_count=clip_count,
                 owner_id=owner_id, credits_reserved=0 if source_type == "upload" else clip_count, credits_refunded=0,
                 completed_clips=0, clips=[], error=None)
    save(folder, state)
    return state


def process(job_id: str, url: str, model_id: str = analysis.DEFAULT_MODEL, instructions: str = "",
            clip_length: str = "short", clip_count: int = 5):
    folder = settings.data_dir / job_id
    state = None

    def update(stage):
        state.update(status="processing", stage=stage)
        save(folder, state)

    try:
        state = read(job_id)
        if state.get("source_type", "youtube") == "upload":
            update("preparing")
            source, captions = folder / "source.upload", None
        else:
            update("downloading")
            source, captions = youtube.download(url, folder, settings.max_video_seconds)
        duration = video.probe(source)
        if not 75 <= duration <= settings.max_video_seconds:
            raise PipelineError("Video duration is outside the configured limits.")
        transcript = None
        if captions:
            try:
                transcript = transcription.from_text(youtube.transcript(captions), duration, "youtube")
                transcript.words = youtube.timed_words(captions, duration)
            except (PipelineError, ValueError):
                log.warning("YouTube captions unusable; transcribing audio instead.")
        if transcript is None:
            update("preparing")
            audio = folder / "audio.m4a"
            video.extract_audio(source, audio)
            update("transcribing")
            transcript = transcription.transcribe(audio, duration)
        (folder / "transcript.json").write_text(transcript.model_dump_json(), encoding="utf-8")
        state["transcription_provider"] = transcript.provider
        update("analyzing")
        selected, candidates = analysis.analyze(
            transcript.timed_text(), duration, update, model_id, instructions, clip_length, clip_count)
        (folder / "candidates.json").write_text(json.dumps(candidates), encoding="utf-8")
        update("rendering")
        for index, clip in enumerate(selected, 1):
            if transcript.words:
                video.render(source, folder / f"clip-{index}.mp4", clip, transcript.timed_text(), transcript.words)
            else:
                video.render(source, folder / f"clip-{index}.mp4", clip, transcript.timed_text())
            state["clips"].append({**clip.model_dump(), "index": index})
            state["completed_clips"] = index
            save(folder, state)
        state.update(status="completed", stage="completed")
        state["credits_refunded"] = auth.refund_once(
            state["owner_id"], clip_count - len(selected), f"job:{job_id}:refund")
        save(folder, state)
    except Exception as exc:
        log.exception("Job %s failed", job_id)
        if state is not None:
            state["credits_refunded"] = auth.refund_once(
                state["owner_id"], state.get("credits_reserved", clip_count), f"job:{job_id}:refund")
            state.update(status="failed", error=str(exc) if isinstance(exc, PipelineError) else "Processing failed unexpectedly. Check the backend log and try again.")
            save(folder, state)
    finally:
        lock.release()
