"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PricingCards, type BillingPlan } from "../LandingPage";
import { apiRequest } from "../../lib/api";

type User = {
  email: string;
  plan: BillingPlan["id"] | null;
  subscription_status: string;
  is_admin: boolean;
};

export default function PricingPage() {
  const router = useRouter();
  const [user, setUser] = useState<User>();
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [busy, setBusy] = useState("");
  const [promoBusy, setPromoBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      apiRequest<User>("/auth/me"),
      apiRequest<{ plans: BillingPlan[] }>("/billing/plans"),
    ]).then(([account, catalog]) => {
      if (account.subscription_status !== "active") {
        router.replace("/");
        return;
      }
      setUser(account);
      setPlans(catalog.plans);
    }).catch(() => router.replace("/login"));
  }, [router]);

  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get("changed");
    if (!target) return;
    let attempts = 0;
    const check = () => {
      apiRequest<User>("/auth/me").then((account) => {
        setUser(account);
        if (account.plan === target) {
          clearInterval(timer);
          setNotice(`Your ${target} plan is now active.`);
          window.history.replaceState({}, "", "/pricing");
        } else {
          setNotice("Stripe confirmed your choice. Updating your plan…");
        }
      }).catch((reason) => setError(reason.message));
      if (++attempts >= 15) {
        clearInterval(timer);
        setNotice("Stripe is still updating your plan. Refresh in a moment.");
      }
    };
    const timer = setInterval(check, 1000);
    check();
    return () => clearInterval(timer);
  }, []);

  async function changePlan(plan: BillingPlan["id"]) {
    setBusy(plan);
    setError("");
    try {
      const result = await apiRequest<{ url: string }>("/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      window.location.assign(result.url);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy("");
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
      setNotice(`Promo code applied. Your ${account.plan} plan is active.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPromoBusy(false);
    }
  }

  if (!user) return <main className="shell"><p>Loading plans…</p></main>;

  return (
    <main className="subscription-page plan-page">
      <header>
        <Link className="landing-logo" href="/"><span aria-hidden="true">C</span> Clipper</Link>
        <div>
          <span>{user.email}</span>
          {user.is_admin && <Link className="text-button" href="/admin">Admin</Link>}
          <button className="text-button" onClick={manageBilling}>Payment & cancellation</button>
          <Link className="text-button" href="/">← Back to workspace</Link>
        </div>
      </header>
      <section>
        <span className="demo-label">PLANS & BILLING</span>
        <h1>Choose the plan that fits.</h1>
        <p>Upgrade or downgrade securely through Stripe. Any prorated charge or credit is shown before you confirm.</p>
        {notice && <div className="billing-notice">{notice}</div>}
        {error && <div className="billing-error" role="alert">{error}</div>}
        <PricingCards plans={plans} currentPlan={user.plan} onSelect={changePlan} busy={busy}
          onRedeem={redeemPromo} promoBusy={promoBusy} />
      </section>
    </main>
  );
}
