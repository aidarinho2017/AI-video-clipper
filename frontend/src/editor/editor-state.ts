export const MIN_SEGMENT_DURATION = 0.5;
export const MIN_CAPTION_DURATION = 0.1;
export const MIN_TRANSITION_DURATION = 0.1;
export const MAX_TRANSITION_DURATION = 1.5;

export type VideoSegment = {
  id: string;
  mediaId: string;
  sourceStart: number;
  sourceEnd: number;
  transitionDuration: number;
  transform: { scale: number; positionX: number; positionY: number };
  audio: ClipAudio;
};

export type ClipAudio = {
  volume: number;
  muted: boolean;
  fadeIn: number;
  fadeOut: number;
};

export type AudioClip = {
  id: string;
  mediaId: string;
  timelineStart: number;
  sourceStart: number;
  sourceEnd: number;
  audio: ClipAudio;
};

export type AudioTrack = { id: string; name: string; clips: AudioClip[] };

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
  audioTracks: AudioTrack[];
};

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const segmentDuration = (segment: VideoSegment) => segment.sourceEnd - segment.sourceStart;
export const audioClipDuration = (clip: AudioClip) => clip.sourceEnd - clip.sourceStart;

const clampFades = (audio: ClipAudio, duration: number): ClipAudio => {
  const fadeIn = Math.min(audio.fadeIn, duration);
  return { ...audio, fadeIn, fadeOut: Math.min(audio.fadeOut, duration - fadeIn) };
};

export function clipAudioGain(audio: ClipAudio, elapsed: number, duration: number) {
  if (audio.muted) return 0;
  const fadeIn = audio.fadeIn ? clamp(elapsed / audio.fadeIn, 0, 1) : 1;
  const fadeOut = audio.fadeOut ? clamp((duration - elapsed) / audio.fadeOut, 0, 1) : 1;
  return audio.volume * Math.min(fadeIn, fadeOut);
}

export function audioGainAt(clip: AudioClip, time: number) {
  return clipAudioGain(clip.audio, time - clip.timelineStart, audioClipDuration(clip));
}

export function splitAudioClip(tracks: AudioTrack[], clipId: string, time: number, id = () => crypto.randomUUID()) {
  return tracks.map((track) => ({ ...track, clips: track.clips.flatMap((clip) => {
    if (clip.id !== clipId) return clip;
    const offset = time - clip.timelineStart;
    if (offset < MIN_CAPTION_DURATION || audioClipDuration(clip) - offset < MIN_CAPTION_DURATION) return clip;
    const sourceTime = clip.sourceStart + offset;
    return [
      { ...clip, id: id(), sourceEnd: sourceTime, audio: { ...clip.audio, fadeOut: 0 } },
      { ...clip, id: id(), timelineStart: time, sourceStart: sourceTime, audio: { ...clip.audio, fadeIn: 0 } },
    ];
  }) }));
}

export function deleteAudioClip(tracks: AudioTrack[], clipId: string) {
  return tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }));
}

export function moveAudioClip(tracks: AudioTrack[], clipId: string, requested: number, projectDuration: number) {
  return tracks.map((track) => {
    const ordered = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
    const index = ordered.findIndex((clip) => clip.id === clipId);
    if (index < 0) return track;
    const clip = ordered[index];
    const minimum = index ? ordered[index - 1].timelineStart + audioClipDuration(ordered[index - 1]) : 0;
    const maximum = Math.min(
      projectDuration - audioClipDuration(clip),
      index + 1 < ordered.length ? ordered[index + 1].timelineStart - audioClipDuration(clip) : projectDuration,
    );
    const timelineStart = clamp(requested, minimum, Math.max(minimum, maximum));
    return { ...track, clips: track.clips.map((value) => value.id === clipId ? { ...value, timelineStart } : value) };
  });
}

export function trimAudioClip(
  tracks: AudioTrack[], clipId: string, edge: "start" | "end", requestedSourceTime: number,
  sourceDuration: number, projectDuration: number,
) {
  return tracks.map((track) => {
    const ordered = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
    const index = ordered.findIndex((clip) => clip.id === clipId);
    if (index < 0) return track;
    const clip = ordered[index];
    let next: AudioClip;
    if (edge === "start") {
      const previousEnd = index ? ordered[index - 1].timelineStart + audioClipDuration(ordered[index - 1]) : 0;
      const earliestSource = clip.sourceStart + previousEnd - clip.timelineStart;
      const sourceStart = clamp(requestedSourceTime, Math.max(0, earliestSource), clip.sourceEnd - MIN_CAPTION_DURATION);
      const timelineStart = clip.timelineStart + sourceStart - clip.sourceStart;
      next = { ...clip, sourceStart, timelineStart, audio: clampFades(clip.audio, clip.sourceEnd - sourceStart) };
    } else {
      const nextStart = index + 1 < ordered.length ? ordered[index + 1].timelineStart : projectDuration;
      const maximum = Math.min(sourceDuration, clip.sourceStart + nextStart - clip.timelineStart);
      const sourceEnd = clamp(requestedSourceTime, clip.sourceStart + MIN_CAPTION_DURATION, maximum);
      next = { ...clip, sourceEnd, audio: clampFades(clip.audio, sourceEnd - clip.sourceStart) };
    }
    return { ...track, clips: track.clips.map((value) => value.id === clipId ? next : value) };
  });
}

export function removeAudioTimelineRange(tracks: AudioTrack[], start: number, end: number, id = () => crypto.randomUUID()) {
  const removed = end - start;
  if (removed <= 0) return tracks;
  return tracks.map((track) => ({ ...track, clips: track.clips.flatMap((clip) => {
    const clipEnd = clip.timelineStart + audioClipDuration(clip);
    if (clipEnd <= start) return clip;
    if (clip.timelineStart >= end) return { ...clip, timelineStart: clip.timelineStart - removed };
    if (clip.timelineStart < start && clipEnd > end) {
      const leftDuration = start - clip.timelineStart;
      const rightSourceStart = clip.sourceStart + end - clip.timelineStart;
      return [
        { ...clip, id: id(), sourceEnd: clip.sourceStart + leftDuration, audio: clampFades({ ...clip.audio, fadeOut: 0 }, leftDuration) },
        { ...clip, id: id(), timelineStart: start, sourceStart: rightSourceStart, audio: clampFades({ ...clip.audio, fadeIn: 0 }, clipEnd - end) },
      ];
    }
    if (clip.timelineStart < start) {
      const duration = start - clip.timelineStart;
      return duration >= MIN_CAPTION_DURATION
        ? { ...clip, sourceEnd: clip.sourceStart + duration, audio: clampFades({ ...clip.audio, fadeOut: 0 }, duration) }
        : [];
    }
    if (clipEnd > end) {
      const duration = clipEnd - end;
      return duration >= MIN_CAPTION_DURATION
        ? { ...clip, timelineStart: start, sourceStart: clip.sourceEnd - duration, audio: clampFades({ ...clip.audio, fadeIn: 0 }, duration) }
        : [];
    }
    return [];
  }) }));
}

export function insertAudioTimelineTime(tracks: AudioTrack[], at: number, amount: number, id = () => crypto.randomUUID()) {
  if (amount <= 0) return tracks;
  return tracks.map((track) => ({ ...track, clips: track.clips.flatMap((clip) => {
    const end = clip.timelineStart + audioClipDuration(clip);
    if (clip.timelineStart >= at) return { ...clip, timelineStart: clip.timelineStart + amount };
    if (end <= at) return clip;
    const leftDuration = at - clip.timelineStart;
    return [
      { ...clip, id: id(), sourceEnd: clip.sourceStart + leftDuration, audio: clampFades({ ...clip.audio, fadeOut: 0 }, leftDuration) },
      { ...clip, id: id(), timelineStart: at + amount, sourceStart: clip.sourceStart + leftDuration, audio: clampFades({ ...clip.audio, fadeIn: 0 }, end - at) },
    ];
  }) }));
}

export const timelineDuration = (segments: VideoSegment[]) =>
  segments.reduce((total, segment, index) =>
    total + segmentDuration(segment) - (index ? segment.transitionDuration : 0), 0);

export function segmentStarts(segments: VideoSegment[]) {
  const starts: number[] = [];
  let cursor = 0;
  for (const [index, segment] of segments.entries()) {
    if (index) cursor -= segment.transitionDuration;
    starts.push(cursor);
    cursor += segmentDuration(segment);
  }
  return starts;
}

export type TimelineLayer = {
  index: number;
  sourceTime: number;
  segmentStart: number;
  opacity: number;
};

export function projectLayers(segments: VideoSegment[], time: number): TimelineLayer[] {
  if (!segments.length) return [];
  const starts = segmentStarts(segments);
  const safeTime = clamp(time, 0, timelineDuration(segments));
  const layers = segments.flatMap((segment, index) => {
    const start = starts[index];
    const end = start + segmentDuration(segment);
    if (safeTime < start || safeTime > end || (safeTime === end && index < segments.length - 1)) return [];
    let opacity = 1;
    if (index && segment.transitionDuration && safeTime < start + segment.transitionDuration)
      opacity = clamp((safeTime - start) / segment.transitionDuration, 0, 1);
    const next = segments[index + 1];
    if (next?.transitionDuration) {
      const transitionStart = starts[index + 1];
      if (safeTime >= transitionStart)
        opacity = 1 - clamp((safeTime - transitionStart) / next.transitionDuration, 0, 1);
    }
    return [{
      index,
      sourceTime: Math.min(segment.sourceEnd, segment.sourceStart + safeTime - start),
      segmentStart: start,
      opacity,
    }];
  });
  return layers.length ? layers : [{
    index: segments.length - 1,
    sourceTime: segments.at(-1)!.sourceEnd,
    segmentStart: starts.at(-1)!,
    opacity: 1,
  }];
}

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
  const layers = projectLayers(segments, time);
  if (!layers.length) return null;
  const best = layers.reduce((current, layer) => layer.opacity >= current.opacity ? layer : current);
  return { index: best.index, sourceTime: best.sourceTime, segmentStart: best.segmentStart };
}

export function transitionLimit(segments: VideoSegment[], index: number) {
  if (index <= 0 || index >= segments.length) return 0;
  return Math.min(
    MAX_TRANSITION_DURATION,
    segmentDuration(segments[index - 1]) / 2,
    segmentDuration(segments[index]) / 2,
  );
}

export function setTransition(
  segments: VideoSegment[],
  captions: Caption[],
  index: number,
  requested: number,
) {
  if (index <= 0 || index >= segments.length) return { segments, captions };
  const oldDuration = segments[index].transitionDuration;
  const limit = transitionLimit(segments, index);
  const duration = requested < MIN_TRANSITION_DURATION ? 0 : clamp(requested, MIN_TRANSITION_DURATION, limit);
  if (duration === oldDuration) return { segments, captions };
  const junction = segmentStarts(segments)[index] + oldDuration;
  const next = segments.map((segment, segmentIndex) =>
    segmentIndex === index ? { ...segment, transitionDuration: duration } : segment,
  );
  const difference = duration - oldDuration;
  return {
    segments: next,
    captions: difference > 0
      ? removeTimelineRange(captions, junction, junction + difference)
      : insertTimelineTime(captions, junction, -difference),
  };
}

function normalizeTransitions(segments: VideoSegment[], captions: Caption[]) {
  let result = { segments, captions };
  for (let index = 1; index < result.segments.length; index++) {
    const limit = transitionLimit(result.segments, index);
    if (result.segments[index].transitionDuration > limit)
      result = setTransition(result.segments, result.captions, index, limit);
  }
  return result;
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
          { ...value, id: id(), sourceEnd: split, audio: clampFades({ ...value.audio, fadeOut: 0 }, split - value.sourceStart) },
          { ...value, id: id(), sourceStart: split, transitionDuration: 0, audio: clampFades({ ...value.audio, fadeIn: 0 }, value.sourceEnd - split) },
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
  const timelineStart = segmentStarts(segments)[index];
  const next = [...segments];
  let nextCaptions = captions;
  if (edge === "start") {
    const value = clamp(sourceTime, 0, segment.sourceEnd - MIN_SEGMENT_DURATION);
    const difference = value - segment.sourceStart;
    next[index] = { ...segment, sourceStart: value, audio: clampFades(segment.audio, segment.sourceEnd - value) };
    nextCaptions =
      difference >= 0
        ? removeTimelineRange(captions, timelineStart, timelineStart + difference)
        : insertTimelineTime(captions, timelineStart, -difference);
  } else {
    const value = clamp(sourceTime, segment.sourceStart + MIN_SEGMENT_DURATION, sourceDuration);
    const oldTimelineEnd = timelineStart + segment.sourceEnd - segment.sourceStart;
    const difference = value - segment.sourceEnd;
    next[index] = { ...segment, sourceEnd: value, audio: clampFades(segment.audio, value - segment.sourceStart) };
    nextCaptions =
      difference <= 0
        ? removeTimelineRange(captions, oldTimelineEnd + difference, oldTimelineEnd)
        : insertTimelineTime(captions, oldTimelineEnd, difference);
  }
  return normalizeTransitions(next, nextCaptions);
}

export function deleteSegment(segments: VideoSegment[], captions: Caption[], id: string) {
  if (segments.length === 1) return { segments, captions };
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) return { segments, captions };
  const start = segmentStarts(segments)[index];
  const next = segments.filter((segment) => segment.id !== id).map((segment, nextIndex) =>
    nextIndex === index ? { ...segment, transitionDuration: 0 } : segment,
  );
  const removed = timelineDuration(segments) - timelineDuration(next);
  return {
    segments: next,
    captions: removeTimelineRange(captions, start, start + removed),
  };
}

export function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  return `${minutes}:${remainder.toString().padStart(2, "0")}.${tenths}`;
}
