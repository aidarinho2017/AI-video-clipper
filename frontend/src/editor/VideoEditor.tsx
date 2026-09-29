"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  MIN_CAPTION_DURATION,
  clamp,
  type Caption,
  deleteSegment,
  type EditorState,
  type EditorSource,
  formatTime,
  pixelsToTime,
  projectToSource,
  splitAt,
  timeToPixels,
  timelineDuration,
  trimSegment,
  type VideoSegment,
} from "./editor-state";

const API = "http://localhost:8000";
const OUTPUT_HEIGHT = { "9:16": 1280, "16:9": 720, "1:1": 720 } as const;

type SourceMetadata = {
  duration: number;
  width: number;
  height: number;
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

const defaultTransform = () => ({ scale: 1, positionX: 0, positionY: 0 });

function initialEditor(mediaId: string, start: number, end: number): EditorState {
  return {
    segments: [{ id: crypto.randomUUID(), mediaId, sourceStart: start, sourceEnd: end, transform: defaultTransform() }],
    aspectRatio: "9:16",
    captions: [],
    captionStyle: { preset: "classic", fontSize: 36 },
    audio: { volume: 1, muted: false },
  };
}

async function jsonRequest(path: string, options?: RequestInit) {
  const response = await fetch(`${API}${path}`, options);
  const data = await response.json();
  if (!response.ok)
    throw new Error(typeof data.detail === "string" ? data.detail : "Request failed.");
  return data;
}

export default function VideoEditor({ jobId, clipIndex }: { jobId?: string; clipIndex?: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const activeSegment = useRef(0);
  const frame = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const playIntent = useRef(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedSegment, setSelectedSegment] = useState("");
  const [selectedCaption, setSelectedCaption] = useState("");
  const [timelineWidth, setTimelineWidth] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
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
  const activeMedia = media.find((item) => item.id === active?.mediaId);
  const source = activeMedia?.metadata ?? null;
  const selected = editor?.segments.find((segment) => segment.id === selectedSegment);

  const seek = useCallback(
    (time: number) => {
      if (!editor || !video.current) return;
      const location = projectToSource(editor.segments, time);
      if (!location) return;
      activeSegment.current = location.index;
      setActiveIndex(location.index);
      pendingSeek.current = location.sourceTime;
      if (video.current.dataset.mediaId === editor.segments[location.index].mediaId) {
        video.current.currentTime = location.sourceTime;
        pendingSeek.current = null;
      }
      setPlayhead(Math.min(time, timelineDuration(editor.segments)));
    },
    [editor],
  );

  useEffect(() => {
    if (!playing || !editor) return;
    const tick = () => {
      const element = video.current;
      if (!element) return;
      const segment = editor.segments[activeSegment.current];
      if (!segment) return;
      if (element.currentTime >= segment.sourceEnd - 0.025) {
        const next = activeSegment.current + 1;
        if (next >= editor.segments.length) {
          playIntent.current = false;
          element.pause();
          setPlayhead(timelineDuration(editor.segments));
          return;
        }
        activeSegment.current = next;
        setActiveIndex(next);
        pendingSeek.current = editor.segments[next].sourceStart;
        setPlayhead(editor.segments.slice(0, next).reduce((total, value) => total + value.sourceEnd - value.sourceStart, 0));
        return;
      }
      const elapsed = editor.segments
        .slice(0, activeSegment.current)
        .reduce((total, value) => total + value.sourceEnd - value.sourceStart, 0);
      setPlayhead(elapsed + element.currentTime - editor.segments[activeSegment.current].sourceStart);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, editor]);

  const volume = editor?.audio.volume;
  const muted = editor?.audio.muted;
  useEffect(() => {
    if (video.current && editor) {
      video.current.volume = volume ?? 1;
      video.current.muted = muted ?? false;
    }
  }, [editor, volume, muted]);

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

  async function upload(files?: FileList | null) {
    if (!files?.length) return;
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
        imported.push({ id: crypto.randomUUID(), name: file.name, source: { kind: "upload", id: metadata.id }, url: `${API}/editor/sources/${metadata.id}`, metadata });
      }
      setMedia((current) => [...current, ...imported]);
      if (!editor && imported[0]) {
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
    if (!editor || !item.metadata) return;
    const segment = { id: crypto.randomUUID(), mediaId: item.id, sourceStart: 0, sourceEnd: item.metadata.duration, transform: defaultTransform() };
    activeSegment.current = editor.segments.length;
    setActiveIndex(editor.segments.length);
    pendingSeek.current = 0;
    setEditor({ ...editor, segments: [...editor.segments, segment] });
    setSelectedSegment(segment.id);
    setPlayhead(duration);
  }

  function togglePlayback() {
    const element = video.current;
    if (!element || !editor) return;
    if (!element.paused) {
      playIntent.current = false;
      element.pause();
      return;
    }
    if (playhead >= duration - 0.01) seek(0);
    playIntent.current = true;
    element.play().catch(() => setError("The browser could not play this video."));
  }

  function split() {
    if (!editor) return;
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    let index = 0;
    const segments = splitAt(editor.segments, playhead, () => ids[index++]);
    if (segments === editor.segments) return;
    setEditor({ ...editor, segments });
    setSelectedSegment(ids[1]);
  }

  function removeSelectedSegment() {
    if (!editor || !selectedSegment) return;
    const selectedIndex = editor.segments.findIndex((value) => value.id === selectedSegment);
    const result = deleteSegment(editor.segments, editor.captions, selectedSegment);
    if (result.segments === editor.segments) return;
    setEditor({ ...editor, ...result });
    setSelectedSegment(result.segments[Math.min(selectedIndex, result.segments.length - 1)].id);
    const nextPlayhead = Math.min(playhead, timelineDuration(result.segments));
    const location = projectToSource(result.segments, nextPlayhead);
    if (location && video.current) {
      activeSegment.current = location.index;
      setActiveIndex(location.index);
      video.current.currentTime = location.sourceTime;
    }
    setPlayhead(nextPlayhead);
  }

  function startTrim(event: React.PointerEvent, segment: VideoSegment, edge: "start" | "end") {
    if (!editor || !timeline.current) return;
    event.stopPropagation();
    video.current?.pause();
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
    setEditor({ ...drag.editor, ...result });
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

  function moveCrop(event: React.PointerEvent) {
    if (!cropDrag || !selected) return;
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
  const exportIsCurrent = exportStatus === "completed" && exportSnapshot === JSON.stringify(editor);
  const transform = active?.transform ?? defaultTransform();
  const baseScale = source && viewportSize.width
    ? Math.max(viewportSize.width / source.width, viewportSize.height / source.height) * transform.scale
    : 1;
  const renderedWidth = source ? source.width * baseScale : viewportSize.width;
  const renderedHeight = source ? source.height * baseScale : viewportSize.height;
  const videoStyle = {
    width: renderedWidth,
    height: renderedHeight,
    left: -(renderedWidth - viewportSize.width) * ((transform.positionX + 1) / 2),
    top: -(renderedHeight - viewportSize.height) * ((transform.positionY + 1) / 2),
  };

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
      <div className="editor-workspace">
        <aside className="media-bin">
          <div className="media-bin-header"><h2>Videos</h2><label className="secondary file-button">{busy ? "Importing…" : "+ Import"}<input type="file" accept="video/*" multiple disabled={busy} onChange={(event) => upload(event.target.files)} /></label></div>
          <div className="media-list">
            {media.map((item) => (
              <article key={item.id} className={item.id === active?.mediaId ? "active" : ""}>
                <strong title={item.name}>{item.name}</strong>
                <span>{item.metadata ? formatTime(item.metadata.duration) : "Loading…"}</span>
                <button className="text-button" disabled={!item.metadata} onClick={() => addMedia(item)}>Add to timeline</button>
              </article>
            ))}
          </div>
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
            <video
              key={activeMedia?.id}
              ref={video}
              src={activeMedia?.url}
              data-media-id={activeMedia?.id}
              playsInline
              preload="metadata"
              style={videoStyle}
              onLoadedMetadata={(event) => {
                const element = event.currentTarget;
                setMedia((current) => current.map((item) => item.id === activeMedia?.id ? { ...item, metadata: item.metadata ?? { duration: element.duration, width: element.videoWidth, height: element.videoHeight, has_audio: true } } : item));
                if (pendingSeek.current !== null) {
                  element.currentTime = pendingSeek.current;
                  pendingSeek.current = null;
                } else if (active) element.currentTime = active.sourceStart;
                if (playIntent.current) element.play().catch(() => setError("The browser could not play this video."));
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => { if (!playIntent.current) setPlaying(false); }}
            />
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
            <label>Volume <span>{Math.round(editor.audio.volume * 100)}%</span><input type="range" min="0" max="1" step="0.01" disabled={!source?.has_audio} value={editor.audio.volume} onChange={(event) => setEditor({ ...editor, audio: { ...editor.audio, volume: Number(event.target.value) } })} /></label>
            <label className="check-label"><input type="checkbox" disabled={!source?.has_audio} checked={editor.audio.muted} onChange={(event) => setEditor({ ...editor, audio: { ...editor.audio, muted: event.target.checked } })} />Mute</label>
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
          <div><button className="secondary" onClick={split}>Split</button><button className="text-button danger" onClick={removeSelectedSegment} disabled={editor.segments.length === 1}>Delete segment</button></div>
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
                  <div key={segment.id} role="button" tabIndex={0} className={`segment ${selected ? "selected" : ""}`} style={{ width: `${((segment.sourceEnd - segment.sourceStart) / duration) * 100}%` }} onClick={(event) => { event.stopPropagation(); setSelectedSegment(segment.id); const bounds = timeline.current!.getBoundingClientRect(); seek(pixelsToTime(event.clientX - bounds.left, duration, bounds.width)); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedSegment(segment.id); }}>
                    {selected && <button aria-label="Trim segment start" className="trim-handle start" onPointerDown={(event) => startTrim(event, segment, "start")} onPointerMove={moveTrim} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} />}
                    <span>{media.find((item) => item.id === segment.mediaId)?.name ?? `Clip ${index + 1}`}</span>
                    {selected && <button aria-label="Trim segment end" className="trim-handle end" onPointerDown={(event) => startTrim(event, segment, "end")} onPointerMove={moveTrim} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} />}
                  </div>
                );
              })}
            </div>
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
