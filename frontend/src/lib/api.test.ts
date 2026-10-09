import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, apiRequest } from "./api.ts";

const stored = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
} as Storage;

test("missing saved jobs retain HTTP status for quiet recovery", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ detail: "Job not found" }), { status: 404 }));
  await assert.rejects(apiRequest("/jobs/old"), (error: unknown) => error instanceof ApiError && error.status === 404 && error.message === "Job not found");
});

test("network failures are distinct from ordinary server errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(apiRequest("/ai/models"), (error: unknown) => error instanceof ApiError && error.status === 0);
});

test("non-JSON server failures preserve status and readable messages", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Bad Gateway", { status: 502 }));
  await assert.rejects(apiRequest("/billing/plans"), (error: unknown) => error instanceof ApiError && error.status === 502 && error.message.length > 0);
});

test("expired sessions clear the bearer token", async (t) => {
  stored.set("clipper-session", "expired");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ detail: "Sign in again" }), { status: 401 }));
  await assert.rejects(apiRequest("/auth/me"), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(stored.has("clipper-session"), false);
});

test("successful requests still return their payload", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ models: [] }));
  assert.deepEqual(await apiRequest("/ai/models"), { models: [] });
});
