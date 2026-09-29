import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteSegment,
  pixelsToTime,
  projectToSource,
  splitAt,
  timeToPixels,
  trimSegment,
  type Caption,
  type VideoSegment,
} from "./editor-state.ts";

const segments: VideoSegment[] = [
  { id: "a", mediaId: "one", sourceStart: 10, sourceEnd: 20, transform: { scale: 1, positionX: 0, positionY: 0 } },
  { id: "b", mediaId: "two", sourceStart: 30, sourceEnd: 40, transform: { scale: 1.5, positionX: 0.2, positionY: -0.1 } },
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
