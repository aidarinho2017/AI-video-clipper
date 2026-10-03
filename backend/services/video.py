import json
import logging
import math
import re
import subprocess
import textwrap
from pathlib import Path

import cv2

from ..models import AudioClip, ClipCandidate, EditorExportRequest, PipelineError, VideoSegment

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


def probe_source(path: Path) -> dict:
    info = json.loads(run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)], 30))
    streams = info.get("streams", [])
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    duration = float(info.get("format", {}).get("duration", 0))
    if not (video_stream or audio_stream) or not math.isfinite(duration) or duration <= 0:
        raise PipelineError("The source must contain playable video or audio with a valid duration.")
    result = {"duration": duration, "kind": "video" if video_stream else "audio",
              "has_audio": audio_stream is not None}
    if not video_stream:
        return result
    width, height = int(video_stream.get("width", 0)), int(video_stream.get("height", 0))
    if width <= 0 or height <= 0:
        raise PipelineError("Could not determine the source video dimensions.")
    return {**result, "width": width, "height": height}


def probe_media(path: Path) -> dict:
    metadata = probe_source(path)
    if metadata["kind"] != "video":
        raise PipelineError("The source must contain playable video with a valid duration.")
    return metadata


def normalize_audio(source: Path, target: Path):
    run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(source), "-vn", "-ar", "48000",
         "-ac", "2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(target)])


def render_waveform(source: Path, target: Path):
    run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(source), "-filter_complex",
         "aformat=channel_layouts=mono,showwavespic=s=2000x80:colors=7ea0ff", "-frames:v", "1", str(target)], 120)


def probe(path: Path) -> float:
    metadata = probe_media(path)
    if not metadata["has_audio"]:
        raise PipelineError("The source must contain both video and audio with a valid duration.")
    return metadata["duration"]


def extract_audio(source: Path, target: Path):
    run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", str(target)])


TIMED_LINE = re.compile(r"^\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]\s+(.+)$")


def _face_center(source: Path, clip: ClipCandidate) -> float:
    detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if detector.empty():
        return 0.5
    capture = cv2.VideoCapture(str(source))
    detections = []
    try:
        samples = min(12, max(3, math.ceil((clip.end - clip.start) / 3)))
        for index in range(samples):
            timestamp = clip.start + (clip.end - clip.start) * (index + 0.5) / samples
            capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
            ok, frame = capture.read()
            if not ok:
                continue
            height, width = frame.shape[:2]
            scale = min(1, 640 / width)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if scale < 1:
                gray = cv2.resize(gray, (round(width * scale), round(height * scale)))
            faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5,
                                               minSize=(40, 40))
            if len(faces):
                x, _, face_width, face_height = max(faces, key=lambda face: face[2] * face[3])
                detections.append(((x + face_width / 2) / gray.shape[1], face_width * face_height))
    except cv2.error:
        return 0.5
    finally:
        capture.release()
    if not detections:
        return 0.5
    bins = [0] * 5
    for center, area in detections:
        bins[min(4, int(center * 5))] += area
    dominant = max(range(5), key=bins.__getitem__)
    faces = [(center, area) for center, area in detections if min(4, int(center * 5)) == dominant]
    return sum(center * area for center, area in faces) / sum(area for _, area in faces)


def _caption_cues(transcript: str, clip: ClipCandidate) -> list[tuple[float, float, str]]:
    cues = []
    for line in transcript.splitlines():
        match = TIMED_LINE.match(line.strip())
        if not match:
            continue
        start, end, text = float(match[1]), float(match[2]), match[3].strip()
        start, end = max(start, clip.start), min(end, clip.end)
        if end <= start or not text:
            continue
        words, chunks, current = text.split(), [], []
        for word in words:
            if current and len(" ".join(current + [word])) > 52:
                chunks.append(current)
                current = []
            current.append(word)
        if current:
            chunks.append(current)
        total_words = sum(map(len, chunks))
        offset = start
        for chunk in chunks:
            chunk_end = end if chunk is chunks[-1] else offset + (end - start) * len(chunk) / total_words
            wrapped = textwrap.wrap(" ".join(chunk), width=28, break_long_words=False)
            cues.append((offset - clip.start, chunk_end - clip.start, "\\N".join(wrapped[:2])))
            offset = chunk_end
    return cues


def _write_generated_captions(path: Path, transcript: str, clip: ClipCandidate):
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Liberation Sans,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,5,1,2,90,90,230,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for start, end, text in _caption_cues(transcript, clip):
        safe = text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
        safe = safe.replace("\\\\N", "\\N")
        lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{safe}")
    path.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")


def render(source: Path, target: Path, clip: ClipCandidate, transcript: str):
    temporary = target.with_suffix(".partial.mp4")
    caption_file = target.with_suffix(".captions.ass")
    _write_generated_captions(caption_file, transcript, clip)
    center = _face_center(source, clip)
    crop = f"crop=1080:1920:max(0\\,min(iw-ow\\,iw*{center:.4f}-ow/2)):(ih-oh)/2"
    escaped = caption_file.resolve().as_posix().replace(":", "\\:").replace("'", "\\'")
    filters = ("scale=1080:1920:force_original_aspect_ratio=increase," + crop +
               f",setsar=1,subtitles=filename='{escaped}'")
    try:
        run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-ss", str(clip.start), "-i", str(source),
             "-t", str(clip.end - clip.start), "-map", "0:v:0", "-map", "0:a:0",
             "-vf", filters, "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(temporary)])
        temporary.replace(target)
    finally:
        caption_file.unlink(missing_ok=True)


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


def render_edit(sources: list[tuple[Path, VideoSegment]], audio_sources: list[tuple[Path, AudioClip]],
                target: Path, edit: EditorExportRequest):
    width, height = RESOLUTIONS[edit.aspect_ratio]
    filters = []
    metadata = [probe_media(path) for path, _ in sources]
    has_linked_audio = any(value["has_audio"] for value in metadata)
    for index, ((_, segment), source_metadata) in enumerate(zip(sources, metadata)):
        start, end = segment.source_start, segment.source_end
        scale = segment.transform.scale
        scale_filter = (f"scale=w='ceil(iw*max({width}/iw\\,{height}/ih)*{scale}/2)*2':"
                        f"h='ceil(ih*max({width}/iw\\,{height}/ih)*{scale}/2)*2'")
        crop = (f"crop={width}:{height}:(in_w-out_w)*({segment.transform.position_x}+1)/2:"
                f"(in_h-out_h)*({segment.transform.position_y}+1)/2,setsar=1")
        filters.append(f"[{index}:v]trim=start={start}:end={end},setpts=PTS-STARTPTS,{scale_filter},{crop},fps=30,settb=AVTB,format=yuv420p[v{index}]")
        if has_linked_audio:
            duration = end - start
            audio = segment.audio
            effects = f",volume={0 if audio.muted else audio.volume}"
            if audio.fade_in:
                effects += f",afade=t=in:st=0:d={audio.fade_in}"
            if audio.fade_out:
                effects += f",afade=t=out:st={duration - audio.fade_out}:d={audio.fade_out}"
            if source_metadata["has_audio"]:
                filters.append(f"[{index}:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo{effects}[a{index}]")
            else:
                filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={duration},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo{effects}[a{index}]")

    video_label, audio_label = "v0", "a0"
    combined_duration = edit.segments[0].source_end - edit.segments[0].source_start
    for index, segment in enumerate(edit.segments[1:], 1):
        transition = segment.transition_duration
        next_video, next_audio = f"vjoin{index}", f"ajoin{index}"
        if transition:
            filters.append(
                f"[{video_label}][v{index}]xfade=transition=fade:duration={transition}:"
                f"offset={combined_duration - transition}[{next_video}]"
            )
            if has_linked_audio:
                filters.append(f"[{audio_label}][a{index}]acrossfade=d={transition}[{next_audio}]")
        else:
            if has_linked_audio:
                filters.append(
                    f"[{video_label}][{audio_label}][v{index}][a{index}]"
                    f"concat=n=2:v=1:a=1[{next_video}][{next_audio}]"
                )
            else:
                filters.append(f"[{video_label}][v{index}]concat=n=2:v=1:a=0[{next_video}]")
        video_label = next_video
        if has_linked_audio:
            audio_label = next_audio
        combined_duration += segment.source_end - segment.source_start - transition

    mix_labels = [audio_label] if has_linked_audio else []
    for index, (_, clip) in enumerate(audio_sources):
        input_index = len(sources) + index
        duration = clip.source_end - clip.source_start
        audio = clip.audio
        effects = f",volume={0 if audio.muted else audio.volume}"
        if audio.fade_in:
            effects += f",afade=t=in:st=0:d={audio.fade_in}"
        if audio.fade_out:
            effects += f",afade=t=out:st={duration - audio.fade_out}:d={audio.fade_out}"
        label = f"extra{index}"
        delay = round(clip.timeline_start * 1000)
        filters.append(
            f"[{input_index}:a]atrim=start={clip.source_start}:end={clip.source_end},"
            f"asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
            f"{effects},adelay={delay}:all=1[{label}]"
        )
        mix_labels.append(label)

    caption_file = target.parent / "captions.ass"
    video_filters = f"[{video_label}]null"
    if edit.captions:
        _write_captions(caption_file, edit, width, height)
        escaped = caption_file.resolve().as_posix().replace(":", "\\:").replace("'", "\\'")
        video_filters += f",subtitles=filename='{escaped}'"
    filters.append(video_filters + "[vout]")
    if mix_labels:
        mixed = mix_labels[0]
        if len(mix_labels) > 1:
            inputs = "".join(f"[{label}]" for label in mix_labels)
            filters.append(f"{inputs}amix=inputs={len(mix_labels)}:duration=longest:normalize=0[amixed]")
            mixed = "amixed"
        volume = 0 if edit.audio.muted else edit.audio.volume
        filters.append(f"[{mixed}]apad=pad_dur={combined_duration},atrim=duration={combined_duration},"
                       f"volume={volume},alimiter=limit=0.95[aout]")

    temporary = target.with_suffix(".partial.mp4")
    args = ["ffmpeg", "-nostdin", "-y", "-v", "error"]
    for source, _ in sources + audio_sources:
        args += ["-i", str(source)]
    args += ["-filter_complex", ";".join(filters), "-map", "[vout]"]
    if mix_labels:
        args += ["-map", "[aout]"]
    args += ["-c:v", "libx264", "-preset", "fast", "-crf", "22", "-pix_fmt", "yuv420p"]
    if mix_labels:
        args += ["-c:a", "aac", "-b:a", "128k"]
    args += ["-movflags", "+faststart", str(temporary)]
    try:
        run(args)
        temporary.replace(target)
    finally:
        caption_file.unlink(missing_ok=True)
