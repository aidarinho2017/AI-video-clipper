import base64
import gzip
import json
import os
import signal
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np
from fastapi.testclient import TestClient
from pydantic import SecretStr

from backend import auth, billing
from backend.config import settings
from backend.main import app
from backend.models import ClipCandidate, EditorExportRequest, JobRequest, PipelineError
from backend.services import analysis, jobs, video, youtube
from backend.services.clip_selector import select
from backend.services.youtube import canonical_url, transcript
from backend.services.gemini import transcribe
from google.genai import errors

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
requires_postgres = unittest.skipUnless(TEST_DATABASE_URL, "Set TEST_DATABASE_URL to a disposable PostgreSQL database")


def reset_database():
    with patch.object(settings, "database_url", SecretStr(TEST_DATABASE_URL)):
        auth.init()
        try:
            with auth._connect() as db:
                db.execute("TRUNCATE promo_redemptions, promo_codes, credit_adjustments, billing_events, users")
        finally:
            auth.close()


def candidate(start=0, score=80, **changes):
    return dict(start=start, end=start + 20, title="A complete thought", reasoning="A useful insight with context",
                hook_score=80, emotion_score=70, standalone_score=90, insight_score=85,
                virality_score=score, **changes)


class PipelineTests(unittest.TestCase):
    def login(self, client, sub="google-user", subscribed=True):
        claims = {"sub": sub, "email": f"{sub}@example.com", "email_verified": True, "name": "Test User"}
        with patch("backend.auth.verify_google", return_value=claims):
            response = client.post("/auth/google", json={"credential": "x" * 100})
        self.assertEqual(response.status_code, 200)
        self.last_access_token = response.json()["access_token"]
        if subscribed:
            with auth._connect() as db:
                db.execute("""UPDATE users SET plan='studio', subscription_status='active', credits=2000
                            WHERE google_sub = %s""", (sub,))
        return client.get("/auth/me").json()

    def test_urls(self):
        for url in ("https://youtu.be/dQw4w9WgXcQ?t=10", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ"):
            self.assertEqual(canonical_url(url), "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        for url in ("file:///etc/passwd", "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ", "https://youtube.com@localhost/watch?v=dQw4w9WgXcQ", "https://youtube.com/watch?v=short", "https://youtu.be/dQw4w9WgXcQ?list=123", "https://youtube.com:9000/watch?v=dQw4w9WgXcQ"):
            with self.subTest(url=url), self.assertRaises(PipelineError):
                canonical_url(url)

    @requires_postgres
    def test_postgres_schema_init_is_idempotent(self):
        reset_database()
        with patch.object(settings, "database_url", SecretStr(TEST_DATABASE_URL)):
            auth.init()
            try:
                auth.upsert_user({"sub": "old", "email": "old@example.com", "name": "Old"})
                with auth._connect() as db:
                    db.execute("UPDATE users SET credits = 7 WHERE google_sub = 'old'")
                auth.init()
                with auth._connect() as db:
                    self.assertEqual(db.execute(
                        "SELECT credits FROM users WHERE google_sub = 'old'").fetchone()["credits"], 7)
            finally:
                auth.close()

    def test_validation_and_ranking(self):
        candidates = [candidate(i * 30, 80 + i) for i in range(6)]
        candidates.extend([{**candidate(), **change} for change in (
            {"start": -1}, {"end": 14}, {"end": 31}, {"end": 0}, {"start": float("nan")},
            {"end": float("inf")}, {"hook_score": 101}, {"hook_score": -1}, {"hook_score": True},
            {"hook_score": "80"}, {"title": " "}, {"reasoning": ""}, {"start": 999, "end": 1019},
        )])
        candidates.append({"start": 0})
        result = select(candidates, 180)
        self.assertEqual([c.start for c in result], [150, 120, 90, 60, 30])
        self.assertEqual(len(select([candidate(), candidate(1), candidate(20)], 60)), 2)
        self.assertEqual([c.start for c in select([candidate(30), candidate(0)], 60)], [0, 30])
        self.assertEqual(select([candidate(0)], 19), [])
        medium = [{**candidate(0), "end": 40}, {**candidate(45), "end": 90}]
        self.assertEqual(len(select(medium, 100, 30, 60, 1)), 1)
        self.assertEqual(JobRequest(youtube_url="https://youtu.be/dQw4w9WgXcQ").clip_count, 5)
        with self.assertRaises(ValueError):
            JobRequest(youtube_url="https://youtu.be/dQw4w9WgXcQ", clip_count=2)
        paid = {"plan": "studio", "subscription_status": "active", "current_period_end": 500,
                "cancel_at_period_end": False, "grant_plan": "starter", "grant_until": 200,
                "grant_source": "promo:TEST"}
        self.assertEqual(billing.effective_subscription(paid, now=100)["plan"], "starter")
        self.assertEqual(billing.effective_subscription(paid, now=300)["plan"], "studio")

    @requires_postgres
    def test_job_api_lifecycle(self):
        reset_database()
        with tempfile.TemporaryDirectory() as temp, patch.object(settings, "data_dir", Path(temp)), patch.object(
                settings, "gemini_api_key", SecretStr("test")), patch.object(
                settings, "auth_secret", SecretStr("test-secret-that-is-at-least-32-characters")), patch.object(
                settings, "database_url", SecretStr(TEST_DATABASE_URL)):
            selected = select([candidate(i * 30) for i in range(5)], 180)
            def fake_render(source, target, clip, transcript):
                target.write_bytes(b"0123456789")
            with TestClient(app) as client:
                self.assertEqual(client.get("/health").json(), {"status": "ok"})
                self.assertEqual(client.get("/auth/me").status_code, 401)
                self.assertEqual(self.login(client)["credits"], 2000)
                client.cookies.clear()
                client.headers["Authorization"] = f"Bearer {self.last_access_token}"
                self.assertEqual(client.get("/auth/me").status_code, 200)
                catalog = client.get("/ai/models").json()
                self.assertEqual(catalog["default_model"], "gemini-fast")
                self.assertEqual(len(catalog["models"]), 6)
                self.assertTrue(catalog["models"][0]["configured"])
                cors = client.options("/jobs", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
                self.assertEqual(cors.headers["access-control-allow-origin"], "http://localhost:3000")
                self.assertIn("Authorization", cors.headers["access-control-allow-headers"])
                self.assertEqual(client.post("/jobs", json={"youtube_url": "https://evil.test"}).status_code, 422)
                with patch.object(settings, "gemini_api_key", SecretStr("")):
                    self.assertEqual(client.post("/jobs", json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ"}).status_code, 503)
                self.assertEqual(client.post("/jobs", json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ", "model": "unknown"}).status_code, 422)
                self.assertEqual(client.post("/jobs", json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ", "model": "agentrouter:deepseek-v4-flash"}).status_code, 422)
                self.assertEqual(client.post("/jobs", json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ", "model": "openai-fast"}).status_code, 503)
                jobs.lock.acquire()
                try:
                    self.assertEqual(client.post("/jobs", json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ"}).status_code, 409)
                finally:
                    jobs.lock.release()
                with patch("backend.services.youtube.download", return_value=(Path(temp) / "source.mp4", Path(temp) / "source.en.json3")), patch("backend.services.youtube.transcript", return_value="[0-180] transcript"), patch("backend.services.video.probe", return_value=180), patch("backend.services.analysis.analyze", return_value=(selected, [])), patch("backend.services.video.render", side_effect=fake_render):
                    response = client.post("/jobs", json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ"})
                self.assertEqual(response.status_code, 202)
                self.assertEqual(response.json()["credits"], 1995)
                job_id = response.json()["id"]
                state = client.get(f"/jobs/{job_id}").json()
                self.assertEqual(state["status"], "completed")
                self.assertEqual(state["completed_clips"], 5)
                self.assertEqual((state["clip_length"], state["clip_count"]), ("short", 5))
                response = client.get(f"/jobs/{job_id}/clips/1", headers={"Range": "bytes=0-3"})
                self.assertEqual(response.status_code, 206)
                self.assertEqual(response.content, b"0123")
                path = f"/jobs/{job_id}/clips/1"
                media = client.post("/auth/media-token", json={"path": path}).json()["token"]
                client.headers.pop("Authorization")
                self.assertEqual(client.get(f"{path}?media_token={media}").status_code, 200)
                self.assertEqual(client.get(
                    f"/jobs/{job_id}/clips/2?media_token={media}").status_code, 401)
                client.headers["Authorization"] = f"Bearer {self.last_access_token}"
                self.assertEqual(client.post(
                    "/auth/media-token", json={"path": "/billing/plans"}).status_code, 422)
                self.assertIn("attachment", client.get(f"/jobs/{job_id}/clips/1?download=true").headers["content-disposition"])
                self.assertEqual(client.get(f"/jobs/{job_id}/clips/6").status_code, 404)
                self.assertEqual(client.get("/jobs/00000000-0000-0000-0000-000000000000").status_code, 404)
                with patch("backend.services.youtube.download", side_effect=PipelineError("Video unavailable")):
                    failed = client.post("/jobs", json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ"}).json()
                state = jobs.read(failed["id"])
                self.assertEqual(state["status"], "failed")
                self.assertEqual(state["error"], "Video unavailable")
                self.assertEqual(client.get("/auth/me").json()["credits"], 1995)
                self.assertFalse(jobs.lock.locked())
                queued = jobs.create("unused")
                jobs.recover()
                self.assertEqual(jobs.read(queued["id"])["status"], "failed")

    @requires_postgres
    def test_paid_plans_and_idempotent_webhooks(self):
        reset_database()
        secret = SecretStr("test-secret-that-is-at-least-32-characters")
        with tempfile.TemporaryDirectory() as temp, patch.object(settings, "data_dir", Path(temp)), patch.object(
                settings, "auth_secret", secret), patch.object(
                settings, "gemini_api_key", SecretStr("test")), patch.object(
                settings, "stripe_secret_key", SecretStr("sk_test_fake")), patch.object(
                settings, "stripe_webhook_secret", SecretStr("whsec_fake")), patch.object(
                settings, "stripe_price_starter", "price_starter"), patch.object(
                settings, "stripe_price_pro", "price_pro"), patch.object(
                settings, "stripe_price_studio", "price_studio"), patch.object(
                settings, "database_url", SecretStr(TEST_DATABASE_URL)), TestClient(app) as client:
            user = self.login(client, subscribed=False)
            self.assertEqual((user["credits"], user["subscription_status"]), (0, "inactive"))
            self.assertEqual(client.post("/jobs", json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ"}).status_code, 403)
            with patch("backend.billing.stripe.Customer.create", return_value=SimpleNamespace(id="cus_test")), patch(
                    "backend.billing.stripe.checkout.Session.create",
                    return_value=SimpleNamespace(id="cs_test", url="https://checkout.test/session")):
                checkout = client.post("/billing/checkout", json={"plan": "starter"})
            self.assertEqual(checkout.json()["url"], "https://checkout.test/session")
            with patch("backend.billing.stripe.checkout.Session.retrieve",
                       return_value=SimpleNamespace(status="open", url="https://checkout.test/session")):
                duplicate = client.post("/billing/checkout", json={"plan": "starter"})
            self.assertEqual(duplicate.json()["url"], "https://checkout.test/session")
            paid = {
                "id": "evt_paid", "type": "invoice.paid", "livemode": False,
                "data": {"object": {"customer": "cus_test", "subscription": "sub_test",
                                     "lines": {"data": [{"price": {"id": "price_starter"}}]}}},
            }
            billing.handle_event(paid)
            user = client.get("/auth/me").json()
            self.assertEqual((user["plan"], user["credits"], user["subscription_status"]),
                             ("starter", 100, "active"))
            self.assertEqual(client.post("/billing/change-plan", json={"plan": "starter"}).status_code, 409)
            portal_session = SimpleNamespace(url="https://billing.test/change-plan")
            with patch("backend.billing.stripe.Subscription.retrieve", return_value={
                    "customer": "cus_test", "items": {"data": [{"id": "si_test"}]} }), patch(
                    "backend.billing.stripe.billing_portal.Session.create", return_value=portal_session) as create_portal:
                change = client.post("/billing/change-plan", json={"plan": "pro"})
            self.assertEqual(change.json()["url"], portal_session.url)
            flow = create_portal.call_args.kwargs["flow_data"]
            self.assertEqual(flow["subscription_update_confirm"]["items"], [
                {"id": "si_test", "price": "price_pro", "quantity": 1}])
            self.assertEqual(client.post("/jobs", json={"youtube_url": "https://youtu.be/dQw4w9WgXcQ",
                                                        "clip_count": 5}).status_code, 403)
            self.assertEqual(client.post("/editor/sources", content=b"video").status_code, 403)
            auth.charge("google-user", 1)
            billing.handle_event(paid)
            self.assertEqual(client.get("/auth/me").json()["credits"], 99)
            self.assertEqual(auth.refund_once("google-user", 2, "test-refund"), 2)
            self.assertEqual(auth.refund_once("google-user", 3, "test-refund"), 1)
            self.assertEqual(auth.refund_once("google-user", 2, "test-refund"), 0)
            self.assertEqual(client.get("/auth/me").json()["credits"], 102)
            failed = {"id": "evt_failed", "type": "invoice.payment_failed", "livemode": False,
                      "data": {"object": {"customer": "cus_test"}}}
            billing.handle_event(failed)
            self.assertEqual(client.get("/auth/me").json()["subscription_status"], "past_due")
            with patch("backend.billing.stripe.Webhook.construct_event", side_effect=ValueError):
                self.assertEqual(client.post("/billing/webhook", content=b"{}",
                                             headers={"Stripe-Signature": "bad"}).status_code, 400)

    @requires_postgres
    def test_admin_grants_and_promo_codes(self):
        reset_database()
        secret = SecretStr("test-secret-that-is-at-least-32-characters")
        with patch.object(settings, "auth_secret", secret), patch.object(
                settings, "admin_emails", "admin@example.com"), patch.object(
                settings, "database_url", SecretStr(TEST_DATABASE_URL)), TestClient(app) as client:
            admin = self.login(client, sub="admin", subscribed=False)
            self.assertTrue(admin["is_admin"])
            promo = client.post("/admin/promo-codes", json={
                "code": "creator30", "plan": "starter", "duration_days": 30,
                "max_redemptions": 1,
            })
            self.assertEqual(promo.status_code, 200)
            self.assertEqual(promo.json()["code"], "CREATOR30")

            paid = self.login(client, sub="paid-user")
            redeemed = client.post("/billing/promo-code", json={"code": "creator30"})
            self.assertEqual(redeemed.status_code, 200)
            self.assertEqual((redeemed.json()["plan"], redeemed.json()["subscription_source"]),
                             ("starter", "promo"))
            self.assertEqual(redeemed.json()["credits"], 2000)
            self.assertEqual(client.post("/billing/promo-code", json={"code": "creator30"}).status_code, 409)
            with auth._connect() as db:
                db.execute("UPDATE users SET grant_until = 1 WHERE google_sub = 'paid-user'")
            fallback = client.get("/auth/me").json()
            self.assertEqual((fallback["plan"], fallback["subscription_source"]), ("studio", "stripe"))

            self.login(client, sub="ordinary", subscribed=False)
            self.assertEqual(client.get("/admin/users").status_code, 403)
            self.assertEqual(client.post("/billing/promo-code", json={"code": "CREATOR30"}).status_code, 409)

            self.login(client, sub="admin", subscribed=False)
            granted = client.post("/admin/users/ordinary/grant",
                                  json={"plan": "pro", "duration_days": 7})
            self.assertEqual((granted.json()["plan"], granted.json()["credits"]), ("pro", 500))
            self.assertEqual(client.post("/admin/users/ordinary/revoke-grant").status_code, 200)
            codes = client.get("/admin/promo-codes").json()["promo_codes"]
            self.assertEqual(codes[0]["redemptions"], 1)
            disabled = client.post("/admin/promo-codes/CREATOR30/status", json={"active": False})
            self.assertFalse(disabled.json()["active"])

    @requires_postgres
    def test_editor_api_lifecycle(self):
        reset_database()
        metadata = {"kind": "video", "duration": 12.0, "width": 640, "height": 360, "has_audio": True}
        with tempfile.TemporaryDirectory() as temp, patch.object(settings, "data_dir", Path(temp)), patch.object(
                settings, "max_upload_bytes", 100), patch.object(
                settings, "auth_secret", SecretStr("test-secret-that-is-at-least-32-characters")), patch.object(
                settings, "database_url", SecretStr(TEST_DATABASE_URL)):
            def fake_render(sources, audio_sources, target, edit):
                target.write_bytes(b"edited")
            with patch("backend.services.video.probe_source", return_value=metadata), patch("backend.services.video.probe_media", return_value=metadata), patch("backend.services.video.render_edit", side_effect=fake_render), TestClient(app) as client:
                self.login(client)
                uploaded = client.post("/editor/sources", content=b"video", headers={"Content-Type": "video/mp4"})
                self.assertEqual(uploaded.status_code, 201)
                source_id = uploaded.json()["id"]
                self.assertEqual(client.get(f"/editor/sources/{source_id}").content, b"video")
                def fake_waveform(source, target):
                    target.write_bytes(b"png")
                with patch("backend.services.video.render_waveform", side_effect=fake_waveform):
                    self.assertEqual(client.get(f"/editor/sources/{source_id}/waveform").content, b"png")
                audio_metadata = {"kind": "audio", "duration": 8.0, "has_audio": True}
                def fake_normalize(source, target):
                    target.write_bytes(b"normalized")
                with patch("backend.services.video.probe_source", return_value=audio_metadata), patch("backend.services.video.normalize_audio", side_effect=fake_normalize):
                    audio_upload = client.post("/editor/sources", content=b"audio", headers={"Content-Type": "audio/wav"})
                self.assertEqual(audio_upload.status_code, 201)
                self.assertEqual(audio_upload.json()["kind"], "audio")
                self.assertEqual(client.get(f"/editor/sources/{audio_upload.json()['id']}").content, b"normalized")
                edit = {
                    "segments": [{"id": "00000000-0000-0000-0000-000000000001", "source": {"kind": "upload", "id": source_id}, "source_start": 1, "source_end": 4, "transform": {"scale": 1.2, "position_x": 0.2, "position_y": -0.1}}],
                    "aspect_ratio": "1:1",
                    "captions": [{"id": "00000000-0000-0000-0000-000000000002", "start": 0, "end": 1, "text": "Hello"}],
                }
                response = client.post("/editor/exports", json=edit)
                self.assertEqual(response.status_code, 202)
                export_id = response.json()["id"]
                self.assertEqual(client.get(f"/editor/exports/{export_id}").json()["status"], "completed")
                self.assertEqual(client.get(f"/editor/exports/{export_id}/video").content, b"edited")
                self.assertFalse(jobs.lock.locked())
                self.assertEqual(client.post("/editor/sources", content=b"x" * 101).status_code, 413)

    def test_editor_schema_rejects_invalid_timeline(self):
        base = {
            "segments": [{"id": "00000000-0000-0000-0000-000000000002", "source": {"kind": "upload", "id": "00000000-0000-0000-0000-000000000001"}, "source_start": 0, "source_end": 2}],
        }
        with self.assertRaisesRegex(ValueError, "at least 0.5"):
            EditorExportRequest.model_validate({**base, "segments": [{**base["segments"][0], "source_end": 0.1}]})
        with self.assertRaisesRegex(ValueError, "cannot overlap"):
            EditorExportRequest.model_validate({**base, "captions": [
                {"id": "00000000-0000-0000-0000-000000000003", "start": 0, "end": 1, "text": "One"},
                {"id": "00000000-0000-0000-0000-000000000004", "start": 0.5, "end": 1.5, "text": "Two"},
            ]})
        with self.assertRaisesRegex(ValueError, "less than or equal to 0.95"):
            EditorExportRequest.model_validate({**base, "captions": [
                {"id": "00000000-0000-0000-0000-000000000003", "start": 0, "end": 1, "text": "Outside", "position_x": 1},
            ]})
        second = {**base["segments"][0], "id": "00000000-0000-0000-0000-000000000003"}
        with self.assertRaisesRegex(ValueError, "first segment"):
            EditorExportRequest.model_validate({"segments": [{**base["segments"][0], "transition_duration": 0.5}, second]})
        with self.assertRaisesRegex(ValueError, "at least 0.1"):
            EditorExportRequest.model_validate({"segments": [base["segments"][0], {**second, "transition_duration": 0.05}]})
        with self.assertRaisesRegex(ValueError, "too long"):
            EditorExportRequest.model_validate({"segments": [base["segments"][0], {**second, "transition_duration": 1.5}]})
        audio_clip = {"id": "00000000-0000-0000-0000-000000000004", "source": base["segments"][0]["source"],
                      "timeline_start": 0, "source_start": 0, "source_end": 1}
        with self.assertRaisesRegex(ValueError, "cannot overlap"):
            EditorExportRequest.model_validate({**base, "audio_tracks": [{
                "id": "00000000-0000-0000-0000-000000000005", "name": "Music", "clips": [
                    audio_clip, {**audio_clip, "id": "00000000-0000-0000-0000-000000000006", "timeline_start": 0.5},
                ],
            }]})
        with self.assertRaisesRegex(ValueError, "fades cannot exceed"):
            EditorExportRequest.model_validate({**base, "audio_tracks": [{
                "id": "00000000-0000-0000-0000-000000000005", "name": "Music",
                "clips": [{**audio_clip, "audio": {"fade_in": 0.8, "fade_out": 0.8}}],
            }]})
        with self.assertRaisesRegex(ValueError, "after the video"):
            EditorExportRequest.model_validate({**base, "audio_tracks": [{
                "id": "00000000-0000-0000-0000-000000000005", "name": "Music",
                "clips": [{**audio_clip, "timeline_start": 3}],
            }]})

    def test_caption_json(self):
        self.assertEqual(youtube._caption({"language": "en", "subtitles": {"en": []},
                                           "automatic_captions": {"en": []}}), ("en", False))
        self.assertEqual(youtube._caption({"language": "es", "automatic_captions": {"es-orig": []}}),
                         ("es-orig", True))
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "captions.json3"
            path.write_text(json.dumps({"events": [
                {"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "Hello "}, {"utf8": "world"}]},
                {"tStartMs": 3000, "dDurationMs": 1000},
            ]}))
            self.assertEqual(transcript(path), "[1.00-3.00] Hello world")

    def test_youtube_cookie_secret_becomes_private_file(self):
        cookies = b"# Netscape Cookie File\n"
        with tempfile.TemporaryDirectory() as temp, patch.object(
            settings, "youtube_cookies_gzip_base64",
            SecretStr(base64.b64encode(gzip.compress(cookies)).decode()),
        ):
            args = youtube._cookie_args(Path(temp))
            cookie_file = Path(args[1])
            self.assertEqual(args[0], "--cookies")
            self.assertEqual(cookie_file.read_bytes(), cookies)
            self.assertEqual(cookie_file.stat().st_mode & 0o777, 0o600)

        with tempfile.TemporaryDirectory() as temp, patch.object(
            settings, "youtube_cookies_gzip_base64",
            SecretStr(base64.b64encode(b"not gzip").decode()),
        ), self.assertRaisesRegex(PipelineError, "YOUTUBE_COOKIES_GZIP_BASE64"):
            youtube._cookie_args(Path(temp))

    def test_youtube_subtitle_failure_retries_h264_without_captions(self):
        with tempfile.TemporaryDirectory() as temp:
            folder, calls = Path(temp), []

            def fake_run(args, **kwargs):
                calls.append(args)
                if "--dump-single-json" in args:
                    return SimpleNamespace(stdout=json.dumps({
                        "duration": 120, "automatic_captions": {"en": [{}]},
                    }))
                if "--write-auto-subs" in args:
                    (folder / "source.en.json3").write_text("partial")
                    raise subprocess.CalledProcessError(
                        1, args, stderr="Unable to download video subtitles for 'en': HTTP Error 429"
                    )
                (folder / "source.mp4").write_bytes(b"video")
                return SimpleNamespace(stdout="")

            with patch.object(youtube, "_cookie_args", return_value=[]), patch.object(
                youtube.subprocess, "run", side_effect=fake_run
            ):
                source, captions = youtube.download("https://youtu.be/dQw4w9WgXcQ", folder, 7200)

            self.assertEqual(source, folder / "source.mp4")
            self.assertIsNone(captions)
            self.assertIn(youtube.VIDEO_FORMAT, calls[1])
            self.assertNotIn("--write-auto-subs", calls[2])

    def test_low_memory_render_and_sigkill_error(self):
        clip = ClipCandidate.model_validate(candidate(10))
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "clip.mp4"

            def fake_run(args, timeout=1800):
                Path(args[-1]).write_bytes(b"video")
                return ""

            with patch.object(video, "_face_center", return_value=0.5), patch.object(
                video, "run", side_effect=fake_run
            ) as media_run:
                video.render(Path(temp) / "source.mp4", target, clip, "[10.00-20.00] Caption")
            args = media_run.call_args.args[0]
            self.assertIn("scale=720:1280:force_original_aspect_ratio=increase", args[args.index("-vf") + 1])
            self.assertEqual(args[args.index("-preset") + 1], "veryfast")
            self.assertEqual(args[args.index("-threads") + 1], "1")

        killed = subprocess.CalledProcessError(-signal.SIGKILL, ["ffmpeg"], stderr="")
        with patch.object(video.subprocess, "run", side_effect=killed), self.assertRaisesRegex(
            PipelineError, "memory limit"
        ):
            video.run(["ffmpeg"])

    def test_generated_caption_cues_and_face_fallback(self):
        clip = ClipCandidate.model_validate(candidate(10))
        cues = video._caption_cues(
            "[8.00-12.00] Before and inside\n[12.00-18.00] A useful phrase", clip)
        self.assertEqual(cues[0][:2], (0, 2))
        self.assertEqual(cues[-1][2], "A useful phrase")
        capture = MagicMock()
        capture.read.return_value = (False, None)
        detector = MagicMock()
        detector.empty.return_value = False
        with patch.object(video.cv2, "VideoCapture", return_value=capture), patch.object(
                video.cv2, "CascadeClassifier", return_value=detector):
            self.assertEqual(video._face_center(Path("missing.mp4"), clip), 0.5)
            capture.release.assert_called_once()
        capture = MagicMock()
        capture.read.return_value = (True, np.zeros((360, 1280, 3), dtype=np.uint8))
        detector = MagicMock()
        detector.empty.return_value = False
        detector.detectMultiScale.return_value = []
        with patch.object(video.cv2, "VideoCapture", return_value=capture), patch.object(
                video.cv2, "CascadeClassifier", return_value=detector):
            self.assertEqual(video._face_center(Path("wide.mp4"), clip), 0.5)

    def test_provider_response_shapes(self):
        self.assertEqual(analysis._parse('```json\n{"candidates": []}\n```'), {"candidates": []})
        with patch.object(settings, "anthropic_api_key", SecretStr("test")), patch.object(
                settings, "openai_api_key", SecretStr("test")), patch(
                "backend.services.analysis._http_json") as request:
            request.return_value = {"content": [{"type": "text", "text": "anthropic"}]}
            self.assertEqual(analysis._generate(analysis.MODELS["anthropic-fast"], "prompt"), "anthropic")
            request.return_value = {"choices": [{"message": {"content": "openai"}}]}
            self.assertEqual(analysis._generate(analysis.MODELS["openai-fast"], "prompt"), "openai")

    def test_analysis_retries(self):
        valid = json.dumps({"candidates": [candidate(i * 30) for i in range(5)]})
        with patch("backend.services.analysis._generate", side_effect=["bad json", valid]) as generate:
            selected, _ = analysis.analyze("[0-180] transcript", 180, lambda stage: None, "gemini-fast", "Prefer humor")
            self.assertEqual(len(selected), 5)
            self.assertEqual(generate.call_count, 2)
            self.assertIn("Prefer humor", generate.call_args.args[1])
        with patch("backend.services.analysis._generate", return_value='{"candidates": []}'):
            with self.assertRaisesRegex(PipelineError, "no valid"):
                analysis.analyze("transcript", 180, lambda stage: None, "gemini-fast")
        partial = json.dumps({"candidates": [candidate(0), candidate(30)]})
        with patch("backend.services.analysis._generate", return_value=partial):
            selected, _ = analysis.analyze(
                "transcript", 180, lambda stage: None, "gemini-fast", clip_count=3)
            self.assertEqual(len(selected), 2)

    def test_gemini_transcript_cleanup(self):
        client = MagicMock()
        client.files.upload.return_value = SimpleNamespace(name="files/test", state=SimpleNamespace(name="ACTIVE"))
        valid = json.dumps({"segments": [{"start": 0.0, "end": 5.0, "text": "Hello"}]})
        with patch("backend.services.gemini.genai.Client", return_value=client):
            client.models.generate_content.return_value = SimpleNamespace(text=valid)
            self.assertEqual(transcribe(Path("audio.m4a"), 180), "[0.00-5.00] Hello")
            client.files.delete.assert_called_once_with(name="files/test")
            client.close.assert_called_once()
            client.reset_mock()
            client.models.generate_content.side_effect = errors.APIError(429, {"error": {"message": "Quota exceeded", "status": "RESOURCE_EXHAUSTED"}})
            with self.assertRaisesRegex(PipelineError, "quota or rate limit"):
                transcribe(Path("audio.m4a"), 180)
            client.files.delete.assert_called_once()
            client.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
