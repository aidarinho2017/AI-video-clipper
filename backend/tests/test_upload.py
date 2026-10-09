import asyncio
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

from fastapi import BackgroundTasks
from fastapi.testclient import TestClient
from pydantic import SecretStr
from starlette.requests import ClientDisconnect

from backend import auth
from backend.config import settings
from backend.main import app, upload_job
from backend.models import ClipCandidate, JobOptions, PipelineError
from backend.services import editor, jobs


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.folder = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(settings, "data_dir", self.folder))
        self.stack.enter_context(patch.object(settings, "gemini_api_key", SecretStr("test")))
        self.stack.enter_context(patch.object(settings, "max_upload_bytes", 100))
        self.stack.enter_context(patch("backend.main.shutil.which", return_value="installed"))
        self.user = dict(google_sub="owner", credits=100, plan="starter", subscription_status="active")
        previous = app.dependency_overrides.copy()
        app.dependency_overrides[auth.current_user] = lambda: self.user
        app.dependency_overrides[auth.media_user] = lambda: self.user
        self.addCleanup(lambda: setattr(app, "dependency_overrides", previous))
        self.charge = self.stack.enter_context(patch("backend.auth.charge", return_value=99))
        self.refund = self.stack.enter_context(patch("backend.auth.refund_once", return_value=0))
        self.stack.enter_context(patch("backend.auth.refund"))
        self.probe = self.stack.enter_context(patch("backend.services.video.probe", return_value=180))
        self.download = self.stack.enter_context(patch("backend.services.youtube.download"))
        self.stack.enter_context(patch("backend.services.video.extract_audio"))
        self.stack.enter_context(patch("backend.services.gemini.transcribe", return_value="[0-180] Speech"))
        clip = ClipCandidate(start=0, end=20, title="Moment", reasoning="Useful", hook_score=80,
                             emotion_score=80, standalone_score=80, insight_score=80, virality_score=80)
        self.stack.enter_context(patch("backend.services.analysis.analyze", return_value=([clip], [])))
        self.stack.enter_context(patch("backend.services.video.render", side_effect=lambda source, target, *args: target.write_bytes(b"clip")))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def upload(self, content=b"video", **kwargs):
        return self.client.post("/jobs/upload?clip_count=1", content=content, **kwargs)

    def test_starter_upload_processes_and_preserves_source(self):
        response = self.upload(headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(response.status_code, 202, response.text)
        job_id = response.json()["id"]
        state = self.client.get(f"/jobs/{job_id}").json()
        self.assertEqual((state["status"], state["source_type"]), ("completed", "upload"))
        self.assertEqual(self.client.get(f"/jobs/{job_id}/clips/1").content, b"clip")
        self.assertEqual(editor.job_source(UUID(job_id)).read_bytes(), b"video")
        self.download.assert_not_called()
        self.charge.assert_called_once_with("owner", 1)
        self.assertFalse(jobs.lock.locked())
        self.assertEqual(self.client.get(f"/editor/jobs/{job_id}/source").status_code, 403)
        self.user["plan"] = "pro"
        self.assertEqual(self.client.get(f"/editor/jobs/{job_id}/source").content, b"video")
        self.user["google_sub"] = "other"
        self.assertEqual(self.client.get(f"/jobs/{job_id}/clips/1").status_code, 404)

    def test_invalid_uploads_are_not_charged(self):
        cases = [(b"", None, 422), (b"x" * 101, None, 413),
                 (b"video", 74, 422), (b"video", 7201, 422),
                 (b"video", PipelineError("Missing video or audio"), 422)]
        for content, duration, status in cases:
            with self.subTest(duration=duration, size=len(content)):
                self.probe.side_effect = duration if isinstance(duration, Exception) else None
                self.probe.return_value = duration or 180
                self.assertEqual(self.upload(content).status_code, status)
                self.assertFalse(list(self.folder.iterdir()))
                self.assertFalse(jobs.lock.locked())
        self.charge.assert_not_called()

    def test_streaming_size_limit_without_content_length(self):
        response = self.upload(iter([b"x" * 60, b"x" * 60]))
        self.assertEqual(response.status_code, 413)
        self.charge.assert_not_called()
        self.assertFalse(list(self.folder.iterdir()))
        self.assertFalse(jobs.lock.locked())

    def test_youtube_job_remains_compatible(self):
        def download(url, folder, max_seconds):
            source = folder / "source.mp4"
            source.write_bytes(b"youtube")
            return source, folder / "source.en.json3"
        self.download.side_effect = download
        with patch("backend.services.youtube.transcript", return_value="[0-180] Speech"):
            response = self.client.post("/jobs", json={
                "youtube_url": "https://youtu.be/dQw4w9WgXcQ", "clip_count": 1,
            })
        self.assertEqual(response.status_code, 202, response.text)
        state = jobs.read(response.json()["id"])
        self.assertEqual((state["status"], state["source_type"]), ("completed", "youtube"))
        self.download.assert_called_once()
        self.assertFalse(jobs.lock.locked())

    def test_dependency_and_model_checks_precede_upload(self):
        with patch("backend.main.shutil.which", return_value=None):
            self.assertEqual(self.upload().status_code, 503)
        self.assertEqual(self.client.post("/jobs/upload?model=unknown", content=b"v").status_code, 422)
        self.assertEqual(self.client.post("/jobs/upload?model=gemini-quality", content=b"v").status_code, 403)
        self.assertEqual(self.upload(headers={"Content-Length": "invalid"}).status_code, 400)
        self.charge.assert_not_called()
        self.assertFalse(list(self.folder.iterdir()))

    def test_preflight_rejections(self):
        with patch.object(settings, "gemini_api_key", SecretStr("")):
            self.assertEqual(self.upload().status_code, 503)
        self.assertEqual(self.client.post("/jobs/upload?clip_count=2", content=b"v").status_code, 422)
        self.assertEqual(self.client.post("/jobs/upload?clip_count=5", content=b"v").status_code, 403)
        self.user["credits"] = 0
        self.assertEqual(self.upload().status_code, 402)
        self.user["credits"] = 100
        jobs.lock.acquire()
        try:
            self.assertEqual(self.upload().status_code, 409)
        finally:
            jobs.lock.release()
        self.user["subscription_status"] = "inactive"
        self.assertEqual(self.upload().status_code, 403)
        app.dependency_overrides.clear()
        self.assertEqual(self.upload().status_code, 401)
        self.charge.assert_not_called()

    def test_processing_failure_refunds(self):
        with patch("backend.services.gemini.transcribe", side_effect=PipelineError("Transcription failed")):
            response = self.upload()
        self.assertEqual(response.status_code, 202)
        self.assertEqual(jobs.read(response.json()["id"])["status"], "failed")
        self.refund.assert_called_once_with("owner", 1, f"job:{response.json()['id']}:refund")
        self.assertFalse(jobs.lock.locked())

    def test_disconnect_cleans_up(self):
        async def stream():
            yield b"partial video"
            raise ClientDisconnect()
        request = SimpleNamespace(headers={}, stream=stream)
        with self.assertRaises(ClientDisconnect):
            asyncio.run(upload_job(request, BackgroundTasks(), JobOptions(clip_count=1), self.user))
        self.charge.assert_not_called()
        self.assertFalse(list(self.folder.iterdir()))
        self.assertFalse(jobs.lock.locked())

    def test_restart_cleans_partial_upload_and_preserves_completed(self):
        state = jobs.create("", clip_count=1, owner_id="owner", source_type="upload")
        partial = self.folder / state["id"] / "source.partial"
        partial.write_bytes(b"incomplete")
        completed = self.upload().json()["id"]
        jobs.recover()
        self.assertFalse(partial.exists())
        self.assertEqual(jobs.read(state["id"])["status"], "failed")
        self.assertEqual(jobs.read(completed)["status"], "completed")
        self.assertTrue((self.folder / completed / "clip-1.mp4").is_file())
