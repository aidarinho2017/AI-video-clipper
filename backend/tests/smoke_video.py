"""Run from the repository root: backend/.venv/bin/python -m backend.tests.smoke_video"""
import json
import tempfile
from pathlib import Path

from backend.models import ClipCandidate, EditorExportRequest
from backend.services.video import extract_audio, probe, render, render_edit, render_waveform, run
from backend.tests.test_pipeline import candidate


def main():
    with tempfile.TemporaryDirectory() as temp:
        folder = Path(temp)
        source, target = folder / "source.mp4", folder / "clip.mp4"
        run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
             "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "17", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(source)])
        assert 16.9 <= probe(source) <= 17.1
        extract_audio(source, folder / "audio.m4a")
        render_waveform(source, folder / "waveform.png")
        assert (folder / "waveform.png").stat().st_size > 0
        render(source, target, ClipCandidate.model_validate({**candidate(1), "end": 16}),
               "[1.00-8.00] Smoke test captions\n[8.00-16.00] Stay inside the safe area")
        assert 14.9 <= probe(target) <= 15.1
        info = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(target)]))
        stream = next(s for s in info["streams"] if s["codec_type"] == "video")
        assert (stream["width"], stream["height"], stream["codec_name"]) == (720, 1280, "h264")
        run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(target), "-f", "null", "-"])
        silent_source = folder / "silent-source.mp4"
        run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", str(silent_source)])
        edited = folder / "edited.mp4"
        edit = EditorExportRequest.model_validate({
            "segments": [
                {"id": "00000000-0000-0000-0000-000000000002", "source": {"kind": "upload", "id": "00000000-0000-0000-0000-000000000001"}, "source_start": 0, "source_end": 2},
                {"id": "00000000-0000-0000-0000-000000000003", "source": {"kind": "upload", "id": "00000000-0000-0000-0000-000000000001"}, "source_start": 4, "source_end": 6, "transition_duration": 0.5, "transform": {"scale": 1.2, "position_x": 0.2, "position_y": 0}},
                {"id": "00000000-0000-0000-0000-000000000005", "source": {"kind": "upload", "id": "00000000-0000-0000-0000-000000000001"}, "source_start": 8, "source_end": 10},
            ],
            "aspect_ratio": "1:1",
            "captions": [{"id": "00000000-0000-0000-0000-000000000004", "start": 0.5, "end": 1.5, "text": "Safe {caption}"}],
            "audio": {"volume": 0.5, "muted": False},
            "audio_tracks": [{"id": "00000000-0000-0000-0000-000000000006", "name": "Music", "clips": [{
                "id": "00000000-0000-0000-0000-000000000007", "source": {"kind": "upload", "id": "00000000-0000-0000-0000-000000000001"},
                "timeline_start": 0.5, "source_start": 1, "source_end": 4,
                "audio": {"volume": 0.4, "fade_in": 0.5, "fade_out": 0.5},
            }]}],
        })
        render_edit([(source, edit.segments[0]), (silent_source, edit.segments[1]), (source, edit.segments[2])],
                    [(source, edit.audio_tracks[0].clips[0])], edited, edit)
        assert 5.4 <= probe(edited) <= 5.6
        info = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(edited)]))
        stream = next(s for s in info["streams"] if s["codec_type"] == "video")
        assert (stream["width"], stream["height"]) == (720, 720)
        run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(edited), "-f", "null", "-"])
        silent = folder / "silent.mp4"
        silent_edit = edit.model_copy(update={"captions": [], "segments": edit.segments[:1]})
        silent_edit = silent_edit.model_copy(update={"audio_tracks": []})
        render_edit([(silent_source, silent_edit.segments[0])], [], silent, silent_edit)
        silent_info = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(silent)]))
        assert {stream["codec_type"] for stream in silent_info["streams"]} == {"video"}
    print("FFmpeg smoke test passed: clip and multi-segment editor exports decode correctly.")


if __name__ == "__main__":
    main()
