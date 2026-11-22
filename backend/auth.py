
import os
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

from fastapi import APIRouter, HTTPException, Request, Response, Depends
from pydantic import BaseModel, Field
from pwdlib import PasswordHash

router = APIRouter(prefix="/api/auth", tags=["Authentication"])

password_hash = PasswordHash.recommended()

DATABASE_URL = os.getenv("DATABASE_URL")
SESSION_COOKIE = "asha_session"
SESSION_HOURS = 8
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "true").lower() == "true"


def db():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not configured")

    return psycopg.connect(
        DATABASE_URL,
        row_factory=dict_row,
        connect_timeout=10
    )


def init_auth_db():
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id BIGSERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'asha_worker',
                active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        """)

        conn.execute("""
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(user_id),
                token_hash TEXT UNIQUE NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL
            )
        """)


init_auth_db()


class LoginRequest(BaseModel):
    username: str = Field(min_length=2, max_length=50)
    password: str = Field(min_length=8, max_length=128)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@router.post("/login")
def login(data: LoginRequest, response: Response):
    with db() as conn:
        user = conn.execute(
            """
            SELECT user_id, username, password_hash, role, active
            FROM users
            WHERE username = %s
            """,
            (data.username.strip(),)
        ).fetchone()

    if (
        not user
        or not user["active"]
        or not password_hash.verify(data.password, user["password_hash"])
    ):
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password"
        )

    token = secrets.token_urlsafe(32)
    token_hash = hash_token(token)
    expires = datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)

    with db() as conn:
        conn.execute(
            """
            INSERT INTO sessions (user_id, token_hash, expires_at)
            VALUES (%s, %s, %s)
            """,
            (user["user_id"], token_hash, expires)
        )

    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=SESSION_HOURS * 60 * 60,
        path="/"
    )

    return {
        "logged_in": True,
        "username": user["username"],
        "role": user["role"]
    }


def get_current_user(request: Request):
    token = request.cookies.get(SESSION_COOKIE)

    if not token:
        raise HTTPException(
            status_code=401,
            detail="Please log in first"
        )

    token_hash = hash_token(token)

    with db() as conn:
        session = conn.execute(
            """
            SELECT
                users.user_id,
                users.username,
                users.role,
                users.active,
                sessions.expires_at
            FROM sessions
            JOIN users ON users.user_id = sessions.user_id
            WHERE sessions.token_hash = %s
            """,
            (token_hash,)
        ).fetchone()

    if not session or not session["active"]:
        raise HTTPException(
            status_code=401,
            detail="Invalid session. Please log in again."
        )

    expiry = session["expires_at"]

    if expiry <= datetime.now(timezone.utc):
        with db() as conn:
            conn.execute(
                "DELETE FROM sessions WHERE token_hash = %s",
                (token_hash,)
            )

        raise HTTPException(
            status_code=401,
            detail="Session expired. Please log in again."
        )

    return {
        "user_id": session["user_id"],
        "username": session["username"],
        "role": session["role"]
    }


@router.get("/me")
def check_login(user=Depends(get_current_user)):
    return {
        "authenticated": True,
        "username": user["username"],
        "role": user["role"]
    }


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)

    if token:
        with db() as conn:
            conn.execute(
                "DELETE FROM sessions WHERE token_hash = %s",
                (hash_token(token),)
            )

    response.delete_cookie(
        key=SESSION_COOKIE,
        path="/",
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax"
    )

    return {"logged_out": True}

