import base64
import hashlib
import hmac
import json
import time
from contextlib import contextmanager

from fastapi import HTTPException, Request
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings

COOKIE = "clipper_session"
pool: ConnectionPool | None = None


@contextmanager
def _connect():
    if pool is None:
        raise RuntimeError("PostgreSQL is not initialized.")
    with pool.connection() as connection:
        yield connection


def init():
    global pool
    close()
    database_url = settings.database_url.get_secret_value()
    if not database_url:
        raise RuntimeError("Set DATABASE_URL to a PostgreSQL connection URL.")
    pool = ConnectionPool(database_url, min_size=1, max_size=10, open=True,
                          kwargs={"row_factory": dict_row}, check=ConnectionPool.check_connection)
    pool.wait()
    with _connect() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS users (
            google_sub TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            name TEXT NOT NULL,
            picture TEXT NOT NULL DEFAULT '',
            credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
            stripe_customer_id TEXT,
            stripe_subscription_id TEXT,
            stripe_checkout_session_id TEXT,
            plan TEXT,
            subscription_status TEXT NOT NULL DEFAULT 'inactive',
            cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
            current_period_end BIGINT
        )""")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer ON users(stripe_customer_id)")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_subscription ON users(stripe_subscription_id)")
        db.execute("""CREATE TABLE IF NOT EXISTS billing_events (
            event_id TEXT PRIMARY KEY, processed_at BIGINT NOT NULL)""")
        db.execute("""CREATE TABLE IF NOT EXISTS credit_adjustments (
            reference TEXT PRIMARY KEY,
            google_sub TEXT NOT NULL REFERENCES users(google_sub) ON DELETE CASCADE,
            amount INTEGER NOT NULL CHECK (amount >= 0))""")


def close():
    global pool
    if pool is not None:
        pool.close()
        pool = None


def upsert_user(claims: dict) -> dict:
    with _connect() as db:
        db.execute(
            """INSERT INTO users (google_sub, email, name, picture, credits) VALUES (%s, %s, %s, %s, 0)
               ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,
               name=excluded.name, picture=excluded.picture""",
            (claims["sub"], claims["email"], claims.get("name", claims["email"]), claims.get("picture", "")),
        )
        return db.execute("SELECT * FROM users WHERE google_sub = %s", (claims["sub"],)).fetchone()


def verify_google(credential: str) -> dict:
    if not settings.google_client_id:
        raise HTTPException(503, "Google sign-in is not configured.")
    try:
        claims = id_token.verify_oauth2_token(
            credential, google_requests.Request(), settings.google_client_id)
    except ValueError as exc:
        raise HTTPException(401, "Invalid Google credential.") from exc
    if not claims.get("email") or not claims.get("email_verified"):
        raise HTTPException(401, "Google account email is not verified.")
    return claims


def _secret() -> bytes:
    secret = settings.auth_secret.get_secret_value()
    if len(secret) < 32:
        raise HTTPException(503, "Set AUTH_SECRET to at least 32 characters.")
    return secret.encode()


def issue_session(google_sub: str) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({
        "sub": google_sub, "exp": int(time.time()) + 30 * 24 * 60 * 60,
    }, separators=(",", ":")).encode()).rstrip(b"=")
    signature = hmac.new(_secret(), payload, hashlib.sha256).digest()
    return f"{payload.decode()}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"


def current_user(request: Request) -> dict:
    token = request.cookies.get(COOKIE, "")
    try:
        payload, signature = token.split(".")
        expected = hmac.new(_secret(), payload.encode(), hashlib.sha256).digest()
        actual = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        if not hmac.compare_digest(actual, expected):
            raise ValueError
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if data["exp"] < time.time():
            raise ValueError
        with _connect() as db:
            user = db.execute("SELECT * FROM users WHERE google_sub = %s", (data["sub"],)).fetchone()
        if not user:
            raise ValueError
        return user
    except (ValueError, KeyError, json.JSONDecodeError):
        raise HTTPException(401, "Sign in with Google to continue.") from None


def charge(google_sub: str, amount: int) -> int:
    with _connect() as db:
        changed = db.execute(
            "UPDATE users SET credits = credits - %s WHERE google_sub = %s AND credits >= %s",
            (amount, google_sub, amount),
        ).rowcount
        if not changed:
            raise HTTPException(402, "Not enough credits.")
        return db.execute("SELECT credits FROM users WHERE google_sub = %s", (google_sub,)).fetchone()["credits"]


def refund(google_sub: str, amount: int):
    with _connect() as db:
        db.execute("UPDATE users SET credits = credits + %s WHERE google_sub = %s", (amount, google_sub))


def refund_once(google_sub: str, amount: int, reference: str) -> int:
    if amount <= 0:
        return 0
    with _connect() as db:
        db.execute("""INSERT INTO credit_adjustments (reference, google_sub, amount)
                    VALUES (%s, %s, 0) ON CONFLICT (reference) DO NOTHING""",
                   (reference, google_sub))
        previous = db.execute("""SELECT google_sub, amount FROM credit_adjustments
                               WHERE reference = %s FOR UPDATE""", (reference,)).fetchone()
        if previous["google_sub"] != google_sub:
            raise ValueError("Credit adjustment belongs to another user")
        difference = amount - previous["amount"]
        if difference <= 0:
            return 0
        db.execute("UPDATE credit_adjustments SET amount = %s WHERE reference = %s", (amount, reference))
        db.execute("UPDATE users SET credits = credits + %s WHERE google_sub = %s", (difference, google_sub))
        return difference


def public_user(user: dict) -> dict:
    return {key: user[key] for key in ("email", "name", "picture", "credits")}
