import Link from "next/link";
import type { ReactNode } from "react";

const GITHUB = "https://github.com/aidarinho2017/AI-video-clipper";

export type BillingPlan = {
  id: "starter" | "pro" | "studio";
  name: string;
  price: number;
  credits: number;
  model_tiers: string[];
  clip_counts: number[];
  clip_lengths: string[];
  editor: boolean;
  configured: boolean;
};

export function PricingCards({ plans, onSelect, busy, currentPlan }: {
  plans: BillingPlan[];
  onSelect?: (plan: BillingPlan["id"]) => void;
  busy?: string;
  currentPlan?: BillingPlan["id"] | null;
}) {
  const currentPrice = plans.find((plan) => plan.id === currentPlan)?.price;
  return (
    <div className="pricing-grid">
      {plans.map((plan) => (
        <article className={`pricing-card ${plan.id === "pro" ? "featured" : ""}`} key={plan.id}>
          {plan.id === "pro" && <span className="pricing-popular">MOST POPULAR</span>}
          <h3>{plan.name} {plan.id === currentPlan && <span className="current-plan">CURRENT</span>}</h3>
          <div className="pricing-price"><strong>${plan.price}</strong><span>/ month</span></div>
          <p>{plan.credits.toLocaleString()} credits every month</p>
          <ul>
            <li>Up to {Math.max(...plan.clip_counts)} clips per video</li>
            <li>{plan.model_tiers.length > 1 ? "All AI models" : "Fast AI models"}</li>
            <li>{plan.clip_lengths.includes("long") ? "15–90 sec clips" : plan.clip_lengths.includes("medium") ? "15–60 sec clips" : "15–30 sec clips"}</li>
            <li>{plan.editor ? "Full video editor" : "Ready-to-post MP4 exports"}</li>
          </ul>
          {onSelect ? (
            <button className={plan.id === "pro" ? "primary" : "landing-secondary"}
                    disabled={Boolean(busy) || !plan.configured || plan.id === currentPlan} onClick={() => onSelect(plan.id)}>
              {plan.id === currentPlan ? "Current plan" : busy === plan.id ? "Opening Stripe…"
                : plan.configured ? `${currentPrice && plan.price > currentPrice ? "Upgrade" : currentPrice ? "Downgrade" : "Choose"} to ${plan.name}`
                : "Configure Stripe price"}
            </button>
          ) : <Link className={plan.id === "pro" ? "primary" : "landing-secondary"} href="/login">Choose {plan.name}</Link>}
        </article>
      ))}
    </div>
  );
}

function ClipPreview({ score, title, length, tone }: {
  score: number;
  title: string;
  length: string;
  tone: string;
}) {
  return (
    <article className="demo-clip">
      <div className={`demo-frame ${tone}`}>
        <span className="demo-score">{score}</span>
        <div className="demo-person" aria-hidden="true"><i /></div>
        <p>THE MOMENT EVERYTHING<br /><strong>STARTED TO CLICK</strong></p>
      </div>
      <div className="demo-clip-meta">
        <div><strong>{title}</strong><span>{length} · 9:16</span></div>
        <span aria-hidden="true">↓</span>
      </div>
    </article>
  );
}

function Step({ number, title, children }: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <article className="landing-step">
      <span>{number}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

export default function LandingPage({ error, plans }: {
  error?: string;
  plans: BillingPlan[];
}) {
  return (
    <main className="landing">
      <nav className="landing-nav" aria-label="Main navigation">
        <a className="landing-logo" href="#top" aria-label="Clipper home">
          <span aria-hidden="true">C</span> Clipper
        </a>
        <div>
          <a href="#editor">Editor</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
          <Link href="/login">Sign in</Link>
          <Link className="landing-nav-cta" href="/login">Try Clipper</Link>
        </div>
      </nav>

      <section className="landing-hero" id="top">
        <div className="landing-kicker"><i /> Built for the moments worth sharing</div>
        <h1>Turn long videos into<br /><span>short clips people watch.</span></h1>
        <p>AI finds the strongest moments, reframes the speaker, and renders vertical clips with captions — ready for Shorts, Reels, and TikTok.</p>
        <div className="landing-actions">
          <Link className="primary" href="/login">Create clips <span aria-hidden="true">↗</span></Link>
          <a className="landing-secondary" href="#how">See how it works</a>
        </div>
        <small>No editing skills required. Plans start at $9/month.</small>
      </section>

      <section className="product-demo reveal" aria-label="Product preview">
        <div className="demo-topbar">
          <div><i /><i /><i /></div>
          <span>clipper / new project</span>
          <b>Pro · 500 credits</b>
        </div>
        <div className="demo-source">
          <div>
            <span className="demo-label">SOURCE VIDEO</span>
            <h2>Paste a YouTube video.</h2>
            <p>Choose the clip length, count, and the AI model you want to use.</p>
          </div>
          <div className="demo-url"><span>youtube.com/watch?v=your-video</span><b>Generate ↗</b></div>
        </div>
        <div className="demo-flow" aria-label="YouTube video becomes ranked vertical clips">
          <div className="demo-long-video">
            <span>48:12</span>
            <div className="demo-wave" aria-hidden="true" />
            <small>LONG VIDEO</small>
          </div>
          <div className="demo-process">
            <i />
            <strong>AI finds moments</strong>
            <span>hooks · stories · insights</span>
          </div>
          <div className="demo-clips">
            <ClipPreview score={94} title="The turning point" length="28 sec" tone="blue" />
            <ClipPreview score={91} title="A hard lesson" length="43 sec" tone="violet" />
            <ClipPreview score={88} title="What changed" length="24 sec" tone="steel" />
          </div>
        </div>
      </section>

      <section className="landing-how reveal" id="how">
        <header>
          <span className="demo-label">HOW IT WORKS</span>
          <h2>One video in.<br />The best moments out.</h2>
        </header>
        <div>
          <Step number="01" title="Paste">Add a public YouTube link and choose 1, 3, 5, or 10 clips.</Step>
          <Step number="02" title="Find">AI ranks complete moments by hook, emotion, insight, and standalone value.</Step>
          <Step number="03" title="Export">Download vertical MP4s with burned captions and face-aware framing.</Step>
        </div>
      </section>

      <section className="editor-callout reveal" id="editor">
        <div>
          <span className="demo-label">BUILT-IN VIDEO EDITOR</span>
          <h2>Finish the cut<br />without leaving Clipper.</h2>
          <p>Import local video and audio, trim and split clips, add captions and crossfades, adjust framing, then export a single MP4.</p>
          <Link href="/login">Open after sign in <span aria-hidden="true">→</span></Link>
        </div>
        <div className="editor-mini" aria-hidden="true">
          <div className="editor-mini-head"><i /><span>Preview</span><b>Export</b></div>
          <div className="editor-mini-body">
            <aside><i /><i /><i /></aside>
            <div className="editor-mini-preview"><span>YOUR CAPTION</span></div>
            <aside><i /><i /><i /><i /></aside>
          </div>
          <div className="editor-mini-timeline"><span /><span /><span /></div>
        </div>
      </section>

      <section className="landing-pricing reveal" id="pricing">
        <span className="demo-label">SIMPLE MONTHLY PLANS</span>
        <h2>Choose how much you create.</h2>
        <p>No free tier, no hidden usage fees. Credits reset after each successful monthly payment.</p>
        <PricingCards plans={plans} />
      </section>

      <section className="landing-final reveal" id="start">
        <span className="demo-label">START CLIPPING</span>
        <h2>Your best clips are already<br />inside your videos.</h2>
        <p>Try the workspace, shape your first clip, and choose a plan when you are ready to generate.</p>
        <Link className="primary landing-final-cta" href="/login">Try Clipper <span aria-hidden="true">↗</span></Link>
        {error && <p className="landing-error" role="alert">{error}</p>}
      </section>

      <footer className="landing-footer">
        <a className="landing-logo" href="#top"><span aria-hidden="true">C</span> Clipper</a>
        <div><a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a><a href="#how">How it works</a><a href="#editor">Editor</a></div>
        <span>© 2026</span>
      </footer>
    </main>
  );
}
