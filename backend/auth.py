import base64
import hashlib
import hmac
import json
import sqlite3
import time

from fastapi import HTTPException, Request
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from .config import settings

COOKIE = "clipper_session"


def _connect():
    connection = sqlite3.connect(settings.data_dir / "users.sqlite3")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def init():
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    with _connect() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS users (
            google_sub TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            name TEXT NOT NULL,
            picture TEXT NOT NULL DEFAULT '',
            credits INTEGER NOT NULL DEFAULT 100 CHECK (credits >= 0)
        )""")


def upsert_user(claims: dict) -> dict:
    with _connect() as db:
        db.execute(
            """INSERT INTO users (google_sub, email, name, picture) VALUES (?, ?, ?, ?)
               ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,
               name=excluded.name, picture=excluded.picture""",
            (claims["sub"], claims["email"], claims.get("name", claims["email"]), claims.get("picture", "")),
        )
        return dict(db.execute("SELECT * FROM users WHERE google_sub = ?", (claims["sub"],)).fetchone())


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
            user = db.execute("SELECT * FROM users WHERE google_sub = ?", (data["sub"],)).fetchone()
        if not user:
            raise ValueError
        return dict(user)
    except (ValueError, KeyError, json.JSONDecodeError):
        raise HTTPException(401, "Sign in with Google to continue.") from None


def charge(google_sub: str, amount: int) -> int:
    with _connect() as db:
        changed = db.execute(
            "UPDATE users SET credits = credits - ? WHERE google_sub = ? AND credits >= ?",
            (amount, google_sub, amount),
        ).rowcount
        if not changed:
            raise HTTPException(402, "Not enough credits.")
        return db.execute("SELECT credits FROM users WHERE google_sub = ?", (google_sub,)).fetchone()[0]


def refund(google_sub: str, amount: int):
    with _connect() as db:
        db.execute("UPDATE users SET credits = credits + ? WHERE google_sub = ?", (amount, google_sub))


def public_user(user: dict) -> dict:
    return {key: user[key] for key in ("email", "name", "picture", "credits")}
