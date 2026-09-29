import json
import logging
import math
import subprocess
from pathlib import Path

from ..models import ClipCandidate, EditorExportRequest, PipelineError, VideoSegment

log = logging.getLogger(__name__)


def run(args: list[str], timeout: int = 1800) -> str:
    try:
        return subprocess.run(args, capture_output=True, text=True, check=True, timeout=timeout).stdout
    except FileNotFoundError as exc:
        raise PipelineError(f"Missing dependency: {args[0]}. Install it and restart the backend.") from exc
    except subprocess.TimeoutExpired as exc:
        raise PipelineError("Video processing timed out. Try a shorter source.") from exc
    except subprocess.CalledProcessError as exc:
        log.error("Media command failed: %s", exc.stderr[-4000:])
        raise PipelineError("Video processing failed. Check that the source contains playable video and audio.") from exc


def probe_media(path: Path) -> dict:
    info = json.loads(run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)], 30))
    streams = info.get("streams", [])
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    duration = float(info["format"]["duration"])
    if not video_stream or not math.isfinite(duration) or duration <= 0:
        raise PipelineError("The source must contain playable video with a valid duration.")
    width, height = int(video_stream.get("width", 0)), int(video_stream.get("height", 0))
    if width <= 0 or height <= 0:
        raise PipelineError("Could not determine the source video dimensions.")
    return {"duration": duration, "width": width, "height": height,
            "has_audio": any(stream.get("codec_type") == "audio" for stream in streams)}


def probe(path: Path) -> float:
    metadata = probe_media(path)
    if not metadata["has_audio"]:
        raise PipelineError("The source must contain both video and audio with a valid duration.")
    return metadata["duration"]


def extract_audio(source: Path, target: Path):
    run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", str(target)])


def render(source: Path, target: Path, clip: ClipCandidate):
    temporary = target.with_suffix(".partial.mp4")
    run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-ss", str(clip.start), "-i", str(source),
         "-t", str(clip.end - clip.start), "-map", "0:v:0", "-map", "0:a:0",
         "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
         "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(temporary)])
    temporary.replace(target)


RESOLUTIONS = {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (720, 720)}


def _ass_time(seconds: float) -> str:
    centiseconds = round(seconds * 100)
    hours, remainder = divmod(centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    whole_seconds, fraction = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{fraction:02d}"


def _write_captions(path: Path, edit: EditorExportRequest, width: int, height: int):
    preset = edit.caption_style.preset
    primary = "&H0000FFFF" if preset == "yellow" else "&H00FFFFFF"
    border_style, outline, background = ("3", "0", "&H90000000") if preset == "box" else ("1", "3", "&H00000000")
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Liberation Sans,{edit.caption_style.font_size},{primary},&H00FFFFFF,&H00000000,{background},-1,0,0,0,100,100,0,0,{border_style},{outline},0,5,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for caption in edit.captions:
        text = caption.text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")
        x, y = round(width * caption.position_x), round(height * caption.position_y)
        lines.append(f"Dialogue: 0,{_ass_time(caption.start)},{_ass_time(caption.end)},Default,,0,0,0,,{{\\pos({x},{y})}}{text}")
    path.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")


def render_edit(sources: list[tuple[Path, VideoSegment]], target: Path, edit: EditorExportRequest):
    width, height = RESOLUTIONS[edit.aspect_ratio]
    filters = []
    metadata = [probe_media(path) for path, _ in sources]
    has_audio = any(value["has_audio"] for value in metadata)
    for index, ((_, segment), source_metadata) in enumerate(zip(sources, metadata)):
        start, end = segment.source_start, segment.source_end
        scale = segment.transform.scale
        scale_filter = (f"scale=w='ceil(iw*max({width}/iw\\,{height}/ih)*{scale}/2)*2':"
                        f"h='ceil(ih*max({width}/iw\\,{height}/ih)*{scale}/2)*2'")
        crop = (f"crop={width}:{height}:(in_w-out_w)*({segment.transform.position_x}+1)/2:"
                f"(in_h-out_h)*({segment.transform.position_y}+1)/2,setsar=1")
        filters.append(f"[{index}:v]trim=start={start}:end={end},setpts=PTS-STARTPTS,{scale_filter},{crop},fps=30,format=yuv420p[v{index}]")
        if has_audio:
            if source_metadata["has_audio"]:
                filters.append(f"[{index}:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}]")
            else:
                filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={end - start},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}]")

    if len(edit.segments) == 1:
        video_label, audio_label = "v0", "a0"
    elif has_audio:
        inputs = "".join(f"[v{i}][a{i}]" for i in range(len(edit.segments)))
        filters.append(f"{inputs}concat=n={len(edit.segments)}:v=1:a=1[vcat][acat]")
        video_label, audio_label = "vcat", "acat"
    else:
        inputs = "".join(f"[v{i}]" for i in range(len(edit.segments)))
        filters.append(f"{inputs}concat=n={len(edit.segments)}:v=1:a=0[vcat]")
        video_label, audio_label = "vcat", ""

    caption_file = target.parent / "captions.ass"
    video_filters = f"[{video_label}]null"
    if edit.captions:
        _write_captions(caption_file, edit, width, height)
        escaped = str(caption_file).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
        video_filters += f",subtitles=filename='{escaped}'"
    filters.append(video_filters + "[vout]")
    if has_audio:
        volume = 0 if edit.audio.muted else edit.audio.volume
        filters.append(f"[{audio_label}]volume={volume}[aout]")

    temporary = target.with_suffix(".partial.mp4")
    args = ["ffmpeg", "-nostdin", "-y", "-v", "error"]
    for source, _ in sources:
        args += ["-i", str(source)]
    args += ["-filter_complex", ";".join(filters), "-map", "[vout]"]
    if has_audio:
        args += ["-map", "[aout]"]
    args += ["-c:v", "libx264", "-preset", "fast", "-crf", "22", "-pix_fmt", "yuv420p"]
    if has_audio:
        args += ["-c:a", "aac", "-b:a", "128k"]
    args += ["-movflags", "+faststart", str(temporary)]
    try:
        run(args)
        temporary.replace(target)
    finally:
        caption_file.unlink(missing_ok=True)
