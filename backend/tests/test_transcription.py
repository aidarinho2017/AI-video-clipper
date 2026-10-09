import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
from pydantic import SecretStr

from backend.config import settings
from backend.models import ClipCandidate, PipelineError, TranscriptWord
from backend.services import transcription, video, youtube
from backend.tests.test_pipeline import candidate


class TranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.audio = Path(self.temp.name) / "audio.m4a"
        self.audio.write_bytes(b"audio")

    def response(self, words=None):
        return {"results": {"channels": [{"alternatives": [{"words": words if words is not None else [
            {"start": 0, "end": .5, "word": "hello", "punctuated_word": "Hello,"},
            {"start": 1, "end": 2, "word": "привет", "punctuated_word": "привет!"},
        ]}]}], "utterances": [{"start": 0, "end": 2, "transcript": "Hello, привет!"}]}}

    def deepgram(self, payload=None, status=200, error=None):
        client = MagicMock()
        client.post.return_value = httpx.Response(status, content=json.dumps(payload or self.response()))
        client.post.side_effect = error
        with patch("backend.services.transcription.httpx.Client") as factory:
            factory.return_value.__enter__.return_value = client
            result = transcription.deepgram(self.audio, 180)
            call = client.post.call_args
            self.assertEqual(call.kwargs["params"]["language"], "multi")
            self.assertNotIsInstance(call.kwargs["content"], bytes)
            return result

    def test_deepgram_words_and_punctuation(self):
        result = self.deepgram()
        self.assertEqual(result.provider, "deepgram")
        self.assertEqual([word.text for word in result.words], ["Hello,", "привет!"])
        self.assertEqual(result.timed_text(), "[0.00-2.00] Hello, привет!")

    def test_streams_audio_once_with_bounded_timeout(self):
        client = MagicMock()
        def post(*args, **kwargs):
            self.assertEqual(b"".join(kwargs["content"]), b"audio")
            return httpx.Response(200, json=self.response())
        client.post.side_effect = post
        with patch("backend.services.transcription.httpx.Client") as factory:
            factory.return_value.__enter__.return_value = client
            transcription.deepgram(self.audio, 180)
            self.assertEqual(factory.call_args.kwargs["timeout"].read, 660)
            client.post.assert_called_once()

    def test_bad_responses_and_timings(self):
        for payload in ({"results": {}}, self.response([]), self.response([
            {"start": 2, "end": 1, "word": "bad"}]), self.response([
            {"start": 0, "end": float("nan"), "word": "bad"}]), self.response([
            {"start": 0, "end": 181, "word": "bad"}]), self.response([
            {"start": 0, "end": 2, "word": "one"}, {"start": 1, "end": 3, "word": "two"}])):
            with self.subTest(payload=payload), self.assertRaises(PipelineError):
                self.deepgram(payload)
        for status in (401, 429, 500):
            with self.subTest(status=status), self.assertRaises(PipelineError):
                self.deepgram(status=status)
        with self.assertRaises(PipelineError):
            self.deepgram(error=httpx.ReadTimeout("private provider detail"))

    def test_fallback_and_missing_keys(self):
        with patch.object(settings, "deepgram_api_key", SecretStr("test")), \
             patch.object(settings, "gemini_api_key", SecretStr("test")), \
             patch.object(transcription, "deepgram", side_effect=PipelineError("Unavailable")) as deepgram, \
             patch.object(transcription.gemini, "transcribe", return_value="[0-2] Hello") as gemini:
            result = transcription.transcribe(self.audio, 180)
            self.assertEqual((result.provider, result.words), ("gemini", []))
            deepgram.assert_called_once()
            gemini.assert_called_once()
        with patch.object(settings, "deepgram_api_key", SecretStr("")), \
             patch.object(settings, "gemini_api_key", SecretStr("")), self.assertRaises(PipelineError):
            transcription.transcribe(self.audio, 180)

    def test_no_fallback_without_gemini_and_both_providers_fail(self):
        with patch.object(settings, "deepgram_api_key", SecretStr("test")), \
             patch.object(settings, "gemini_api_key", SecretStr("")), \
             patch.object(transcription, "deepgram", side_effect=PipelineError("Unavailable")), \
             patch.object(transcription.gemini, "transcribe") as gemini:
            with self.assertRaises(PipelineError):
                transcription.transcribe(self.audio, 180)
            gemini.assert_not_called()
        with patch.object(settings, "deepgram_api_key", SecretStr("test")), \
             patch.object(settings, "gemini_api_key", SecretStr("test")), \
             patch.object(transcription, "deepgram", side_effect=PipelineError("Unavailable")), \
             patch.object(transcription.gemini, "transcribe", side_effect=PipelineError("Fallback failed")):
            with self.assertRaisesRegex(PipelineError, "Fallback failed"):
                transcription.transcribe(self.audio, 180)

    def test_youtube_requires_word_ends_not_just_offsets(self):
        captions = self.audio.with_suffix(".json3")
        payload = {"events": [{"tStartMs": 0, "dDurationMs": 2000, "segs": [
            {"utf8": "Hello", "tOffsetMs": 0, "dDurationMs": 500},
            {"utf8": "привет!", "tOffsetMs": 1000, "dDurationMs": 1000}]}]}
        captions.write_text(json.dumps(payload))
        self.assertEqual(len(youtube.timed_words(captions, 180)), 2)
        del payload["events"][0]["segs"][0]["dDurationMs"]
        captions.write_text(json.dumps(payload))
        self.assertEqual(youtube.timed_words(captions, 180), [])

    def test_youtube_missing_malformed_and_overlapping_word_timings(self):
        captions = self.audio.with_suffix(".json3")
        self.assertEqual(youtube.timed_words(captions, 180), [])
        for payload in ("not json", json.dumps({"events": [{"tStartMs": 0, "dDurationMs": 2000, "segs": [
                {"utf8": "one", "tOffsetMs": 0, "dDurationMs": 1500},
                {"utf8": "two", "tOffsetMs": 1000, "dDurationMs": 500}]}]})):
            captions.write_text(payload)
            self.assertEqual(youtube.timed_words(captions, 180), [])

    def test_highlight_clamped_words_and_silence(self):
        clip = ClipCandidate.model_validate({**candidate(1), "end": 21})
        words = [TranscriptWord(start=.5, end=1.5, text="Hello,"),
                 TranscriptWord(start=1.8, end=2.5, text="привет!"),
                 TranscriptWord(start=20.5, end=22., text="End")]
        cues = video._word_caption_cues(words, clip)
        self.assertEqual(cues[0][:2], (0, .5))
        self.assertIn("{\\1c&H00FFFF&}Hello,", cues[0][2])
        self.assertNotIn("{\\1c", cues[1][2])
        self.assertIn("{\\1c&H00FFFF&}привет!", cues[2][2])
        self.assertEqual(cues[-1][1], 20)

    def test_single_line_and_escaped_control_characters(self):
        clip = ClipCandidate.model_validate(candidate())
        words = [TranscriptWord(start=float(index), end=index + .5, text=text)
                 for index, text in enumerate(["a" * 20, "b" * 20, "c" * 10, "{\\test}", "русский"])]
        cues = video._word_caption_cues(words, clip)
        self.assertTrue(all("\\N" not in text and "\n" not in text for _, _, text in cues))
        self.assertTrue(all(end <= following[0] for (_, end, _), following in zip(cues, cues[1:])))
        self.assertTrue(any("\\{\\\\test\\}" in text for _, _, text in cues))
        self.assertTrue(any("русский" in text for _, _, text in cues))
        path = self.audio.with_suffix(".ass")
        video._write_generated_captions(path, "", clip, words)
        self.assertIn("{\\1c&H00FFFF&}", path.read_text())
        self.assertIn("WrapStyle: 2", path.read_text())

    def test_overlapping_youtube_captions_are_single_line(self):
        clip = ClipCandidate.model_validate({**candidate(0), "end": 15})
        cues = video._caption_cues(
            "[0.00-4.52] You would only be as successful as\n"
            "[2.16-6.52] you're willing to become a person It is\n"
            "[4.52-8.00] genuinely the truth. I'm not even trying\n"
            "[6.52-9.32] to rage bait, not trying to clickbait.\n"
            "[8.00-11.96] This is one of the biggest lessons I've", clip)
        self.assertTrue(all(end <= following[0] for (_, end, _), following in zip(cues, cues[1:])))
        self.assertEqual(sum(start <= 7 < end for start, end, _ in cues), 1)
        self.assertTrue(all("\\N" not in text and video._caption_width(text) <= 580
                            for _, _, text in cues))

    def test_single_cues_duplicates_rounding_gaps_and_bounds(self):
        cues = video._single_caption_cues([
            (2, 3, "later"), (0, 5, "old"), (0, 1, "replacement"),
            (3, 3.004, "too short"), (4, 4.005, "rounded"),
        ])
        self.assertEqual(cues, [(0, 1, "replacement"), (2, 3, "later")])
        clip = ClipCandidate.model_validate({**candidate(10), "end": 25})
        cues = video._caption_cues("[8-12] Before inside\n[24-30] До после", clip)
        self.assertEqual(cues, [(0, 2, "Before inside"), (14, 15, "До после")])

    def test_single_line_phrase_timing_and_long_word_scaling(self):
        clip = ClipCandidate.model_validate({**candidate(0), "end": 15})
        cues = video._caption_cues("[0-9] alpha beta gamma delta epsilon zeta", clip)
        self.assertEqual([text for _, _, text in cues], ["alpha beta gamma", "delta epsilon zeta"])
        self.assertEqual([cue[:2] for cue in cues], [(0, 4.5), (4.5, 9)])
        for words in (None, [TranscriptWord(start=0, end=5, text="Ж" * 50)]):
            path = self.audio.with_suffix(".ass")
            video._write_generated_captions(path, "[0-5] " + "Ж" * 50, clip, words)
            content = path.read_text()
            self.assertIn("{\\fscx26}", content)
            self.assertNotIn("\\N", content)
            self.assertIn("Ж" * 50, content)
