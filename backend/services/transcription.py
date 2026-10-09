import logging
from pathlib import Path

import httpx
from pydantic import ValidationError

from ..config import settings
from ..models import PipelineError, TimedTranscript, TranscriptSegment, TranscriptWord
from . import gemini, video

log = logging.getLogger(__name__)


def from_text(text: str, duration: float, provider: str) -> TimedTranscript:
    segments = []
    for line in text.splitlines():
        match = video.TIMED_LINE.match(line.strip())
        if match:
            segment = TranscriptSegment(start=float(match[1]), end=float(match[2]), text=match[3])
            if segment.end <= duration:
                segments.append(segment)
    if not segments:
        raise PipelineError("No usable speech transcript was returned.")
    return TimedTranscript(provider=provider, segments=segments)


def deepgram(audio: Path, duration: float) -> TimedTranscript:
    try:
        with httpx.Client(timeout=httpx.Timeout(660, connect=15, write=120, pool=15)) as client, audio.open("rb") as source:
            response = client.post(
                "https://api.deepgram.com/v1/listen",
                params={"model": "nova-3", "language": "multi", "punctuate": "true", "utterances": "true"},
                headers={"Authorization": f"Token {settings.deepgram_api_key.get_secret_value()}",
                         "Content-Type": "audio/mp4"},
                content=iter(lambda: source.read(64 * 1024), b""),
            )
        if response.status_code != 200:
            raise PipelineError(f"Deepgram transcription failed (HTTP {response.status_code}). Check its key, quota or availability.")
        result = response.json()["results"]
        words = [TranscriptWord(start=float(word["start"]), end=float(word["end"]),
                                text=word.get("punctuated_word") or word["word"])
                 for word in result["channels"][0]["alternatives"][0]["words"]]
        if not words:
            raise PipelineError("Deepgram did not detect usable speech.")
        previous_end = 0.0
        for word in words:
            if word.start < previous_end or word.end > duration:
                raise PipelineError("Deepgram returned invalid word timings.")
            previous_end = word.end
        segments = [TranscriptSegment(start=float(item["start"]), end=float(item["end"]), text=item["transcript"])
                    for item in result.get("utterances", [])]
        if not segments or any(segment.end > duration for segment in segments):
            raise PipelineError("Deepgram returned an unusable transcript.")
        return TimedTranscript(provider="deepgram", segments=segments, words=words)
    except httpx.HTTPError as exc:
        raise PipelineError("Deepgram connection failed or timed out.") from exc
    except (ValueError, KeyError, TypeError, IndexError, ValidationError) as exc:
        raise PipelineError("Deepgram returned a malformed transcript.") from exc


def transcribe(audio: Path, duration: float) -> TimedTranscript:
    if settings.deepgram_api_key.get_secret_value():
        try:
            return deepgram(audio, duration)
        except PipelineError as exc:
            if not settings.gemini_api_key.get_secret_value():
                raise
            log.warning("%s Trying Gemini transcription fallback.", exc)
    if settings.gemini_api_key.get_secret_value():
        return from_text(gemini.transcribe(audio, duration), duration, "gemini")
    raise PipelineError("Add DEEPGRAM_API_KEY or GEMINI_API_KEY to transcribe videos without usable captions.")
