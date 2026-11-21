
import sqlite3
import getpass
from pathlib import Path
from pwdlib import PasswordHash

BASE = Path(__file__).resolve().parent.parent
DB_PATH = BASE / "asha_voicecare.db"

password_hash = PasswordHash.recommended()


def main():
    new_password = getpass.getpass("Enter new password for Asha: ")
    confirm = getpass.getpass("Confirm new password: ")

    if len(new_password) < 12:
        print("Password must contain at least 12 characters.")
        return

    if new_password != confirm:
        print("Passwords do not match.")
        return

    hashed = password_hash.hash(new_password)

    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("PRAGMA foreign_keys = ON")

            asha = conn.execute(
                "SELECT user_id FROM users WHERE username = 'Asha' AND active = 1"
            ).fetchone()

            pooja = conn.execute(
                "SELECT user_id FROM users WHERE username = 'pooja' AND active = 1"
            ).fetchone()

            if not asha:
                print("Active Asha account not found.")
                return

            if not pooja:
                print("Active pooja account not found.")
                return

            # Reset Asha's password
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE username = 'Asha'",
                (hashed,)
            )

            # Disable the other account
            conn.execute(
                "UPDATE users SET active = 0 WHERE username = 'pooja'"
            )

            # Revoke existing sessions if the sessions table exists
            tables = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()

            if ("sessions",) in tables:
                columns = [
                    row[1] for row in
                    conn.execute("PRAGMA table_info(sessions)").fetchall()
                ]

                if "user_id" in columns:
                    conn.execute(
                        "DELETE FROM sessions WHERE user_id IN (?, ?)",
                        (asha[0], pooja[0])
                    )

        print("Success!")
        print("Asha's password has been reset.")
        print("Pooja's account has been disabled.")
        print("Existing patient records were not changed.")

    except sqlite3.Error as error:
        print("Database update failed:", error)


if __name__ == "__main__":
    main()
