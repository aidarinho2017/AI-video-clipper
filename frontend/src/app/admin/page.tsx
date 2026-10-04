"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { apiRequest } from "../../lib/api";

type Plan = "starter" | "pro" | "studio";
type AdminUser = {
  google_sub: string;
  email: string;
  name: string;
  credits: number;
  plan: Plan | null;
  subscription_status: string;
  subscription_source: "stripe" | "admin" | "promo" | null;
  current_period_end: number | null;
  stripe_plan: Plan | null;
  stripe_status: string;
  grant_plan: Plan | null;
  grant_until: number | null;
  grant_source: string | null;
};
type PromoCode = {
  code: string;
  plan: Plan;
  duration_days: number;
  max_redemptions: number;
  redemptions: number;
  expires_at: number | null;
  active: boolean;
};

const date = (timestamp: number | null) => timestamp
  ? new Date(timestamp * 1000).toLocaleString()
  : "—";

export default function AdminPage() {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [promos, setPromos] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    const [userData, promoData] = await Promise.all([
      apiRequest<{ users: AdminUser[] }>("/admin/users"),
      apiRequest<{ promo_codes: PromoCode[] }>("/admin/promo-codes"),
    ]);
    setUsers(userData.users);
    setPromos(promoData.promo_codes);
  }

  useEffect(() => {
    apiRequest<{ is_admin: boolean }>("/auth/me").then((account) => {
      if (!account.is_admin) {
        router.replace("/");
        return;
      }
      return refresh().then(() => setLoading(false));
    }).catch(() => router.replace("/login"));
  }, [router]);

  async function run(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice(message);
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  }

  async function grant(event: React.FormEvent<HTMLFormElement>, user: AdminUser) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const plan = String(data.get("plan"));
    const duration_days = Number(data.get("duration_days"));
    await run(`grant:${user.google_sub}`, () => apiRequest(`/admin/users/${encodeURIComponent(user.google_sub)}/grant`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, duration_days }),
    }), `Granted ${plan} to ${user.email}.`);
  }

  async function createPromo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const expiration = String(data.get("expires_at") || "");
    const body = {
      code: String(data.get("code")),
      plan: String(data.get("plan")),
      duration_days: Number(data.get("duration_days")),
      max_redemptions: Number(data.get("max_redemptions")),
      expires_at: expiration ? Math.floor(new Date(expiration).getTime() / 1000) : null,
    };
    const created = await run("create-promo", () => apiRequest("/admin/promo-codes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), `Created promo code ${body.code.toUpperCase()}.`);
    if (created) form.reset();
  }

  if (loading) return <main className="shell"><p>Loading admin panel…</p></main>;

  return (
    <main className="admin-page">
      <header>
        <Link className="landing-logo" href="/"><span aria-hidden="true">C</span> Clipper</Link>
        <Link className="text-button" href="/">← Back to workspace</Link>
      </header>

      <section className="admin-heading">
        <span className="demo-label">ADMIN</span>
        <h1>Subscriptions and promo codes</h1>
        <p>Temporary access overrides Stripe until it expires, then the paid plan resumes automatically.</p>
        {notice && <div className="billing-notice">{notice}</div>}
        {error && <div className="billing-error" role="alert">{error}</div>}
      </section>

      <section className="admin-section">
        <h2>Users</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>User</th><th>Effective access</th><th>Stripe</th><th>Credits</th><th>Temporary grant</th></tr></thead>
            <tbody>{users.map((user) => <tr key={user.google_sub}>
              <td><strong>{user.name}</strong><span>{user.email}</span></td>
              <td><strong>{user.plan || "None"}</strong><span>{user.subscription_source || user.subscription_status}</span>
                <small>{date(user.current_period_end)}</small></td>
              <td><strong>{user.stripe_plan || "None"}</strong><span>{user.stripe_status}</span></td>
              <td>{user.credits.toLocaleString()}</td>
              <td><form className="admin-grant" onSubmit={(event) => grant(event, user)}>
                <select name="plan" defaultValue={user.grant_plan || "pro"} aria-label={`Plan for ${user.email}`}>
                  <option value="starter">Starter</option><option value="pro">Pro</option><option value="studio">Studio</option>
                </select>
                <input name="duration_days" type="number" min="1" max="3650" defaultValue="30" aria-label={`Days for ${user.email}`} />
                <button disabled={Boolean(busy)}>Grant</button>
                {user.grant_plan && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => run(
                  `revoke:${user.google_sub}`,
                  () => apiRequest(`/admin/users/${encodeURIComponent(user.google_sub)}/revoke-grant`, { method: "POST" }),
                  `Revoked temporary access for ${user.email}.`,
                )}>Revoke</button>}
              </form></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="admin-section admin-promos">
        <div>
          <h2>Create promo code</h2>
          <form className="admin-promo-form" onSubmit={createPromo}>
            <label>Code<input name="code" required minLength={4} maxLength={32} pattern="[A-Za-z0-9_\-]+" placeholder="CREATOR30" /></label>
            <label>Plan<select name="plan" defaultValue="pro"><option value="starter">Starter</option><option value="pro">Pro</option><option value="studio">Studio</option></select></label>
            <label>Access days<input name="duration_days" type="number" min="1" max="3650" defaultValue="30" required /></label>
            <label>Maximum redemptions<input name="max_redemptions" type="number" min="1" max="100000" defaultValue="1" required /></label>
            <label>Redeem before (optional)<input name="expires_at" type="datetime-local" /></label>
            <button className="primary" disabled={Boolean(busy)}>{busy === "create-promo" ? "Creating…" : "Create code"}</button>
          </form>
        </div>
        <div>
          <h2>Promo codes</h2>
          <div className="admin-code-list">{promos.length ? promos.map((promo) => <article key={promo.code}>
            <div><strong>{promo.code}</strong><span className={promo.active ? "active" : "disabled"}>{promo.active ? "Active" : "Disabled"}</span></div>
            <p>{promo.plan} · {promo.duration_days} days</p>
            <small>{promo.redemptions} / {promo.max_redemptions} redeemed · expires {date(promo.expires_at)}</small>
            <button className="text-button" disabled={Boolean(busy)} onClick={() => run(
              `promo:${promo.code}`,
              () => apiRequest(`/admin/promo-codes/${encodeURIComponent(promo.code)}/status`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active: !promo.active }),
              }), `${promo.code} ${promo.active ? "disabled" : "enabled"}.`,
            )}>{promo.active ? "Disable" : "Enable"}</button>
          </article>) : <p>No promo codes yet.</p>}</div>
        </div>
      </section>
    </main>
  );
}
