
import os
import getpass
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv
from pwdlib import PasswordHash

BASE = Path(__file__).resolve().parent.parent

load_dotenv(BASE / ".env")

DATABASE_URL = os.getenv("DATABASE_URL")
password_hash = PasswordHash.recommended()


def create_worker():
    if not DATABASE_URL:
        print("DATABASE_URL is missing from your local .env file.")
        return

    username = input("Enter worker username: ").strip()

    if len(username) < 2:
        print("Username must contain at least 2 characters.")
        return

    password = getpass.getpass(
        "Enter password (minimum 8 characters): "
    )

    if len(password) < 8:
        print("Password must contain at least 8 characters.")
        return

    confirm = getpass.getpass("Confirm password: ")

    if password != confirm:
        print("Passwords do not match.")
        return

    hashed_password = password_hash.hash(password)

    try:
        with psycopg.connect(
            DATABASE_URL,
            row_factory=dict_row,
            connect_timeout=10
        ) as conn:

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

            existing = conn.execute(
                "SELECT username FROM users WHERE username = %s",
                (username,)
            ).fetchone()

            if existing:
                print("This username already exists.")
                return

            conn.execute(
                """
                INSERT INTO users
                    (username, password_hash, role, active)
                VALUES (%s, %s, %s, TRUE)
                """,
                (username, hashed_password, "asha_worker")
            )

        print("Worker account created successfully!")

    except Exception as error:
        print("Database operation failed:", str(error))


if __name__ == "__main__":
    create_worker()

