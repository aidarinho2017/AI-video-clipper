import base64
import binascii
import gzip
import json
import logging
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from ..config import settings
from ..models import PipelineError


def canonical_url(value: str) -> str:
    try:
        url = urlsplit(value.strip())
        if url.scheme not in {"http", "https"} or url.username or url.password or url.port:
            raise ValueError()
        query = parse_qs(url.query)
        if "list" in query:
            raise ValueError()
        parts = url.path.strip("/").split("/")
        if url.hostname == "youtu.be" and len(parts) == 1:
            video_id = parts[0]
        elif url.hostname in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
            if url.path == "/watch":
                video_id = query.get("v", [""])[0]
            elif len(parts) == 2 and parts[0] in {"shorts", "embed", "live"}:
                video_id = parts[1]
            else:
                raise ValueError()
        else:
            raise ValueError()
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise ValueError()
        return f"https://www.youtube.com/watch?v={video_id}"
    except ValueError as exc:
        raise PipelineError("Enter a YouTube video URL, without a playlist.") from exc


def _caption(info: dict) -> tuple[str, bool] | None:
    preferred = info.get("language") or ""
    for automatic, tracks in ((False, info.get("subtitles") or {}), (True, info.get("automatic_captions") or {})):
        if not tracks:
            continue
        choices = [key for key in tracks if key != "live_chat"]
        if not choices:
            continue
        language = next((key for key in choices if key == preferred), None)
        language = language or next((key for key in choices if preferred and key.split("-")[0] == preferred.split("-")[0]), None)
        language = language or next((key for key in choices if key.endswith("-orig")), choices[0])
        return language, automatic
    return None


def transcript(path: Path) -> str:
    try:
        events = json.loads(path.read_text(encoding="utf-8"))["events"]
        lines = []
        for event in events:
            text = "".join(segment.get("utf8", "") for segment in event.get("segs", [])).replace("\n", " ").strip()
            if not text:
                continue
            start = event["tStartMs"] / 1000
            end = (event["tStartMs"] + event.get("dDurationMs", 0)) / 1000
            if end > start:
                lines.append(f"[{start:.2f}-{end:.2f}] {text}")
        if lines:
            return "\n".join(lines)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    raise PipelineError("YouTube captions could not be read. Try another video.")


def _cookie_args(folder: Path) -> list[str]:
    encoded = settings.youtube_cookies_gzip_base64.get_secret_value()
    if not encoded:
        return []
    try:
        cookies = gzip.decompress(base64.b64decode(encoded, validate=True))
    except (binascii.Error, ValueError, OSError, EOFError) as exc:
        raise PipelineError("YOUTUBE_COOKIES_GZIP_BASE64 is invalid. Compress and encode the cookie file again.") from exc
    cookie_file = folder / "youtube-cookies.txt"
    cookie_file.write_bytes(cookies)
    cookie_file.chmod(0o600)
    return ["--cookies", str(cookie_file)]


def download(url: str, folder: Path, max_seconds: int) -> tuple[Path, Path | None]:
    base = [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist", "--no-warnings", "--js-runtimes", "node", "--socket-timeout", "30", "--retries", "2", *_cookie_args(folder)]
    try:
        metadata = subprocess.run(base + ["--dump-single-json", "--skip-download", url], capture_output=True, text=True, check=True, timeout=120)
        info = json.loads(metadata.stdout)
        if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming", "post_live"}:
            raise PipelineError("Live streams are not supported. Choose a finished recording.")
        duration = info.get("duration")
        if not duration or not 75 <= duration <= max_seconds:
            raise PipelineError(f"Choose a video between 75 seconds and {max_seconds // 60} minutes.")
        caption = _caption(info)
        caption_args = []
        if caption:
            language, automatic = caption
            caption_args = ["--write-auto-subs" if automatic else "--write-subs", "--sub-langs", language, "--sub-format", "json3"]
        subprocess.run(base + caption_args + ["-f", "bv*[height<=1080]+ba/b[height<=1080]", "--merge-output-format", "mp4",
                              "-o", str(folder / "source.%(ext)s"), url], capture_output=True, text=True, check=True, timeout=1800)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        error = str(getattr(exc, "stderr", "") or exc)
        logging.getLogger(__name__).error("yt-dlp failure: %s", error[-4000:])
        if "Sign in to confirm you’re not a bot" in error or "Sign in to confirm you're not a bot" in error:
            raise PipelineError("YouTube blocked this server. Ask the administrator to refresh YOUTUBE_COOKIES_GZIP_BASE64.") from exc
        raise PipelineError("YouTube download failed. The video may be private, unavailable, or blocked by YouTube. Try another video or update yt-dlp.") from exc
    sources = [p for p in folder.glob("source.*") if p.suffix in {".mp4", ".mkv", ".webm"}]
    if len(sources) != 1:
        raise PipelineError("Download did not produce a usable video file.")
    captions = list(folder.glob("source.*.json3"))
    return sources[0], captions[0] if captions else None
