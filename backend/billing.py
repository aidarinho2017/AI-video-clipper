import time
import threading

import stripe
from fastapi import HTTPException

from . import auth
from .config import settings

PLANS = {
    "starter": {
        "name": "Starter", "price": 9, "credits": 100,
        "model_tiers": ["fast"], "clip_counts": [1, 3], "clip_lengths": ["short"], "editor": False,
    },
    "pro": {
        "name": "Pro", "price": 29, "credits": 500,
        "model_tiers": ["fast", "quality"], "clip_counts": [1, 3, 5],
        "clip_lengths": ["short", "medium"], "editor": True,
    },
    "studio": {
        "name": "Studio", "price": 79, "credits": 2000,
        "model_tiers": ["fast", "quality"], "clip_counts": [1, 3, 5, 10],
        "clip_lengths": ["short", "medium", "long"], "editor": True,
    },
}
# ponytail: one backend process; use a database lease if checkout traffic needs multiple workers.
checkout_lock = threading.Lock()


def _prices() -> dict[str, str]:
    return {
        "starter": settings.stripe_price_starter,
        "pro": settings.stripe_price_pro,
        "studio": settings.stripe_price_studio,
    }


def catalog() -> list[dict]:
    prices = _prices()
    return [{**plan, "id": key, "configured": bool(prices[key])} for key, plan in PLANS.items()]


def subscription_payload(user: dict) -> dict:
    plan = PLANS.get(user.get("plan"))
    return {
        "plan": user.get("plan"),
        "subscription_status": user.get("subscription_status", "inactive"),
        "cancel_at_period_end": bool(user.get("cancel_at_period_end")),
        "current_period_end": user.get("current_period_end"),
        "entitlements": {
            "model_tiers": plan["model_tiers"] if plan else [],
            "clip_counts": plan["clip_counts"] if plan else [],
            "clip_lengths": plan["clip_lengths"] if plan else [],
            "editor": bool(plan and plan["editor"]),
        },
    }


def _stripe_key():
    key = settings.stripe_secret_key.get_secret_value()
    if not key.startswith("sk_test_"):
        raise HTTPException(503, "Stripe test mode is not configured.")
    stripe.api_key = key


def _active(user: dict) -> bool:
    return user.get("subscription_status") == "active" and user.get("plan") in PLANS


def require_active(user: dict):
    if not _active(user):
        raise HTTPException(403, "An active subscription is required.")


def require_editor(user: dict) -> dict:
    require_active(user)
    if not PLANS[user["plan"]]["editor"]:
        raise HTTPException(403, "Upgrade to Pro or Studio to use the video editor.")
    return user


def ensure_job(user: dict, model_tier: str, clip_count: int, clip_length: str):
    require_active(user)
    plan = PLANS[user["plan"]]
    if model_tier not in plan["model_tiers"]:
        raise HTTPException(403, "Upgrade your plan to use this AI model.")
    if clip_count not in plan["clip_counts"]:
        raise HTTPException(403, "Upgrade your plan to generate this many clips.")
    if clip_length not in plan["clip_lengths"]:
        raise HTTPException(403, "Upgrade your plan to use this clip length.")


def checkout(user: dict, plan_id: str) -> str:
    with checkout_lock:
        return _checkout(user, plan_id)


def _checkout(user: dict, plan_id: str) -> str:
    with auth._connect() as db:
        user = db.execute("SELECT * FROM users WHERE google_sub = %s", (user["google_sub"],)).fetchone()
    if user.get("subscription_status") in {"active", "past_due", "unpaid"}:
        raise HTTPException(409, "Manage or finish your current subscription before choosing another plan.")
    _stripe_key()
    if user.get("subscription_status") == "checkout_pending" and user.get("stripe_checkout_session_id"):
        try:
            pending = stripe.checkout.Session.retrieve(user["stripe_checkout_session_id"])
            if pending.status == "open":
                return pending.url
            if pending.status == "complete":
                raise HTTPException(409, "Stripe is still activating your completed payment.")
        except stripe.StripeError as exc:
            raise HTTPException(502, "Stripe could not check the existing Checkout session.") from exc
    price = _prices().get(plan_id)
    if not price:
        raise HTTPException(503, f"Stripe price for {plan_id} is not configured.")
    customer_id = user.get("stripe_customer_id")
    if not customer_id:
        try:
            customer = stripe.Customer.create(
                email=user["email"], name=user["name"], metadata={"google_sub": user["google_sub"]})
        except stripe.StripeError as exc:
            raise HTTPException(502, "Stripe could not create a customer. Try again.") from exc
        customer_id = customer.id
        with auth._connect() as db:
            db.execute("UPDATE users SET stripe_customer_id = %s WHERE google_sub = %s",
                       (customer_id, user["google_sub"]))
    try:
        session = stripe.checkout.Session.create(
            mode="subscription", customer=customer_id, line_items=[{"price": price, "quantity": 1}],
            client_reference_id=user["google_sub"],
            subscription_data={"metadata": {"google_sub": user["google_sub"], "plan": plan_id}},
            success_url=f"{settings.app_url}/?checkout=success",
            cancel_url=f"{settings.app_url}/?checkout=canceled",
        )
    except stripe.StripeError as exc:
        raise HTTPException(502, "Stripe could not open Checkout. Try again.") from exc
    with auth._connect() as db:
        db.execute("""UPDATE users SET subscription_status='checkout_pending',
                   stripe_checkout_session_id = %s WHERE google_sub = %s""", (session.id, user["google_sub"]))
    return session.url


def portal(user: dict) -> str:
    _stripe_key()
    if not user.get("stripe_customer_id"):
        raise HTTPException(409, "No Stripe customer exists for this account.")
    try:
        return stripe.billing_portal.Session.create(
            customer=user["stripe_customer_id"], return_url=settings.app_url).url
    except stripe.StripeError as exc:
        raise HTTPException(502, "Stripe could not open the billing portal. Try again.") from exc


def change_plan(user: dict, plan_id: str) -> str:
    require_active(user)
    if user.get("plan") == plan_id:
        raise HTTPException(409, "This is already your current plan.")
    price = _prices().get(plan_id)
    if not price:
        raise HTTPException(503, f"Stripe price for {plan_id} is not configured.")
    if not user.get("stripe_customer_id") or not user.get("stripe_subscription_id"):
        raise HTTPException(409, "The Stripe subscription is not linked to this account.")
    _stripe_key()
    try:
        subscription = stripe.Subscription.retrieve(user["stripe_subscription_id"])
        items = subscription["items"]["data"]
        if len(items) != 1 or _id(subscription.get("customer")) != user["stripe_customer_id"]:
            raise HTTPException(409, "This subscription cannot be changed automatically.")
        session = stripe.billing_portal.Session.create(
            customer=user["stripe_customer_id"],
            return_url=f"{settings.app_url}/pricing",
            flow_data={
                "type": "subscription_update_confirm",
                "after_completion": {
                    "type": "redirect",
                    "redirect": {"return_url": f"{settings.app_url}/pricing?changed={plan_id}"},
                },
                "subscription_update_confirm": {
                    "subscription": user["stripe_subscription_id"],
                    "items": [{"id": items[0]["id"], "price": price, "quantity": 1}],
                },
            },
        )
        return session.url
    except HTTPException:
        raise
    except stripe.StripeError as exc:
        raise HTTPException(502, "Stripe could not prepare this plan change. Try again.") from exc


def _id(value):
    return value.get("id") if hasattr(value, "get") else value


def _subscription_id(value: dict):
    subscription = value.get("subscription")
    if not subscription:
        subscription = ((value.get("parent") or {}).get("subscription_details") or {}).get("subscription")
    return _id(subscription)


def _price_id(value: dict):
    items = ((value.get("items") or value.get("lines") or {}).get("data") or [])
    if not items:
        return None
    item = items[0]
    price = item.get("price")
    if price:
        return _id(price)
    return _id(((item.get("pricing") or {}).get("price_details") or {}).get("price"))


def _plan_for_price(price_id: str | None):
    return next((key for key, value in _prices().items() if value and value == price_id), None)


def _period_end(subscription: dict):
    if subscription.get("current_period_end"):
        return subscription["current_period_end"]
    items = ((subscription.get("items") or {}).get("data") or [])
    return items[0].get("current_period_end") if items else None


def handle_event(event: dict):
    if event.get("livemode"):
        raise HTTPException(400, "Live Stripe events are disabled.")
    event_id, event_type = event["id"], event["type"]
    value = event["data"]["object"]
    with auth._connect() as db:
        claimed = db.execute("""INSERT INTO billing_events (event_id, processed_at) VALUES (%s, %s)
                              ON CONFLICT (event_id) DO NOTHING RETURNING event_id""",
                             (event_id, int(time.time()))).fetchone()
        if not claimed:
            return
        if event_type == "checkout.session.completed":
            db.execute("""UPDATE users SET stripe_subscription_id = %s, stripe_checkout_session_id=NULL
                       WHERE stripe_customer_id = %s""",
                       (_id(value.get("subscription")), _id(value.get("customer"))))
        elif event_type == "checkout.session.expired":
            db.execute("""UPDATE users SET subscription_status='inactive', stripe_checkout_session_id=NULL
                       WHERE stripe_customer_id = %s AND subscription_status='checkout_pending'""",
                       (_id(value.get("customer")),))
        elif event_type == "invoice.paid":
            plan_id = _plan_for_price(_price_id(value))
            if not plan_id:
                raise ValueError("Paid invoice does not contain a configured subscription price")
            changed = db.execute("""UPDATE users SET stripe_subscription_id = %s, plan = %s,
                subscription_status='active', stripe_checkout_session_id=NULL, credits = %s
                WHERE stripe_customer_id = %s""",
                (_subscription_id(value), plan_id, PLANS[plan_id]["credits"], _id(value.get("customer")))).rowcount
            if not changed:
                raise ValueError("Paid invoice customer is not linked to a user")
        elif event_type == "invoice.payment_failed":
            db.execute("UPDATE users SET subscription_status='past_due' WHERE stripe_customer_id = %s",
                       (_id(value.get("customer")),))
        elif event_type in {"customer.subscription.created", "customer.subscription.updated",
                            "customer.subscription.deleted"}:
            plan_id = _plan_for_price(_price_id(value))
            status = "canceled" if event_type.endswith("deleted") else value.get("status", "inactive")
            db.execute("""UPDATE users SET stripe_subscription_id = %s, plan=COALESCE(%s, plan),
                subscription_status = %s, cancel_at_period_end = %s, current_period_end = %s
                WHERE stripe_customer_id = %s""",
                (value["id"], plan_id, status, bool(value.get("cancel_at_period_end")),
                 _period_end(value), _id(value.get("customer"))))


def webhook(payload: bytes, signature: str | None):
    secret = settings.stripe_webhook_secret.get_secret_value()
    if not secret:
        raise HTTPException(503, "Stripe webhook is not configured.")
    if not signature:
        raise HTTPException(400, "Missing Stripe signature.")
    try:
        event = stripe.Webhook.construct_event(payload, signature, secret)
    except Exception as exc:
        raise HTTPException(400, "Invalid Stripe webhook signature.") from exc
    handle_event(event)
