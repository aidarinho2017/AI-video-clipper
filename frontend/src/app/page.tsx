"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import LandingPage, { PricingCards, type BillingPlan } from "./LandingPage";
import { apiRequest, clearSession, mediaUrl, uploadRequest } from "../lib/api";
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
  clip_length?: "short" | "medium" | "long";
  clip_count?: 1 | 3 | 5 | 10;
  clips: Clip[];
  error: string | null;
  credits?: number;
  source_type?: "youtube" | "upload";
};
type Entitlements = {
  model_tiers: string[];
  clip_counts: number[];
  clip_lengths: string[];
  editor: boolean;
};
type User = {
  email: string;
  name: string;
  picture: string;
  credits: number;
  plan: BillingPlan["id"] | null;
  subscription_status: string;
  cancel_at_period_end: boolean;
  current_period_end: number | null;
  subscription_source: "stripe" | "admin" | "promo" | null;
  is_admin: boolean;
  entitlements: Entitlements;
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
  upload_limits: { max_bytes: number; min_seconds: number; max_seconds: number };
};

function SubscriptionGate({ user, plans, busy, notice, error, onCheckout, onRedeem, promoBusy, onManage, onLogout, onBack }: {
  user: User;
  plans: BillingPlan[];
  busy: string;
  notice: string;
  error: string;
  onCheckout: (plan: BillingPlan["id"]) => void;
  onRedeem: (code: string) => void;
  promoBusy: boolean;
  onManage: () => void;
  onLogout: () => void;
  onBack?: () => void;
}) {
  const paymentProblem = ["past_due", "unpaid"].includes(user.subscription_status);
  return (
    <main className="subscription-page">
      <header>
        <Link className="landing-logo" href="/"><span aria-hidden="true">C</span> Clipper</Link>
        <div>
          {onBack && <button className="text-button" onClick={onBack}>← Back to project</button>}
          <span>{user.email}</span>
          <button className="text-button" onClick={onLogout}>Sign out</button>
        </div>
      </header>
      <section>
        <span className="demo-label">CHOOSE YOUR PLAN</span>
        <h1>{paymentProblem ? "Your payment needs attention." : "Your clips are ready to begin."}</h1>
        <p>{paymentProblem
          ? "Update your payment method in Stripe to restore access."
          : "Choose the plan that fits the clip settings you just prepared."}</p>
        {notice && <div className="billing-notice">{notice}</div>}
        {error && <div className="billing-error" role="alert">{error}</div>}
        {paymentProblem
          ? <button className="primary billing-manage" onClick={onManage}>Manage billing ↗</button>
          : <PricingCards plans={plans} onSelect={onCheckout} busy={busy}
              onRedeem={onRedeem} promoBusy={promoBusy} />}
      </section>
    </main>
  );
}

export default function Home() {
  const [user, setUser] = useState<User | null>();
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [showPricing, setShowPricing] = useState(false);
  const [billingBusy, setBillingBusy] = useState("");
  const [promoBusy, setPromoBusy] = useState(false);
  const [billingNotice, setBillingNotice] = useState("");
  const [url, setUrl] = useState("");
  const [sourceType, setSourceType] = useState<"youtube" | "upload">("youtube");
  const [file, setFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLimits, setUploadLimits] = useState<ModelCatalog["upload_limits"] | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  const [restore, setRestore] = useState(0);
  const [clipUrls, setClipUrls] = useState<Record<number, string>>({});
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("gemini-fast");
  const [instructions, setInstructions] = useState("");
  const [clipLength, setClipLength] = useState<"short" | "medium" | "long">(
    "short",
  );
  const [clipCount, setClipCount] = useState<1 | 3 | 5 | 10>(5);
  const subscribed = user?.subscription_status === "active";
  const allowedModels = models.filter((item) => item.configured && (!subscribed || user.entitlements.model_tiers.includes(item.tier)));
  const activeModel = allowedModels.some((item) => item.id === model) ? model : (allowedModels[0]?.id ?? model);
  const activeClipCount = (!subscribed || user.entitlements.clip_counts.includes(clipCount)
    ? clipCount : user?.entitlements.clip_counts.at(-1) ?? clipCount) as 1 | 3 | 5 | 10;
  const activeClipLength = (!subscribed || user.entitlements.clip_lengths.includes(clipLength)
    ? clipLength : user?.entitlements.clip_lengths.at(-1) ?? clipLength) as "short" | "medium" | "long";

  useEffect(() => {
    apiRequest<User>("/auth/me").then(setUser).catch(() => setUser(null));
    apiRequest<{ plans: BillingPlan[] }>("/billing/plans").then((data) => setPlans(data.plans)).catch((err) => setError(err.message));
  }, []);

  const subscriptionStatus = user?.subscription_status;
  useEffect(() => {
    if (!subscriptionStatus || new URLSearchParams(window.location.search).get("checkout") !== "success") return;
    if (subscriptionStatus === "active") {
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    let attempts = 0;
    const timer = setInterval(() => {
      apiRequest<User>("/auth/me").then((next) => {
        setBillingNotice("Payment completed. Waiting for Stripe to activate your subscription…");
        setUser(next);
        if (next.subscription_status === "active") clearInterval(timer);
      }).catch((reason) => setError(reason.message));
      if (++attempts >= 15) {
        clearInterval(timer);
        setBillingNotice("Stripe is still processing the payment. Refresh in a moment.");
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [subscriptionStatus]);

  useEffect(() => {
    apiRequest<ModelCatalog>("/ai/models")
      .then((catalog) => {
        setModels(catalog.models);
        setUploadLimits(catalog.upload_limits);
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
    if (!user) return;
    const id = localStorage.getItem(STORAGE);
    if (!id) return;
    let active = true;
    apiRequest<Job>(`/jobs/${id}`)
      .then((data) => {
        if (active) {
          setJob(data);
          setUser((current) => current && data.credits !== undefined ? { ...current, credits: data.credits } : current);
          setError("");
        }
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [restore, user]);

  const jobId = job?.id;
  const processing = job?.status === "queued" || job?.status === "processing";
  useEffect(() => {
    if (!jobId || !processing) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await apiRequest<Job>(`/jobs/${jobId}`);
        if (active) {
          setJob(data);
          setUser((current) => current && data.credits !== undefined ? { ...current, credits: data.credits } : current);
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
    if (!subscribed) {
      setShowPricing(true);
      return;
    }
    setBusy(true);
    setUploadProgress(0);
    setError("");
    try {
      if (sourceType === "upload" && !file) throw new Error("Choose a video file.");
      if (sourceType === "upload" && file && uploadLimits && file.size > uploadLimits.max_bytes) {
        throw new Error("Video exceeds the upload size limit.");
      }
      const options = { model: activeModel, instructions, clip_length: activeClipLength, clip_count: activeClipCount };
      const data = sourceType === "upload" && file
        ? await uploadRequest<Job>(`/jobs/upload?${new URLSearchParams({ ...options, clip_count: String(options.clip_count) })}`, file, setUploadProgress)
        : await apiRequest<Job>("/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          youtube_url: url,
          ...options,
        }),
      });
      localStorage.setItem(STORAGE, data.id);
      setJob(data);
      setUser((current) => current && data.credits !== undefined ? { ...current, credits: data.credits } : current);
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
    setClipUrls({});
  }

  async function logout() {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
    } finally {
      clearSession();
    }
    reset();
    setUser(null);
  }

  async function checkout(plan: BillingPlan["id"]) {
    setBillingBusy(plan);
    setError("");
    try {
      const result = await apiRequest<{ url: string }>("/billing/checkout", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }),
      });
      window.location.assign(result.url);
    } catch (reason) {
      setError((reason as Error).message);
      setBillingBusy("");
    }
  }

  async function manageBilling() {
    setError("");
    try {
      const result = await apiRequest<{ url: string }>("/billing/portal", { method: "POST" });
      window.location.assign(result.url);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function redeemPromo(code: string) {
    setPromoBusy(true);
    setError("");
    try {
      const account = await apiRequest<User>("/billing/promo-code", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      });
      setUser(account);
      setShowPricing(false);
      setBillingNotice(`Promo code applied. Your ${account.plan} plan is active.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPromoBusy(false);
    }
  }
  const clip = job?.clips[selected];

  useEffect(() => {
    if (job?.status !== "completed") return;
    let active = true;
    Promise.all(job.clips.map(async ({ index }) => [index,
      await mediaUrl(`/jobs/${job.id}/clips/${index}`)] as const))
      .then((entries) => { if (active) setClipUrls(Object.fromEntries(entries)); })
      .catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [job?.id, job?.status, job?.clips]);

  if (user === undefined) return <main className="shell"><p>Loading…</p></main>;

  if (!user) return <LandingPage error={error} plans={plans} />;

  const needsBillingRecovery = !["active", "inactive", "canceled"].includes(user.subscription_status);
  if (showPricing || needsBillingRecovery) return <SubscriptionGate user={user} plans={plans}
    busy={billingBusy} notice={billingNotice} error={error} onCheckout={checkout}
    onRedeem={redeemPromo} promoBusy={promoBusy}
    onManage={manageBilling} onLogout={logout}
    onBack={needsBillingRecovery ? undefined : () => setShowPricing(false)} />;

  return (
    <main className={job?.status === "completed" ? "results-shell" : "shell"}>
      <div className="ambient" aria-hidden="true" />
      <div className="account-bar">
        <span>{user.name}</span>
        {subscribed ? <>
          <span>{user.plan}</span>
          <strong>{user.credits} credits</strong>
          <Link className="text-button" href="/pricing">Plans</Link>
          <button className="text-button" onClick={manageBilling}>Billing</button>
        </> : <span className="preview-badge">Preview</span>}
        {user.is_admin && <Link className="text-button" href="/admin">Admin</Link>}
        <button className="text-button" onClick={logout}>Sign out</button>
      </div>
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
            <fieldset className="generation-settings" disabled={busy}>
              <legend>Video source</legend>
              <label htmlFor="source-type">Source</label>
              <select id="source-type" value={sourceType} onChange={(event) => setSourceType(event.target.value as "youtube" | "upload")}>
                <option value="youtube">YouTube</option>
                <option value="upload">Upload video</option>
              </select>
            </fieldset>
            {sourceType === "youtube" ? <>
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
            </> : <div className="generation-settings">
              <label htmlFor="video-file">Video file</label>
              <input id="video-file" type="file" accept="video/*,.mkv" required={!file} disabled={busy}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              {file && <p>{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MiB</p>}
              <p>Your video needs sound. Uploaded videos are transcribed before analysis.</p>
              {uploadLimits && <p>Up to {(uploadLimits.max_bytes / 1024 ** 3).toFixed(1)} GiB · {uploadLimits.min_seconds} seconds to {Math.floor(uploadLimits.max_seconds / 60)} minutes.</p>}
              {busy && <div role="status">
                <progress max={100} value={uploadProgress} aria-label="Video upload progress" />
                <p>{uploadProgress < 100 ? `Uploading… ${uploadProgress}%` : "Upload complete. Checking video…"}</p>
              </div>}
            </div>}
            <fieldset className="generation-settings" disabled={busy}>
              <legend>Clip settings</legend>
              <label htmlFor="ai-model">AI model</label>
              <select
                id="ai-model"
                value={activeModel}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.configured || (subscribed && !user.entitlements.model_tiers.includes(item.tier))}>
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
              <div className="setting-grid">
                <div>
                  <label htmlFor="clip-length">Clip length</label>
                  <select
                    id="clip-length"
                    value={activeClipLength}
                    onChange={(event) =>
                      setClipLength(
                        event.target.value as "short" | "medium" | "long",
                      )
                    }
                  >
                    <option value="short" disabled={subscribed && !user.entitlements.clip_lengths.includes("short")}>Short · 15–30 sec</option>
                    <option value="medium" disabled={subscribed && !user.entitlements.clip_lengths.includes("medium")}>Medium · 30–60 sec</option>
                    <option value="long" disabled={subscribed && !user.entitlements.clip_lengths.includes("long")}>Long · 60–90 sec</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="clip-count">Number of clips</label>
                  <select
                    id="clip-count"
                    value={activeClipCount}
                    onChange={(event) =>
                      setClipCount(Number(event.target.value) as 1 | 3 | 5 | 10)
                    }
                  >
                    {[1, 3, 5, 10].map((count) => (
                      <option key={count} value={count} disabled={subscribed && !user.entitlements.clip_counts.includes(count)}>
                        {count}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </fieldset>
            <button
              className="primary"
              disabled={busy || !allowedModels.length || (subscribed && user.credits < activeClipCount)}
            >
              {busy ? (sourceType === "upload" ? "Uploading…" : "Starting…") : subscribed
                ? `Generate Clips · ${activeClipCount} credit${activeClipCount === 1 ? "" : "s"}`
                : "Generate Clips"}
              <span aria-hidden="true">↗</span>
            </button>
            {user.entitlements.editor && <a className="secondary editor-entry" href="/editor">Open video editor</a>}
          </form>
        </section>
      )}
      {processing && (
        <section className="processing panel" aria-live="polite">
          <div className="eyebrow">
            YOUR NEXT {job.clip_count ?? 5}{" "}
            {(job.clip_count ?? 5) === 1 ? "CLIP" : "CLIPS"}
          </div>
          <h1>
            Good moments.
            <br />
            <span>Worth sharing.</span>
          </h1>
          <p>Finding the strongest parts of your conversation.</p>
          <ol className="stages">
            {stages.filter(([id]) => job.source_type !== "upload" || id !== "downloading").map(([id, label], index, visibleStages) => {
              const current = visibleStages.findIndex(([s]) => s === job.stage);
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
                    <small>
                      {job.completed_clips}/{job.clip_count ?? 5}
                    </small>
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
              <div className="eyebrow">
                GENERATED {job.clips.length} OF {job.clip_count ?? 5}{" "}
                {(job.clip_count ?? 5) === 1 ? "CLIP" : "CLIPS"}
              </div>
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
                src={clipUrls[clip.index]}
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
                href={clipUrls[clip.index] ? `${clipUrls[clip.index]}&download=true` : undefined}
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
