import type { ReactNode } from "react";

const GITHUB = "https://github.com/aidarinho2017/AI-video-clipper";

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

export default function LandingPage({ signIn, error }: {
  signIn: ReactNode;
  error?: string;
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
          <a href="#start">Sign in</a>
          <a className="landing-nav-cta" href="#start">Try Clipper</a>
        </div>
      </nav>

      <section className="landing-hero" id="top">
        <div className="landing-kicker"><i /> Built for the moments worth sharing</div>
        <h1>Turn long videos into<br /><span>short clips people watch.</span></h1>
        <p>AI finds the strongest moments, reframes the speaker, and renders vertical clips with captions — ready for Shorts, Reels, and TikTok.</p>
        <div className="landing-actions">
          <a className="primary" href="#start">Create clips <span aria-hidden="true">↗</span></a>
          <a className="landing-secondary" href="#how">See how it works</a>
        </div>
        <small>No editing skills required. Start with 100 credits.</small>
      </section>

      <section className="product-demo reveal" aria-label="Product preview">
        <div className="demo-topbar">
          <div><i /><i /><i /></div>
          <span>clipper / new project</span>
          <b>100 credits</b>
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
          <a href="#start">Open after sign in <span aria-hidden="true">→</span></a>
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

      <section className="landing-final reveal" id="start">
        <span className="demo-label">START CLIPPING</span>
        <h2>Your best clips are already<br />inside your videos.</h2>
        <p>Sign in with Google. Your first 100 credits are on us.</p>
        {signIn}
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
