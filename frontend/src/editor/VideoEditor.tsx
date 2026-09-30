"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  MIN_CAPTION_DURATION,
  MIN_TRANSITION_DURATION,
  type AudioClip,
  audioClipDuration,
  audioGainAt,
  clipAudioGain,
  clamp,
  type Caption,
  deleteSegment,
  deleteAudioClip,
  type EditorState,
  type EditorSource,
  formatTime,
  pixelsToTime,
  projectLayers,
  projectToSource,
  segmentStarts,
  setTransition,
  splitAudioClip,
  splitAt,
  timeToPixels,
  timelineDuration,
  transitionLimit,
  trimAudioClip,
  trimSegment,
  moveAudioClip,
  removeAudioTimelineRange,
  insertAudioTimelineTime,
  type VideoSegment,
} from "./editor-state";

const API = "http://localhost:8000";
const OUTPUT_HEIGHT = { "9:16": 1280, "16:9": 720, "1:1": 720 } as const;

type SourceMetadata = {
  kind: "video" | "audio";
  duration: number;
  width?: number;
  height?: number;
  has_audio: boolean;
};

type MediaItem = {
  id: string;
  name: string;
  source: EditorSource;
  url: string;
  metadata: SourceMetadata | null;
};

type Drag = {
  startX: number;
  width: number;
  duration: number;
  edge: "start" | "end";
  segment: VideoSegment;
  editor: EditorState;
};

type AudioDrag = {
  startX: number;
  width: number;
  duration: number;
  mode: "move" | "start" | "end";
  clip: AudioClip;
  editor: EditorState;
  sourceDuration: number;
};

const defaultTransform = () => ({ scale: 1, positionX: 0, positionY: 0 });
const defaultClipAudio = () => ({ volume: 1, muted: false, fadeIn: 0, fadeOut: 0 });

function initialEditor(mediaId: string, start: number, end: number): EditorState {
  return {
    segments: [{ id: crypto.randomUUID(), mediaId, sourceStart: start, sourceEnd: end, transitionDuration: 0, transform: defaultTransform(), audio: defaultClipAudio() }],
    aspectRatio: "9:16",
    captions: [],
    captionStyle: { preset: "classic", fontSize: 36 },
    audio: { volume: 1, muted: false },
    audioTracks: [],
  };
}

async function jsonRequest(path: string, options?: RequestInit) {
  const response = await fetch(`${API}${path}`, options);
  const data = await response.json();
  if (!response.ok)
    throw new Error(typeof data.detail === "string" ? data.detail : "Request failed.");
  return data;
}

function waveformUrl(item?: MediaItem) {
  if (!item?.metadata?.has_audio) return "";
  return item.source.kind === "upload"
    ? `${API}/editor/sources/${item.source.id}/waveform`
    : `${API}/editor/jobs/${item.source.jobId}/waveform`;
}

export default function VideoEditor({ jobId, clipIndex }: { jobId?: string; clipIndex?: number }) {
  const videos = useRef(new Map<number, HTMLVideoElement>());
  const audios = useRef(new Map<string, HTMLAudioElement>());
  const timeline = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const playIntent = useRef(false);
  const playbackStart = useRef({ time: 0, wall: 0 });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedSegment, setSelectedSegment] = useState("");
  const [selectedTransition, setSelectedTransition] = useState<number | null>(null);
  const [selectedCaption, setSelectedCaption] = useState("");
  const [selectedAudio, setSelectedAudio] = useState("");
  const [timelineWidth, setTimelineWidth] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [audioDrag, setAudioDrag] = useState<AudioDrag | null>(null);
  const [cropDrag, setCropDrag] = useState<{ x: number; y: number; positionX: number; positionY: number } | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [busy, setBusy] = useState(Boolean(jobId && clipIndex));
  const [exportId, setExportId] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const [exportSnapshot, setExportSnapshot] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!jobId || !clipIndex) return;
    jsonRequest(`/jobs/${jobId}`)
      .then((job) => {
        const clip = job.clips?.find((value: { index: number }) => value.index === clipIndex);
        if (!clip) throw new Error("Generated clip not found.");
        const mediaId = crypto.randomUUID();
        const item: MediaItem = { id: mediaId, name: "AI source video", source: { kind: "job", jobId }, url: `${API}/editor/jobs/${jobId}/source`, metadata: null };
        const next = initialEditor(mediaId, clip.start, clip.end);
        setMedia([item]);
        setEditor(next);
        setSelectedSegment(next.segments[0].id);
      })
      .catch((reason) => setError(reason.message))
      .finally(() => setBusy(false));
  }, [jobId, clipIndex]);

  useEffect(() => {
    if (!timeline.current) return;
    const observer = new ResizeObserver(([entry]) => setTimelineWidth(entry.contentRect.width));
    observer.observe(timeline.current);
    return () => observer.disconnect();
  }, [editor]);

  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [editor?.aspectRatio]);

  const duration = editor ? timelineDuration(editor.segments) : 0;
  const active = editor?.segments[activeIndex];
  const selected = editor?.segments.find((segment) => segment.id === selectedSegment);
  const selectedSource = media.find((item) => item.id === selected?.mediaId)?.metadata;
  const selectedAudioClip = editor?.audioTracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedAudio);

  const seek = useCallback(
    (time: number) => {
      if (!editor) return;
      const location = projectToSource(editor.segments, time);
      if (!location) return;
      setActiveIndex(location.index);
      const nextTime = Math.min(time, timelineDuration(editor.segments));
      playbackStart.current = { time: nextTime, wall: performance.now() };
      setPlayhead(nextTime);
    },
    [editor],
  );

  useEffect(() => {
    if (!playing || !editor) return;
    const tick = () => {
      const nextTime = playbackStart.current.time + (performance.now() - playbackStart.current.wall) / 1000;
      if (nextTime >= timelineDuration(editor.segments)) {
        playIntent.current = false;
        videos.current.forEach((element) => element.pause());
        audios.current.forEach((element) => element.pause());
        setPlaying(false);
        setPlayhead(timelineDuration(editor.segments));
        return;
      }
      const location = projectToSource(editor.segments, nextTime);
      if (location) setActiveIndex(location.index);
      setPlayhead(nextTime);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, editor]);

  const volume = editor?.audio.volume;
  const muted = editor?.audio.muted;
  useEffect(() => {
    if (!editor) return;
    for (const layer of projectLayers(editor.segments, playhead)) {
      const element = videos.current.get(layer.index);
      if (!element) continue;
      const segment = editor.segments[layer.index];
      const gain = clipAudioGain(segment.audio, layer.sourceTime - segment.sourceStart, segment.sourceEnd - segment.sourceStart);
      element.volume = muted ? 0 : (volume ?? 1) * layer.opacity * gain;
      const drift = Math.abs(element.currentTime - layer.sourceTime);
      if (!playing || drift > 0.12) element.currentTime = layer.sourceTime;
      if (playing && element.paused) element.play().catch(() => setError("The browser could not play this video."));
    }
    for (const track of editor.audioTracks) for (const clip of track.clips) {
      const element = audios.current.get(clip.id);
      if (!element) continue;
      const sourceTime = clip.sourceStart + playhead - clip.timelineStart;
      element.volume = muted ? 0 : (volume ?? 1) * audioGainAt(clip, playhead);
      if (!playing || Math.abs(element.currentTime - sourceTime) > 0.12) element.currentTime = sourceTime;
      if (playing && element.paused) element.play().catch(() => setError("The browser could not play this audio."));
    }
  }, [editor, muted, playhead, playing, volume]);

  useEffect(() => {
    if (!exportId || exportStatus === "completed" || exportStatus === "failed") return;
    const timer = setInterval(() => {
      jsonRequest(`/editor/exports/${exportId}`)
        .then((state) => {
          setExportStatus(state.status);
          if (state.status === "failed") setError(state.error || "Export failed.");
        })
        .catch((reason) => setError(reason.message));
    }, 1500);
    return () => clearInterval(timer);
  }, [exportId, exportStatus]);

  async function upload(files?: FileList | null, expected: "video" | "audio" = "video") {
    if (!files?.length) return;
    if (expected === "audio" && editor && editor.audioTracks.length + files.length > 16) {
      setError("Audio projects can contain at most 16 tracks.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const imported: MediaItem[] = [];
      for (const file of Array.from(files)) {
        const metadata: SourceMetadata & { id: string } = await jsonRequest("/editor/sources", {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (metadata.kind !== expected) throw new Error(`Choose an ${expected} file.`);
        imported.push({ id: crypto.randomUUID(), name: file.name, source: { kind: "upload", id: metadata.id }, url: `${API}/editor/sources/${metadata.id}`, metadata });
      }
      setMedia((current) => [...current, ...imported]);
      if (expected === "audio") {
        if (!editor) throw new Error("Add a video before importing audio.");
        const tracks = imported.map((item) => ({
          id: crypto.randomUUID(),
          name: item.name,
          clips: [{ id: crypto.randomUUID(), mediaId: item.id, timelineStart: 0, sourceStart: 0,
            sourceEnd: Math.min(item.metadata!.duration, duration), audio: defaultClipAudio() }],
        }));
        setEditor({ ...editor, audioTracks: [...editor.audioTracks, ...tracks] });
        setSelectedAudio(tracks[0]?.clips[0]?.id ?? "");
      } else if (!editor && imported[0]) {
        const next = initialEditor(imported[0].id, 0, imported[0].metadata!.duration);
        setEditor(next);
        setSelectedSegment(next.segments[0].id);
        setPlayhead(0);
      }
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function addMedia(item: MediaItem) {
    if (!editor || !item.metadata || item.metadata.kind !== "video") return;
    const segment = { id: crypto.randomUUID(), mediaId: item.id, sourceStart: 0, sourceEnd: item.metadata.duration, transitionDuration: 0, transform: defaultTransform(), audio: defaultClipAudio() };
    setActiveIndex(editor.segments.length);
    setEditor({ ...editor, segments: [...editor.segments, segment] });
    setSelectedSegment(segment.id);
    setSelectedTransition(null);
    setPlayhead(duration);
  }

  function togglePlayback() {
    if (!editor) return;
    if (playing) {
      playIntent.current = false;
      videos.current.forEach((element) => element.pause());
      audios.current.forEach((element) => element.pause());
      setPlaying(false);
      return;
    }
    if (playhead >= duration - 0.01) seek(0);
    playIntent.current = true;
    playbackStart.current = { time: playhead >= duration - 0.01 ? 0 : playhead, wall: performance.now() };
    setPlaying(true);
    videos.current.forEach((element) => element.play().catch(() => setError("The browser could not play this video.")));
    audios.current.forEach((element) => element.play().catch(() => setError("The browser could not play this audio.")));
  }

  function split() {
    if (!editor) return;
    if (selectedAudio) {
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      let index = 0;
      const tracks = splitAudioClip(editor.audioTracks, selectedAudio, playhead, () => ids[index++]);
      if (index) {
        setEditor({ ...editor, audioTracks: tracks });
        setSelectedAudio(ids[1]);
      }
      return;
    }
    if (projectLayers(editor.segments, playhead).length > 1) {
      setError("Move the playhead outside the transition before splitting.");
      return;
    }
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    let index = 0;
    const segments = splitAt(editor.segments, playhead, () => ids[index++]);
    if (segments === editor.segments) return;
    setEditor({ ...editor, segments });
    setSelectedSegment(ids[1]);
    setSelectedTransition(null);
  }

  function removeSelectedSegment() {
    if (!editor || !selectedSegment) return;
    const selectedIndex = editor.segments.findIndex((value) => value.id === selectedSegment);
    const result = deleteSegment(editor.segments, editor.captions, selectedSegment);
    if (result.segments === editor.segments) return;
    const removed = timelineDuration(editor.segments) - timelineDuration(result.segments);
    const start = segmentStarts(editor.segments)[selectedIndex];
    setEditor({ ...editor, ...result, audioTracks: removeAudioTimelineRange(editor.audioTracks, start, start + removed) });
    setSelectedTransition(null);
    setSelectedSegment(result.segments[Math.min(selectedIndex, result.segments.length - 1)].id);
    const nextPlayhead = Math.min(playhead, timelineDuration(result.segments));
    const location = projectToSource(result.segments, nextPlayhead);
    if (location) {
      setActiveIndex(location.index);
    }
    setPlayhead(nextPlayhead);
  }

  function startTrim(event: React.PointerEvent, segment: VideoSegment, edge: "start" | "end") {
    if (!editor || !timeline.current) return;
    event.stopPropagation();
    playIntent.current = false;
    setPlaying(false);
    videos.current.forEach((element) => element.pause());
    audios.current.forEach((element) => element.pause());
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      startX: event.clientX,
      width: timeline.current.getBoundingClientRect().width,
      duration,
      edge,
      segment,
      editor,
    });
  }

  function moveTrim(event: React.PointerEvent) {
    if (!drag) return;
    const sourceDuration = media.find((item) => item.id === drag.segment.mediaId)?.metadata?.duration;
    if (!sourceDuration) return;
    const difference = pixelsToTime(Math.abs(event.clientX - drag.startX), drag.duration, drag.width);
    const signedDifference = event.clientX < drag.startX ? -difference : difference;
    const initial = drag.edge === "start" ? drag.segment.sourceStart : drag.segment.sourceEnd;
    const result = trimSegment(
      drag.editor.segments,
      drag.editor.captions,
      drag.segment.id,
      drag.edge,
      initial + signedDifference,
      sourceDuration,
    );
    const oldDuration = timelineDuration(drag.editor.segments);
    const newDuration = timelineDuration(result.segments);
    const segmentIndex = drag.editor.segments.findIndex((value) => value.id === drag.segment.id);
    const oldStart = segmentStarts(drag.editor.segments)[segmentIndex];
    const nextStart = segmentStarts(result.segments)[segmentIndex];
    let audioTracks = drag.editor.audioTracks;
    if (newDuration < oldDuration) {
      const start = drag.edge === "start" ? oldStart : nextStart + result.segments[segmentIndex].sourceEnd - result.segments[segmentIndex].sourceStart;
      audioTracks = removeAudioTimelineRange(audioTracks, start, start + oldDuration - newDuration);
    } else if (newDuration > oldDuration) {
      const at = drag.edge === "start" ? oldStart : oldStart + drag.segment.sourceEnd - drag.segment.sourceStart;
      audioTracks = insertAudioTimelineTime(audioTracks, at, newDuration - oldDuration);
    }
    setEditor({ ...drag.editor, ...result, audioTracks });
    setPlayhead((value) => Math.min(value, timelineDuration(result.segments)));
  }

  function seekFromTrack(event: React.MouseEvent) {
    if (!timeline.current) return;
    const bounds = timeline.current.getBoundingClientRect();
    seek(pixelsToTime(event.clientX - bounds.left, duration, bounds.width));
  }

  function addCaption() {
    if (!editor) return;
    const active = editor.captions.find((caption) => caption.start <= playhead && playhead < caption.end);
    if (active) {
      setSelectedCaption(active.id);
      return;
    }
    const ordered = [...editor.captions].sort((a, b) => a.start - b.start);
    const nextStart = ordered.find((caption) => caption.start > playhead)?.start ?? duration;
    const previousEnd = [...ordered].reverse().find((caption) => caption.end <= playhead)?.end ?? 0;
    const start = Math.max(playhead, previousEnd);
    const end = Math.min(start + 2, nextStart, duration);
    if (end - start < MIN_CAPTION_DURATION) {
      setError("There is no room for another caption at the playhead.");
      return;
    }
    const caption = { id: crypto.randomUUID(), start, end, text: "New caption", positionX: 0.5, positionY: 0.82 };
    setEditor({ ...editor, captions: [...ordered, caption].sort((a, b) => a.start - b.start) });
    setSelectedCaption(caption.id);
  }

  function updateCaption(changes: Partial<Caption>, captionId = selectedCaption) {
    if (!editor) return;
    const index = editor.captions.findIndex((caption) => caption.id === captionId);
    if (index < 0) return;
    const current = editor.captions[index];
    const previousEnd = index ? editor.captions[index - 1].end : 0;
    const nextStart = index < editor.captions.length - 1 ? editor.captions[index + 1].start : duration;
    const start = changes.start === undefined
      ? current.start
      : Math.min(Math.max(changes.start, previousEnd), current.end - MIN_CAPTION_DURATION);
    const end = changes.end === undefined
      ? current.end
      : Math.max(Math.min(changes.end, nextStart), current.start + MIN_CAPTION_DURATION);
    const captions = [...editor.captions];
    captions[index] = { ...current, ...changes, start, end };
    setEditor({ ...editor, captions });
  }

  function updateTransform(changes: Partial<VideoSegment["transform"]>) {
    if (!editor || !selected) return;
    setEditor({ ...editor, segments: editor.segments.map((segment) =>
      segment.id === selected.id ? { ...segment, transform: { ...segment.transform, ...changes } } : segment,
    ) });
  }

  function updateSegmentAudio(changes: Partial<VideoSegment["audio"]>) {
    if (!editor || !selected) return;
    const next = { ...selected.audio, ...changes };
    const clipDuration = selected.sourceEnd - selected.sourceStart;
    if (next.fadeIn + next.fadeOut > clipDuration) {
      if (changes.fadeIn !== undefined) next.fadeOut = Math.max(0, clipDuration - next.fadeIn);
      else next.fadeIn = Math.max(0, clipDuration - next.fadeOut);
    }
    setEditor({ ...editor, segments: editor.segments.map((segment) =>
      segment.id === selected.id ? { ...segment, audio: next } : segment,
    ) });
  }

  function updateTransition(duration: number) {
    if (!editor || selectedTransition === null) return;
    const result = setTransition(editor.segments, editor.captions, selectedTransition, duration);
    const oldDuration = editor.segments[selectedTransition].transitionDuration;
    const difference = result.segments[selectedTransition].transitionDuration - oldDuration;
    const junction = segmentStarts(editor.segments)[selectedTransition] + oldDuration;
    const audioTracks = difference > 0
      ? removeAudioTimelineRange(editor.audioTracks, junction, junction + difference)
      : insertAudioTimelineTime(editor.audioTracks, junction, -difference);
    setEditor({ ...editor, ...result, audioTracks });
    setPlayhead((value) => Math.min(value, timelineDuration(result.segments)));
  }

  function moveCrop(event: React.PointerEvent) {
    if (!cropDrag || !selected) return;
    const metadata = media.find((item) => item.id === selected.mediaId)?.metadata;
    if (!metadata?.width || !metadata.height) return;
    const scale = Math.max(viewportSize.width / metadata.width, viewportSize.height / metadata.height) * selected.transform.scale;
    const renderedWidth = metadata.width * scale;
    const renderedHeight = metadata.height * scale;
    const overflowX = renderedWidth - viewportSize.width;
    const overflowY = renderedHeight - viewportSize.height;
    updateTransform({
      positionX: overflowX > 0 ? clamp(cropDrag.positionX - (event.clientX - cropDrag.x) * 2 / overflowX, -1, 1) : 0,
      positionY: overflowY > 0 ? clamp(cropDrag.positionY - (event.clientY - cropDrag.y) * 2 / overflowY, -1, 1) : 0,
    });
  }

  function moveCaption(event: React.PointerEvent, captionId: string) {
    if (!viewport.current) return;
    const bounds = viewport.current.getBoundingClientRect();
    updateCaption({
      positionX: clamp((event.clientX - bounds.left) / bounds.width, 0.05, 0.95),
      positionY: clamp((event.clientY - bounds.top) / bounds.height, 0.05, 0.95),
    }, captionId);
  }

  function updateClipAudio(changes: Partial<AudioClip["audio"]>) {
    if (!editor || !selectedAudioClip) return;
    const next = { ...selectedAudioClip.audio, ...changes };
    const clipDuration = audioClipDuration(selectedAudioClip);
    if (next.fadeIn + next.fadeOut > clipDuration) {
      if (changes.fadeIn !== undefined) next.fadeOut = Math.max(0, clipDuration - next.fadeIn);
      else next.fadeIn = Math.max(0, clipDuration - next.fadeOut);
    }
    setEditor({ ...editor, audioTracks: editor.audioTracks.map((track) => ({ ...track,
      clips: track.clips.map((clip) => clip.id === selectedAudio ? { ...clip, audio: next } : clip),
    })) });
  }

  function startAudioDrag(event: React.PointerEvent, clip: AudioClip, mode: AudioDrag["mode"]) {
    if (!editor || !timeline.current) return;
    event.stopPropagation();
    playIntent.current = false;
    setPlaying(false);
    videos.current.forEach((element) => element.pause());
    audios.current.forEach((element) => element.pause());
    event.currentTarget.setPointerCapture(event.pointerId);
    setAudioDrag({
      startX: event.clientX,
      width: timeline.current.getBoundingClientRect().width,
      duration,
      mode,
      clip,
      editor,
      sourceDuration: media.find((item) => item.id === clip.mediaId)?.metadata?.duration ?? clip.sourceEnd,
    });
  }

  function moveAudioDrag(event: React.PointerEvent) {
    if (!audioDrag) return;
    const difference = pixelsToTime(Math.abs(event.clientX - audioDrag.startX), audioDrag.duration, audioDrag.width);
    const signed = event.clientX < audioDrag.startX ? -difference : difference;
    const tracks = audioDrag.mode === "move"
      ? moveAudioClip(audioDrag.editor.audioTracks, audioDrag.clip.id, audioDrag.clip.timelineStart + signed, audioDrag.duration)
      : trimAudioClip(audioDrag.editor.audioTracks, audioDrag.clip.id, audioDrag.mode,
          (audioDrag.mode === "start" ? audioDrag.clip.sourceStart : audioDrag.clip.sourceEnd) + signed,
          audioDrag.sourceDuration, audioDrag.duration);
    setEditor({ ...audioDrag.editor, audioTracks: tracks });
  }

  function removeSelectedAudio() {
    if (!editor || !selectedAudio) return;
    setEditor({ ...editor, audioTracks: deleteAudioClip(editor.audioTracks, selectedAudio) });
    setSelectedAudio("");
  }

  async function exportVideo() {
    if (!editor) return;
    if (editor.captions.some((caption) => !caption.text.trim())) {
      setError("Caption text cannot be empty.");
      return;
    }
    setError("");
    setExportStatus("queued");
    setExportSnapshot(JSON.stringify(editor));
    try {
      const state = await jsonRequest("/editor/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments: editor.segments.map((segment) => ({
            id: segment.id,
            source: (() => {
              const item = media.find((value) => value.id === segment.mediaId)!;
              return item.source.kind === "upload" ? item.source : { kind: "job", job_id: item.source.jobId };
            })(),
            source_start: segment.sourceStart,
            source_end: segment.sourceEnd,
            transition_duration: segment.transitionDuration,
            audio: {
              volume: segment.audio.volume,
              muted: segment.audio.muted,
              fade_in: segment.audio.fadeIn,
              fade_out: segment.audio.fadeOut,
            },
            transform: {
              scale: segment.transform.scale,
              position_x: segment.transform.positionX,
              position_y: segment.transform.positionY,
            },
          })),
          aspect_ratio: editor.aspectRatio,
          captions: editor.captions.map(({ positionX, positionY, ...caption }) => ({ ...caption, position_x: positionX, position_y: positionY })),
          caption_style: {
            preset: editor.captionStyle.preset,
            font_size: editor.captionStyle.fontSize,
          },
          audio: editor.audio,
          audio_tracks: editor.audioTracks.map((track) => ({
            id: track.id,
            name: track.name,
            clips: track.clips.map((clip) => {
              const item = media.find((value) => value.id === clip.mediaId)!;
              return {
                id: clip.id,
                source: item.source,
                timeline_start: clip.timelineStart,
                source_start: clip.sourceStart,
                source_end: clip.sourceEnd,
                audio: { volume: clip.audio.volume, muted: clip.audio.muted,
                  fade_in: clip.audio.fadeIn, fade_out: clip.audio.fadeOut },
              };
            }),
          })),
        }),
      });
      setExportId(state.id);
      setExportStatus(state.status);
    } catch (reason) {
      setExportStatus("");
      setError((reason as Error).message);
    }
  }

  if (!editor)
    return (
      <main className="editor-empty">
        <Link href="/" className="editor-home">← AI Video Clipper</Link>
        <section className="panel editor-picker">
          <div className="eyebrow">STANDALONE VIDEO EDITOR</div>
          <h1>Edit any local video.</h1>
          <p>Preview in your browser. FFmpeg runs only when you export.</p>
          <label className="primary file-button">
            {busy ? "Opening…" : "Choose video"}
            <input type="file" accept="video/*" multiple disabled={busy} onChange={(event) => upload(event.target.files)} />
          </label>
          {error && <p role="alert" className="editor-inline-error">{error}</p>}
        </section>
      </main>
    );

  const activeCaption = editor.captions.find(
    (caption) => caption.start <= playhead && playhead < caption.end,
  );
  const caption = editor.captions.find((value) => value.id === selectedCaption);
  const transition = selectedTransition === null ? null : editor.segments[selectedTransition];
  const transitionMax = selectedTransition === null ? 0 : transitionLimit(editor.segments, selectedTransition);
  const starts = segmentStarts(editor.segments);
  const exportIsCurrent = exportStatus === "completed" && exportSnapshot === JSON.stringify(editor);
  const previewLayers = projectLayers(editor.segments, playhead);
  const activeAudioClips = editor.audioTracks.flatMap((track) => track.clips).filter((clip) =>
    clip.timelineStart <= playhead && playhead < clip.timelineStart + audioClipDuration(clip),
  );

  function layerStyle(index: number, opacity: number) {
    const segment = editor!.segments[index];
    const metadata = media.find((item) => item.id === segment.mediaId)?.metadata;
    const baseScale = metadata?.width && metadata.height && viewportSize.width
      ? Math.max(viewportSize.width / metadata.width, viewportSize.height / metadata.height) * segment.transform.scale
      : 1;
    const width = metadata?.width ? metadata.width * baseScale : viewportSize.width;
    const height = metadata?.height ? metadata.height * baseScale : viewportSize.height;
    return {
      width,
      height,
      left: -(width - viewportSize.width) * ((segment.transform.positionX + 1) / 2),
      top: -(height - viewportSize.height) * ((segment.transform.positionY + 1) / 2),
      opacity,
    };
  }

  return (
    <main className="editor-shell">
      <header className="editor-header">
        <Link href="/" className="editor-home">← AI Video Clipper</Link>
        <div>
          {(exportStatus === "queued" || exportStatus === "processing") && <span className="export-status">Export {exportStatus}…</span>}
          {exportIsCurrent ? (
            <a className="primary" href={`${API}/editor/exports/${exportId}/video?download=true`}>Download MP4 ↓</a>
          ) : (
            <button className="primary" onClick={exportVideo} disabled={exportStatus === "queued" || exportStatus === "processing"}>Export Video ↗</button>
          )}
        </div>
      </header>
      {error && <div role="alert" className="error editor-error">{error}</div>}
      {activeAudioClips.map((clip) => {
        const item = media.find((value) => value.id === clip.mediaId);
        return <audio
          key={clip.id}
          ref={(element) => { if (element) audios.current.set(clip.id, element); else audios.current.delete(clip.id); }}
          src={item?.url}
          preload="auto"
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            element.currentTime = clip.sourceStart + playhead - clip.timelineStart;
            element.volume = editor.audio.muted ? 0 : editor.audio.volume * audioGainAt(clip, playhead);
            if (playIntent.current) element.play().catch(() => setError("The browser could not play this audio."));
          }}
        />;
      })}
      <div className="editor-workspace">
        <aside className="media-bin">
          <div className="media-bin-header"><h2>Videos</h2><label className="secondary file-button">{busy ? "Importing…" : "+ Import"}<input type="file" accept="video/*" multiple disabled={busy} onChange={(event) => upload(event.target.files)} /></label></div>
          <div className="media-list">
            {media.filter((item) => item.metadata?.kind !== "audio").map((item) => (
              <article key={item.id} className={item.id === active?.mediaId ? "active" : ""}>
                <strong title={item.name}>{item.name}</strong>
                <span>{item.metadata ? formatTime(item.metadata.duration) : "Loading…"}</span>
                <button className="text-button" disabled={!item.metadata} onClick={() => addMedia(item)}>Add to timeline</button>
              </article>
            ))}
          </div>
          <div className="audio-import"><h2>Audio</h2><label className="secondary file-button">+ Add tracks<input type="file" accept="audio/*" multiple disabled={busy} onChange={(event) => upload(event.target.files, "audio")} /></label></div>
        </aside>
        <section className="editor-stage">
          <div
            ref={viewport}
            className={`editor-viewport ratio-${editor.aspectRatio.replace(":", "-")} ${cropMode ? "crop-mode" : ""}`}
            style={{ aspectRatio: editor.aspectRatio.replace(":", " / ") }}
            onPointerDown={(event) => {
              if (!cropMode || !selected) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              setCropDrag({ x: event.clientX, y: event.clientY, positionX: selected.transform.positionX, positionY: selected.transform.positionY });
            }}
            onPointerMove={moveCrop}
            onPointerUp={() => setCropDrag(null)}
            onPointerCancel={() => setCropDrag(null)}
          >
            {previewLayers.map((layer) => {
              const segment = editor.segments[layer.index];
              const item = media.find((value) => value.id === segment.mediaId);
              return <video
                key={`${layer.index}-${item?.id}`}
                ref={(element) => {
                  if (element) videos.current.set(layer.index, element);
                  else videos.current.delete(layer.index);
                }}
                src={item?.url}
                playsInline
                preload="auto"
                style={layerStyle(layer.index, layer.opacity)}
                onLoadedMetadata={(event) => {
                  const element = event.currentTarget;
                  setMedia((current) => current.map((value) => value.id === item?.id ? { ...value, metadata: value.metadata ?? { kind: "video", duration: element.duration, width: element.videoWidth, height: element.videoHeight, has_audio: true } } : value));
                  element.currentTime = layer.sourceTime;
                  element.volume = editor.audio.muted ? 0 : editor.audio.volume * layer.opacity * clipAudioGain(segment.audio, layer.sourceTime - segment.sourceStart, segment.sourceEnd - segment.sourceStart);
                  if (playIntent.current) element.play().catch(() => setError("The browser could not play this video."));
                }}
              />;
            })}
            {activeCaption && (
              <div
                className={`preview-caption caption-${editor.captionStyle.preset}`}
                style={{
                  left: `${activeCaption.positionX * 100}%`,
                  top: `${activeCaption.positionY * 100}%`,
                  fontSize: Math.max(12, editor.captionStyle.fontSize * viewportSize.height / OUTPUT_HEIGHT[editor.aspectRatio]),
                }}
                role="button"
                tabIndex={0}
                aria-label="Move caption"
                onPointerDown={(event) => { event.stopPropagation(); setSelectedCaption(activeCaption.id); event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveCaption(event, activeCaption.id); }}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 0.05 : 0.01;
                  if (event.key === "ArrowLeft") updateCaption({ positionX: clamp(activeCaption.positionX - step, 0.05, 0.95) }, activeCaption.id);
                  if (event.key === "ArrowRight") updateCaption({ positionX: clamp(activeCaption.positionX + step, 0.05, 0.95) }, activeCaption.id);
                  if (event.key === "ArrowUp") updateCaption({ positionY: clamp(activeCaption.positionY - step, 0.05, 0.95) }, activeCaption.id);
                  if (event.key === "ArrowDown") updateCaption({ positionY: clamp(activeCaption.positionY + step, 0.05, 0.95) }, activeCaption.id);
                }}
              >
                {activeCaption.text}
              </div>
            )}
          </div>
          <div className="playback-controls">
            <button onClick={togglePlayback}>{playing ? "Pause" : "Play"}</button>
            <span>{formatTime(playhead)} / {formatTime(duration)}</span>
          </div>
        </section>

        <aside className="editor-inspector">
          <section>
            <h2>Frame</h2>
            <div className="segmented-control">
              {(["9:16", "16:9", "1:1"] as const).map((ratio) => (
                <button key={ratio} aria-pressed={editor.aspectRatio === ratio} onClick={() => setEditor({ ...editor, aspectRatio: ratio })}>{ratio}</button>
              ))}
            </div>
            {selected && <>
              <div className="crop-actions"><button className="secondary" aria-pressed={cropMode} onClick={() => setCropMode((value) => !value)}>{cropMode ? "Done cropping" : "Crop & reframe"}</button><button className="text-button" onClick={() => updateTransform(defaultTransform())}>Reset</button></div>
              <label>Zoom <span>{selected.transform.scale.toFixed(2)}×</span><input type="range" min="1" max="3" step="0.01" value={selected.transform.scale} onChange={(event) => updateTransform({ scale: Number(event.target.value) })} /></label>
              <label>Horizontal position<input type="range" min="-1" max="1" step="0.01" value={selected.transform.positionX} onChange={(event) => updateTransform({ positionX: Number(event.target.value) })} /></label>
              <label>Vertical position<input type="range" min="-1" max="1" step="0.01" value={selected.transform.positionY} onChange={(event) => updateTransform({ positionY: Number(event.target.value) })} /></label>
            </>}
          </section>
          <section>
            <h2>Audio</h2>
            <label>Master volume <span>{Math.round(editor.audio.volume * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={editor.audio.volume} onChange={(event) => setEditor({ ...editor, audio: { ...editor.audio, volume: Number(event.target.value) } })} /></label>
            <label className="check-label"><input type="checkbox" checked={editor.audio.muted} onChange={(event) => setEditor({ ...editor, audio: { ...editor.audio, muted: event.target.checked } })} />Mute all</label>
            {selectedAudioClip && <div className="clip-audio-controls">
              <h3>Selected audio clip</h3>
              <label>Volume <span>{Math.round(selectedAudioClip.audio.volume * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={selectedAudioClip.audio.volume} onChange={(event) => updateClipAudio({ volume: Number(event.target.value) })} /></label>
              <label className="check-label"><input type="checkbox" checked={selectedAudioClip.audio.muted} onChange={(event) => updateClipAudio({ muted: event.target.checked })} />Mute clip</label>
              <label>Fade in <span>{selectedAudioClip.audio.fadeIn.toFixed(1)}s</span><input type="range" min="0" max={Math.min(5, audioClipDuration(selectedAudioClip) - selectedAudioClip.audio.fadeOut)} step="0.1" value={selectedAudioClip.audio.fadeIn} onChange={(event) => updateClipAudio({ fadeIn: Number(event.target.value) })} /></label>
              <label>Fade out <span>{selectedAudioClip.audio.fadeOut.toFixed(1)}s</span><input type="range" min="0" max={Math.min(5, audioClipDuration(selectedAudioClip) - selectedAudioClip.audio.fadeIn)} step="0.1" value={selectedAudioClip.audio.fadeOut} onChange={(event) => updateClipAudio({ fadeOut: Number(event.target.value) })} /></label>
            </div>}
            {!selectedAudioClip && selected && selectedSource?.has_audio && <div className="clip-audio-controls">
              <h3>Linked clip audio</h3>
              <label>Volume <span>{Math.round(selected.audio.volume * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={selected.audio.volume} onChange={(event) => updateSegmentAudio({ volume: Number(event.target.value) })} /></label>
              <label className="check-label"><input type="checkbox" checked={selected.audio.muted} onChange={(event) => updateSegmentAudio({ muted: event.target.checked })} />Mute clip</label>
              <label>Fade in <span>{selected.audio.fadeIn.toFixed(1)}s</span><input type="range" min="0" max={Math.min(5, selected.sourceEnd - selected.sourceStart - selected.audio.fadeOut)} step="0.1" value={selected.audio.fadeIn} onChange={(event) => updateSegmentAudio({ fadeIn: Number(event.target.value) })} /></label>
              <label>Fade out <span>{selected.audio.fadeOut.toFixed(1)}s</span><input type="range" min="0" max={Math.min(5, selected.sourceEnd - selected.sourceStart - selected.audio.fadeIn)} step="0.1" value={selected.audio.fadeOut} onChange={(event) => updateSegmentAudio({ fadeOut: Number(event.target.value) })} /></label>
            </div>}
          </section>
          <section>
            <h2>Transition</h2>
            {transition ? <>
              <button
                className="secondary"
                aria-pressed={transition.transitionDuration > 0}
                onClick={() => updateTransition(transition.transitionDuration ? 0 : Math.min(0.5, transitionMax))}
              >{transition.transitionDuration ? "Remove crossfade" : "Add crossfade"}</button>
              {transition.transitionDuration > 0 && <label>Duration <span>{transition.transitionDuration.toFixed(1)}s</span><input type="range" min={MIN_TRANSITION_DURATION} max={transitionMax} step="0.1" value={transition.transitionDuration} onChange={(event) => updateTransition(Number(event.target.value))} /></label>}
            </> : <p className="inspector-hint">Select a cut between clips to add a crossfade.</p>}
          </section>
          <section>
            <h2>Captions</h2>
            <div className="caption-actions">
              <button className="secondary" onClick={addCaption}>Add at playhead</button>
              {caption && <button className="text-button danger" onClick={() => { setEditor({ ...editor, captions: editor.captions.filter((value) => value.id !== caption.id) }); setSelectedCaption(""); }}>Delete caption</button>}
            </div>
            {caption && (
              <div className="caption-editor">
                <textarea aria-label="Caption text" value={caption.text} maxLength={500} onChange={(event) => updateCaption({ text: event.target.value })} />
                <div><label>Start<input type="number" min="0" step="0.1" value={caption.start.toFixed(1)} onChange={(event) => updateCaption({ start: Number(event.target.value) })} /></label><label>End<input type="number" min="0.1" step="0.1" value={caption.end.toFixed(1)} onChange={(event) => updateCaption({ end: Number(event.target.value) })} /></label></div>
              </div>
            )}
            <label>Style<select value={editor.captionStyle.preset} onChange={(event) => setEditor({ ...editor, captionStyle: { ...editor.captionStyle, preset: event.target.value as EditorState["captionStyle"]["preset"] } })}><option value="classic">Classic outline</option><option value="box">Dark box</option><option value="yellow">Yellow outline</option></select></label>
            <label>Font size <span>{editor.captionStyle.fontSize}px</span><input type="range" min="16" max="72" value={editor.captionStyle.fontSize} onChange={(event) => setEditor({ ...editor, captionStyle: { ...editor.captionStyle, fontSize: Number(event.target.value) } })} /></label>
            {caption && <><label>Horizontal position<input type="range" min="0.05" max="0.95" step="0.01" value={caption.positionX} onChange={(event) => updateCaption({ positionX: Number(event.target.value) })} /></label><label>Vertical position<input type="range" min="0.05" max="0.95" step="0.01" value={caption.positionY} onChange={(event) => updateCaption({ positionY: Number(event.target.value) })} /></label></>}
          </section>
        </aside>
      </div>

      <section className="timeline-panel">
        <div className="timeline-toolbar">
          <div><button className="secondary" onClick={split}>Split</button>{selectedAudio ? <button className="text-button danger" onClick={removeSelectedAudio}>Delete audio clip</button> : <button className="text-button danger" onClick={removeSelectedSegment} disabled={editor.segments.length === 1}>Delete segment</button>}</div>
          <span>{formatTime(playhead)} / {formatTime(duration)}</span>
        </div>
        <div className="timeline">
          <input className="timeline-scrubber" aria-label="Timeline playhead" type="range" min="0" max={duration} step="0.01" value={Math.min(playhead, duration)} onChange={(event) => seek(Number(event.target.value))} />
          <div className="timeline-tracks" onClick={seekFromTrack}>
            <span className="track-label">VIDEO</span>
            <div ref={timeline} className="video-track">
              {editor.segments.map((segment, index) => {
                const selected = segment.id === selectedSegment;
                return (
                  <div key={segment.id} role="button" tabIndex={0} className={`segment ${selected ? "selected" : ""}`} style={{ left: timeToPixels(starts[index], duration, timelineWidth), width: Math.max(3, timeToPixels(segment.sourceEnd - segment.sourceStart, duration, timelineWidth)), zIndex: index + 1 }} onClick={(event) => { event.stopPropagation(); setSelectedSegment(segment.id); setSelectedAudio(""); setSelectedTransition(null); const bounds = timeline.current!.getBoundingClientRect(); seek(pixelsToTime(event.clientX - bounds.left, duration, bounds.width)); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { setSelectedSegment(segment.id); setSelectedAudio(""); setSelectedTransition(null); } }}>
                    {selected && <button aria-label="Trim segment start" className="trim-handle start" onPointerDown={(event) => startTrim(event, segment, "start")} onPointerMove={moveTrim} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} />}
                    <span>{media.find((item) => item.id === segment.mediaId)?.name ?? `Clip ${index + 1}`}</span>
                    {selected && <button aria-label="Trim segment end" className="trim-handle end" onPointerDown={(event) => startTrim(event, segment, "end")} onPointerMove={moveTrim} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} />}
                  </div>
                );
              })}
              {editor.segments.slice(1).map((segment, offset) => {
                const index = offset + 1;
                return <button
                  key={`transition-${segment.id}`}
                  className={`transition-marker ${selectedTransition === index ? "selected" : ""} ${segment.transitionDuration ? "active" : ""}`}
                  style={{ left: timeToPixels(starts[index], duration, timelineWidth), width: Math.max(18, timeToPixels(segment.transitionDuration, duration, timelineWidth)) }}
                  aria-label={`Transition into clip ${index + 1}`}
                  onClick={(event) => { event.stopPropagation(); setSelectedTransition(index); seek(starts[index] + segment.transitionDuration / 2); }}
                >{segment.transitionDuration ? "×" : "+"}</button>;
              })}
            </div>
            <span className="track-label">LINKED</span>
            <div className="audio-track linked-audio-track">
              {editor.segments.map((segment, index) => {
                const item = media.find((value) => value.id === segment.mediaId);
                const sourceDuration = item?.metadata?.duration ?? segment.sourceEnd;
                const clipDuration = segment.sourceEnd - segment.sourceStart;
                return <button key={`linked-${segment.id}`} className={`audio-clip linked ${segment.id === selectedSegment ? "selected" : ""}`} style={{ left: timeToPixels(starts[index], duration, timelineWidth), width: Math.max(3, timeToPixels(clipDuration, duration, timelineWidth)) }} onClick={(event) => { event.stopPropagation(); setSelectedSegment(segment.id); setSelectedAudio(""); seek(starts[index]); }}>
                  {item?.metadata?.has_audio && <span className="waveform" style={{ width: `${sourceDuration / clipDuration * 100}%`, left: `${-segment.sourceStart / clipDuration * 100}%`, backgroundImage: `url(${waveformUrl(item)})` }} />}
                  <span className="audio-clip-name">{item?.name}</span>
                </button>;
              })}
            </div>
            {editor.audioTracks.map((track) => <div className="audio-track-row" key={track.id}>
              <div className="track-label audio-track-label"><span title={track.name}>{track.name}</span><button aria-label={`Delete ${track.name}`} onClick={(event) => { event.stopPropagation(); setEditor({ ...editor, audioTracks: editor.audioTracks.filter((value) => value.id !== track.id) }); setSelectedAudio(""); }}>×</button></div>
              <div className="audio-track">
                {track.clips.map((clip) => {
                  const item = media.find((value) => value.id === clip.mediaId);
                  const clipDuration = audioClipDuration(clip);
                  const sourceDuration = item?.metadata?.duration ?? clip.sourceEnd;
                  return <div key={clip.id} role="button" tabIndex={0} className={`audio-clip ${clip.id === selectedAudio ? "selected" : ""}`} style={{ left: timeToPixels(clip.timelineStart, duration, timelineWidth), width: Math.max(3, timeToPixels(clipDuration, duration, timelineWidth)) }} onPointerDown={(event) => startAudioDrag(event, clip, "move")} onPointerMove={moveAudioDrag} onPointerUp={() => setAudioDrag(null)} onPointerCancel={() => setAudioDrag(null)} onClick={(event) => { event.stopPropagation(); setSelectedAudio(clip.id); setSelectedSegment(""); seek(clip.timelineStart); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { setSelectedAudio(clip.id); setSelectedSegment(""); } }}>
                    <span className="waveform" style={{ width: `${sourceDuration / clipDuration * 100}%`, left: `${-clip.sourceStart / clipDuration * 100}%`, backgroundImage: `url(${waveformUrl(item)})` }} />
                    <span className="fade-region start" style={{ width: `${clip.audio.fadeIn / clipDuration * 100}%` }} />
                    <span className="fade-region end" style={{ width: `${clip.audio.fadeOut / clipDuration * 100}%` }} />
                    <span className="audio-clip-name">{item?.name}</span>
                    {clip.id === selectedAudio && <><button aria-label="Trim audio start" className="trim-handle start" onPointerDown={(event) => startAudioDrag(event, clip, "start")} onPointerMove={moveAudioDrag} onPointerUp={() => setAudioDrag(null)} onPointerCancel={() => setAudioDrag(null)} /><button aria-label="Trim audio end" className="trim-handle end" onPointerDown={(event) => startAudioDrag(event, clip, "end")} onPointerMove={moveAudioDrag} onPointerUp={() => setAudioDrag(null)} onPointerCancel={() => setAudioDrag(null)} /></>}
                  </div>;
                })}
              </div>
            </div>)}
            <span className="track-label">CAPTIONS</span>
            <div className="caption-track">
              {editor.captions.map((value) => (
                <button key={value.id} className={value.id === selectedCaption ? "selected" : ""} style={{ left: timeToPixels(value.start, duration, timelineWidth), width: Math.max(3, timeToPixels(value.end - value.start, duration, timelineWidth)) }} onClick={(event) => { event.stopPropagation(); setSelectedCaption(value.id); seek(value.start); }}>{value.text}</button>
              ))}
            </div>
            <div className="playhead-line" aria-hidden="true" style={{ left: 72 + timeToPixels(playhead, duration, timelineWidth) }} />
          </div>
        </div>
      </section>
    </main>
  );
}
