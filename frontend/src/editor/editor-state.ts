export const MIN_SEGMENT_DURATION = 0.5;
export const MIN_CAPTION_DURATION = 0.1;

export type VideoSegment = {
  id: string;
  mediaId: string;
  sourceStart: number;
  sourceEnd: number;
  transform: { scale: number; positionX: number; positionY: number };
};

export type Caption = {
  id: string;
  start: number;
  end: number;
  text: string;
  positionX: number;
  positionY: number;
};

export type EditorSource =
  | { kind: "upload"; id: string }
  | { kind: "job"; jobId: string };

export type EditorState = {
  segments: VideoSegment[];
  aspectRatio: "9:16" | "16:9" | "1:1";
  captions: Caption[];
  captionStyle: {
    preset: "classic" | "box" | "yellow";
    fontSize: number;
  };
  audio: { volume: number; muted: boolean };
};

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export const timelineDuration = (segments: VideoSegment[]) =>
  segments.reduce((total, segment) => total + segment.sourceEnd - segment.sourceStart, 0);

export function timeToPixels(time: number, duration: number, timelineWidth: number) {
  return duration > 0 && timelineWidth > 0
    ? (clamp(time, 0, duration) / duration) * timelineWidth
    : 0;
}

export function pixelsToTime(x: number, duration: number, timelineWidth: number) {
  return duration > 0 && timelineWidth > 0
    ? (clamp(x, 0, timelineWidth) / timelineWidth) * duration
    : 0;
}

export function projectToSource(segments: VideoSegment[], time: number) {
  if (!segments.length) return null;
  const duration = timelineDuration(segments);
  let remaining = clamp(time, 0, duration);
  let elapsed = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const segmentDuration = segment.sourceEnd - segment.sourceStart;
    if (remaining < segmentDuration || index === segments.length - 1)
      return {
        index,
        sourceTime: Math.min(segment.sourceEnd, segment.sourceStart + remaining),
        segmentStart: elapsed,
      };
    remaining -= segmentDuration;
    elapsed += segmentDuration;
  }
  return null;
}

export function splitAt(
  segments: VideoSegment[],
  time: number,
  id: () => string = () => crypto.randomUUID(),
) {
  const location = projectToSource(segments, time);
  if (!location) return segments;
  const segment = segments[location.index];
  const split = location.sourceTime;
  if (
    split - segment.sourceStart < MIN_SEGMENT_DURATION ||
    segment.sourceEnd - split < MIN_SEGMENT_DURATION
  )
    return segments;
  return segments.flatMap((value, index) =>
    index === location.index
      ? [
          { ...value, id: id(), sourceEnd: split },
          { ...value, id: id(), sourceStart: split },
        ]
      : value,
  );
}

export function removeTimelineRange(captions: Caption[], start: number, end: number) {
  const removed = end - start;
  if (removed <= 0) return captions;
  return captions
    .map((caption) => {
      if (caption.end <= start) return caption;
      if (caption.start >= end)
        return { ...caption, start: caption.start - removed, end: caption.end - removed };
      if (caption.start < start && caption.end > end)
        return { ...caption, end: caption.end - removed };
      if (caption.start < start)
        return { ...caption, end: start };
      if (caption.end > end)
        return { ...caption, start, end: caption.end - removed };
      return null;
    })
    .filter((caption): caption is Caption =>
      Boolean(caption && caption.end - caption.start >= MIN_CAPTION_DURATION),
    );
}

function insertTimelineTime(captions: Caption[], at: number, amount: number) {
  return captions.map((caption) => {
    if (caption.start >= at)
      return { ...caption, start: caption.start + amount, end: caption.end + amount };
    if (caption.end > at) return { ...caption, end: caption.end + amount };
    return caption;
  });
}

export function trimSegment(
  segments: VideoSegment[],
  captions: Caption[],
  id: string,
  edge: "start" | "end",
  sourceTime: number,
  sourceDuration: number,
) {
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) return { segments, captions };
  const segment = segments[index];
  const timelineStart = segments
    .slice(0, index)
    .reduce((total, value) => total + value.sourceEnd - value.sourceStart, 0);
  const next = [...segments];
  let nextCaptions = captions;
  if (edge === "start") {
    const value = clamp(sourceTime, 0, segment.sourceEnd - MIN_SEGMENT_DURATION);
    const difference = value - segment.sourceStart;
    next[index] = { ...segment, sourceStart: value };
    nextCaptions =
      difference >= 0
        ? removeTimelineRange(captions, timelineStart, timelineStart + difference)
        : insertTimelineTime(captions, timelineStart, -difference);
  } else {
    const value = clamp(sourceTime, segment.sourceStart + MIN_SEGMENT_DURATION, sourceDuration);
    const oldTimelineEnd = timelineStart + segment.sourceEnd - segment.sourceStart;
    const difference = value - segment.sourceEnd;
    next[index] = { ...segment, sourceEnd: value };
    nextCaptions =
      difference <= 0
        ? removeTimelineRange(captions, oldTimelineEnd + difference, oldTimelineEnd)
        : insertTimelineTime(captions, oldTimelineEnd, difference);
  }
  return { segments: next, captions: nextCaptions };
}

export function deleteSegment(segments: VideoSegment[], captions: Caption[], id: string) {
  if (segments.length === 1) return { segments, captions };
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) return { segments, captions };
  const start = segments
    .slice(0, index)
    .reduce((total, segment) => total + segment.sourceEnd - segment.sourceStart, 0);
  const end = start + segments[index].sourceEnd - segments[index].sourceStart;
  return {
    segments: segments.filter((segment) => segment.id !== id),
    captions: removeTimelineRange(captions, start, end),
  };
}

export function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  return `${minutes}:${remainder.toString().padStart(2, "0")}.${tenths}`;
}
