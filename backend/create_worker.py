
import sqlite3
import getpass

from pathlib import Path
from pwdlib import PasswordHash

BASE = Path(__file__).resolve().parent.parent
DB_PATH = BASE / "asha_voicecare.db"

password_hash = PasswordHash.recommended()


def create_worker():

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

    with sqlite3.connect(DB_PATH) as conn:

        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'asha_worker',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)

        try:
            conn.execute(
                """
                INSERT INTO users (username, password_hash, role)
                VALUES (?, ?, ?)
                """,
                (username, hashed_password, "asha_worker")
            )

            print("Worker account created successfully!")

        except sqlite3.IntegrityError:
            print("This username already exists.")


if __name__ == "__main__":
    create_worker()
