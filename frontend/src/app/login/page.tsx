"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { useEffect, useState } from "react";

const API = "http://localhost:8000";

declare global {
  interface Window {
    google?: { accounts: { id: {
      initialize(config: { client_id: string; callback(response: { credential: string }): void }): void;
      renderButton(element: HTMLElement, options: { theme: string; size: string; shape: string; width: number }): void;
    } } };
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...options,
      credentials: "include",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Cannot reach the backend. Make sure it is running on localhost:8000.");
  }
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Sign in failed. Try again.");
  return data;
}

export default function LoginPage() {
  const router = useRouter();
  const [clientId, setClientId] = useState("");
  const [googleReady, setGoogleReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    request("/auth/me")
      .then(() => router.replace("/"))
      .catch(() => setChecking(false));
    request<{ google_client_id: string }>("/auth/config")
      .then((config) => setClientId(config.google_client_id))
      .catch((reason) => {
        setError(reason.message);
        setChecking(false);
      });
  }, [router]);

  const googleButton = (element: HTMLDivElement | null) => {
    if (!element || !googleReady || !clientId || !window.google) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: async ({ credential }) => {
        setError("");
        try {
          await request("/auth/google", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential }),
          });
          router.replace("/");
        } catch (reason) {
          setError((reason as Error).message);
        }
      },
    });
    element.replaceChildren();
    window.google.accounts.id.renderButton(element, {
      theme: "filled_black",
      size: "large",
      shape: "rectangular",
      width: 320,
    });
  };

  return (
    <main className="login-page">
      <Script src="https://accounts.google.com/gsi/client" onReady={() => setGoogleReady(true)} />
      <nav>
        <Link className="landing-logo" href="/"><span aria-hidden="true">C</span> Clipper</Link>
        <Link className="login-back" href="/">← Back to home</Link>
      </nav>
      <section className="login-layout">
        <div className="login-story">
          <span className="demo-label">YOUR NEXT GREAT CLIP</span>
          <h1>Find the moments<br />worth <span>sharing.</span></h1>
          <p>Step into the workspace, paste your video, and shape your first clip before choosing a plan.</p>
          <div className="login-preview" aria-hidden="true">
            <div><span>94</span><i /></div>
            <div>
              <small>AI MOMENT FOUND</small>
              <strong>The turning point</strong>
              <p>28 sec · 9:16 · Captions ready</p>
            </div>
            <b>↗</b>
          </div>
        </div>
        <div className="login-card">
          <span className="login-card-mark" aria-hidden="true">✦</span>
          <h2>Welcome to Clipper</h2>
          <p>Sign in to open your workspace. You will only choose a plan when you are ready to generate.</p>
          {checking ? <div className="login-loading">Checking your session…</div> : clientId
            ? <div className="google-button login-google" ref={googleButton} />
            : !error && <div className="billing-error">Add GOOGLE_CLIENT_ID to backend/.env.</div>}
          {error && <div className="billing-error" role="alert">{error}</div>}
          <small>By continuing, you agree to process only videos you have permission to use.</small>
        </div>
      </section>
    </main>
  );
}
