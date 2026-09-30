import assert from "node:assert/strict";
import test from "node:test";

import {
  type AudioTrack,
  deleteSegment,
  insertAudioTimelineTime,
  moveAudioClip,
  pixelsToTime,
  projectLayers,
  projectToSource,
  setTransition,
  splitAudioClip,
  splitAt,
  timeToPixels,
  timelineDuration,
  trimSegment,
  removeAudioTimelineRange,
  type Caption,
  type VideoSegment,
} from "./editor-state.ts";

const segments: VideoSegment[] = [
  { id: "a", mediaId: "one", sourceStart: 10, sourceEnd: 20, transitionDuration: 0, transform: { scale: 1, positionX: 0, positionY: 0 }, audio: { volume: 1, muted: false, fadeIn: 0, fadeOut: 0 } },
  { id: "b", mediaId: "two", sourceStart: 30, sourceEnd: 40, transitionDuration: 0, transform: { scale: 1.5, positionX: 0.2, positionY: -0.1 }, audio: { volume: 1, muted: false, fadeIn: 0, fadeOut: 0 } },
];
const captions: Caption[] = [{ id: "c", start: 12, end: 15, text: "Later", positionX: 0.5, positionY: 0.82 }];

test("maps timeline time and pixels with clamping", () => {
  assert.equal(timeToPixels(5, 10, 200), 100);
  assert.equal(timeToPixels(20, 10, 200), 200);
  assert.equal(pixelsToTime(50, 10, 200), 2.5);
  assert.equal(pixelsToTime(-1, 10, 200), 0);
});

test("maps project time through removed source ranges", () => {
  assert.deepEqual(projectToSource(segments, 12), {
    index: 1,
    sourceTime: 32,
    segmentStart: 10,
  });
});

test("splits only when both resulting segments are usable", () => {
  const split = splitAt(segments, 5, (() => {
    let value = 0;
    return () => `new-${value++}`;
  })());
  assert.deepEqual(split.slice(0, 2).map(({ sourceStart, sourceEnd }) => [sourceStart, sourceEnd]), [[10, 15], [15, 20]]);
  assert.equal(splitAt(segments, 0.1), segments);
});

test("trim and delete close timeline gaps and retime captions", () => {
  const trimmed = trimSegment(segments, captions, "a", "end", 18, 50);
  assert.deepEqual(trimmed.segments[0], { ...segments[0], sourceEnd: 18 });
  assert.deepEqual(trimmed.captions[0], { ...captions[0], start: 10, end: 13 });
  const deleted = deleteSegment(segments, captions, "a");
  assert.deepEqual(deleted.segments, [segments[1]]);
  assert.deepEqual(deleted.captions[0], { ...captions[0], start: 2, end: 5 });
});

test("trims clips independently across different source videos", () => {
  const trimmed = trimSegment(segments, captions, "b", "start", 5, 50);
  assert.equal(trimmed.segments[1].sourceStart, 5);
  assert.equal(trimmed.segments[1].mediaId, "two");
});

test("crossfades overlap adjacent clips and shorten the timeline", () => {
  const result = setTransition(segments, captions, 1, 0.5);
  assert.equal(timelineDuration(result.segments), 19.5);
  assert.equal(result.segments[1].transitionDuration, 0.5);
  const layers = projectLayers(result.segments, 9.75);
  assert.equal(layers.length, 2);
  assert.deepEqual(layers.map(({ index, opacity }) => [index, opacity]), [[0, 0.5], [1, 0.5]]);
  assert.equal(projectLayers(result.segments, 10)[0].index, 1);
});

test("transition changes keep downstream captions on the shortened timeline", () => {
  const later: Caption[] = [{ ...captions[0], start: 11, end: 13 }];
  const result = setTransition(segments, later, 1, 0.5);
  assert.deepEqual(result.captions[0], { ...later[0], start: 10.5, end: 12.5 });
  const restored = setTransition(result.segments, result.captions, 1, 0);
  assert.deepEqual(restored.captions[0], later[0]);
});

const audioTracks: AudioTrack[] = [{ id: "track", name: "Music", clips: [{
  id: "music", mediaId: "audio", timelineStart: 2, sourceStart: 10, sourceEnd: 18,
  audio: { volume: 0.8, muted: false, fadeIn: 1, fadeOut: 1 },
}] }];

test("splits and clamps movable audio clips", () => {
  let value = 0;
  const split = splitAudioClip(audioTracks, "music", 6, () => `audio-${value++}`);
  assert.deepEqual(split[0].clips.map((clip) => [clip.timelineStart, clip.sourceStart, clip.sourceEnd]), [[2, 10, 14], [6, 14, 18]]);
  const moved = moveAudioClip(split, "audio-1", 3, 20);
  assert.equal(moved[0].clips[1].timelineStart, 6);
});

test("ripples standalone audio through removed and inserted timeline time", () => {
  let value = 0;
  const removed = removeAudioTimelineRange(audioTracks, 5, 7, () => `r-${value++}`);
  assert.deepEqual(removed[0].clips.map((clip) => [clip.timelineStart, clip.sourceStart, clip.sourceEnd]), [[2, 10, 13], [5, 15, 18]]);
  const inserted = insertAudioTimelineTime(removed, 5, 2, () => `i-${value++}`);
  assert.equal(inserted[0].clips[1].timelineStart, 7);
});
