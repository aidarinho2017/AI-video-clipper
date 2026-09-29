"use client";

import { useEffect, useState } from "react";

const API = "http://localhost:8000";
const STORAGE = "clipper-job";
const stages = [
  ["downloading", "Downloading video"],
  ["preparing", "Preparing audio"],
  ["analyzing", "Analyzing & finding moments"],
  ["ranking", "Scoring clips"],
  ["rendering", "Cutting & preparing vertical videos"],
];
type Clip = {
  index: number;
  start: number;
  end: number;
  title: string;
  reasoning: string;
  virality_score: number;
  hook_score: number;
  emotion_score: number;
  standalone_score: number;
  insight_score: number;
};
type Job = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  stage: string;
  completed_clips: number;
  clips: Clip[];
  error: string | null;
};
type ModelOption = {
  id: string;
  label: string;
  provider: string;
  tier: string;
  configured: boolean;
};
type ModelCatalog = {
  default_model: string;
  models: ModelOption[];
};

async function request<T = Job>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...options,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(
      "Cannot reach the backend. Make sure it is running on localhost:8000.",
    );
  }
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Invalid request. Check the YouTube URL and try again.",
    );
  return data;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  const [restore, setRestore] = useState(0);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("gemini-fast");
  const [instructions, setInstructions] = useState("");

  useEffect(() => {
    request<ModelCatalog>("/ai/models")
      .then((catalog) => {
        setModels(catalog.models);
        const defaultModel = catalog.models.find(
          (item) => item.id === catalog.default_model && item.configured,
        );
        setModel(
          defaultModel?.id ??
            catalog.models.find((item) => item.configured)?.id ??
            catalog.default_model,
        );
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const id = localStorage.getItem(STORAGE);
    if (!id) return;
    let active = true;
    request(`/jobs/${id}`)
      .then((data) => {
        if (active) {
          setJob(data);
          setError("");
        }
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [restore]);

  const jobId = job?.id;
  const processing = job?.status === "queued" || job?.status === "processing";
  useEffect(() => {
    if (!jobId || !processing) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await request(`/jobs/${jobId}`);
        if (active) {
          setJob(data);
          setError("");
        }
      } catch (err) {
        if (active) setError((err as Error).message);
      }
      if (active) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, processing]);

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await request("/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          youtube_url: url,
          model,
          instructions,
        }),
      });
      localStorage.setItem(STORAGE, data.id);
      setJob(data);
      setSelected(0);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    localStorage.removeItem(STORAGE);
    setJob(null);
    setError("");
    setSelected(0);
  }
  const clip = job?.clips[selected];

  return (
    <main className={job?.status === "completed" ? "results-shell" : "shell"}>
      <div className="ambient" aria-hidden="true" />
      {error && (
        <div role="alert" className="error">
          {error}{" "}
          {!processing && (
            <button
              className="text-button"
              onClick={() => setRestore((v) => v + 1)}
            >
              Retry connection
            </button>
          )}
        </div>
      )}
      {!job && (
        <section className="intro">
          <h1>
            Turn long videos
            <br />
            into <span>viral clips.</span>
          </h1>
          <form onSubmit={generate}>
            <label className="sr-only" htmlFor="youtube-url">
              YouTube video URL
            </label>
            <div className="input-wrap">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="m10 14 4-4M8 16l-1 1a4.24 4.24 0 0 1-6-6l4-4a4.24 4.24 0 0 1 6 0m2 10a4.24 4.24 0 0 0 6 0l4-4a4.24 4.24 0 0 0-6-6l-1 1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  transform="translate(1 0) scale(.9)"
                />
              </svg>
              <input
                id="youtube-url"
                type="url"
                required
                autoComplete="off"
                placeholder="Paste YouTube URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy}
              />
            </div>
            <fieldset className="generation-settings" disabled={busy}>
              <legend>Clip settings</legend>
              <label htmlFor="ai-model">AI model</label>
              <select
                id="ai-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.configured}>
                    {item.label} · {item.tier}
                    {item.configured ? "" : ` · add ${item.provider.toUpperCase()}_API_KEY`}
                  </option>
                ))}
              </select>
              <label htmlFor="clip-wishes">Clip wishes</label>
              <textarea
                id="clip-wishes"
                maxLength={2000}
                rows={4}
                placeholder="Topics to prioritize, tone, audience, or moments to avoid…"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <small>{instructions.length}/2000</small>
            </fieldset>
            <button
              className="primary"
              disabled={busy || !models.some((item) => item.id === model && item.configured)}
            >
              {busy ? "Starting…" : "Generate Clips"}
              <span aria-hidden="true">↗</span>
            </button>
            <a className="secondary editor-entry" href="/editor">
              Open video editor
            </a>
          </form>
        </section>
      )}
      {processing && (
        <section className="processing panel" aria-live="polite">
          <div className="eyebrow">YOUR NEXT FIVE CLIPS</div>
          <h1>
            Good moments.
            <br />
            <span>Worth sharing.</span>
          </h1>
          <p>Finding the strongest parts of your conversation.</p>
          <ol className="stages">
            {stages.map(([id, label], index) => {
              const current = stages.findIndex(([s]) => s === job.stage);
              return (
                <li
                  key={id}
                  className={
                    index === current ? "active" : index < current ? "done" : ""
                  }
                >
                  <span
                    className={index === current ? "spinner" : "stage-icon"}
                  >
                    {index < current ? "✓" : index > current ? "○" : ""}
                  </span>
                  {label}
                  {id === "rendering" && index === current && (
                    <small>{job.completed_clips}/5</small>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="footnote">
            You can refresh this page. Keep the backend running.
          </p>
        </section>
      )}
      {job?.status === "failed" && (
        <section className="panel failure">
          <div className="eyebrow">PROCESSING STOPPED</div>
          <h1>Let’s try again.</h1>
          <p role="alert">{job.error}</p>
          <button className="primary" onClick={reset}>
            Back to input <span>↗</span>
          </button>
        </section>
      )}
      {job?.status === "completed" && clip && (
        <section className="results">
          <header>
            <div>
              <div className="eyebrow">FROM LONG-FORM TO SHORT-FORM</div>
              <h1>Your best moments.</h1>
            </div>
            <button className="secondary" onClick={reset}>
              New video ↗
            </button>
          </header>
          <div className="result-grid">
            <div className="preview">
              <video
                key={`${job.id}-${clip.index}`}
                controls
                playsInline
                preload="metadata"
                src={`${API}/jobs/${job.id}/clips/${clip.index}`}
              />
              <span className="preview-tag">
                {Math.round(clip.end - clip.start)} SEC · 9:16
              </span>
            </div>
            <article className="clip-info">
              <div className="eyebrow">
                CLIP {selected + 1} / {job.clips.length}
              </div>
              <h2>{clip.title}</h2>
              <div className="score">
                <strong>
                  {clip.virality_score}
                  <small>/100</small>
                </strong>
                <div>
                  Virality score
                  <span>AI editorial estimate, not a guarantee</span>
                </div>
              </div>
              <div className="metrics">
                {(
                  [
                    ["Hook", clip.hook_score],
                    ["Emotion", clip.emotion_score],
                    ["Standalone", clip.standalone_score],
                    ["Insight", clip.insight_score],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <div>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </div>
                    <meter
                      min="0"
                      max="100"
                      value={value}
                      aria-label={`${label} score`}
                    />
                  </div>
                ))}
              </div>
              <div className="reasoning">
                <h3>Why this moment works</h3>
                <p>{clip.reasoning}</p>
              </div>
              <a
                className="primary download"
                href={`${API}/jobs/${job.id}/clips/${clip.index}?download=true`}
              >
                Download clip <span aria-hidden="true">↓</span>
              </a>
              <a
                className="secondary edit-clip"
                href={`/editor?job=${job.id}&clip=${clip.index}`}
              >
                Edit from original source ↗
              </a>
              <nav aria-label="Clip navigation" className="navigation">
                <button
                  className="text-button"
                  disabled={selected === 0}
                  onClick={() => setSelected((v) => v - 1)}
                >
                  ← Previous
                </button>
                <div>
                  {job.clips.map((c, i) => (
                    <button
                      key={c.index}
                      aria-label={`Clip ${i + 1}`}
                      aria-current={selected === i ? "true" : undefined}
                      onClick={() => setSelected(i)}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
                <button
                  className="text-button"
                  disabled={selected === job.clips.length - 1}
                  onClick={() => setSelected((v) => v + 1)}
                >
                  Next →
                </button>
              </nav>
            </article>
          </div>
        </section>
      )}
    </main>
  );
}
