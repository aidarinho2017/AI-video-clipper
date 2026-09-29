import json
import logging
from pathlib import Path
from uuid import UUID, uuid4

from ..config import settings
from ..models import EditorExportRequest, JobSource, PipelineError, UploadSource
from . import jobs, video

log = logging.getLogger(__name__)


def _save(folder: Path, state: dict):
    temporary = folder / "status.tmp"
    temporary.write_text(json.dumps(state, allow_nan=False), encoding="utf-8")
    temporary.replace(folder / "status.json")


def source_folder(source_id: UUID) -> Path:
    return settings.data_dir / "editor-sources" / str(source_id)


def create_source() -> tuple[UUID, Path]:
    source_id = uuid4()
    folder = source_folder(source_id)
    folder.mkdir(parents=True)
    return source_id, folder


def read_source(source_id: UUID) -> tuple[Path, dict]:
    folder = source_folder(source_id)
    return folder / "source", json.loads((folder / "metadata.json").read_text(encoding="utf-8"))


def job_source(job_id: UUID) -> Path:
    state = jobs.read(str(job_id))
    if state["status"] != "completed":
        raise PipelineError("The AI job must be completed before its source can be edited.")
    sources = [path for path in (settings.data_dir / str(job_id)).glob("source.*") if path.suffix in {".mp4", ".mkv", ".webm"}]
    if len(sources) != 1:
        raise PipelineError("The original source video is unavailable.")
    return sources[0]


def resolve_source(source: UploadSource | JobSource) -> Path:
    if isinstance(source, UploadSource):
        path, _ = read_source(source.id)
        return path
    return job_source(source.job_id)


def create_export(edit: EditorExportRequest) -> dict:
    for segment in edit.segments:
        if segment.source_end > video.probe_media(resolve_source(segment.source))["duration"]:
            raise PipelineError("A video segment exceeds its source duration.")
    export_id = uuid4()
    folder = settings.data_dir / "editor-exports" / str(export_id)
    folder.mkdir(parents=True)
    state = {"id": str(export_id), "status": "queued", "error": None}
    _save(folder, state)
    return state


def read_export(export_id: UUID) -> dict:
    return json.loads((settings.data_dir / "editor-exports" / str(export_id) / "status.json").read_text(encoding="utf-8"))


def process_export(export_id: str, edit: EditorExportRequest):
    folder = settings.data_dir / "editor-exports" / export_id
    state = read_export(UUID(export_id))
    try:
        state["status"] = "processing"
        _save(folder, state)
        sources = [(resolve_source(segment.source), segment) for segment in edit.segments]
        video.render_edit(sources, folder / "video.mp4", edit)
        state["status"] = "completed"
        _save(folder, state)
    except Exception as exc:
        log.exception("Editor export %s failed", export_id)
        state.update(status="failed", error=str(exc) if isinstance(exc, PipelineError) else "Video export failed unexpectedly. Check the backend log and try again.")
        _save(folder, state)
    finally:
        jobs.lock.release()


def recover():
    root = settings.data_dir / "editor-exports"
    root.mkdir(parents=True, exist_ok=True)
    for path in root.glob("*/status.json"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            if state["status"] in {"queued", "processing"}:
                state.update(status="failed", error="Backend restarted during export. Please export again.")
                _save(path.parent, state)
        except (OSError, ValueError, KeyError):
            log.exception("Could not recover editor export %s", path.parent.name)
