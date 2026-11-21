
import sqlite3
import getpass
from pathlib import Path
from pwdlib import PasswordHash

BASE = Path(__file__).resolve().parent.parent
DB_PATH = BASE / "asha_voicecare.db"

password_hash = PasswordHash.recommended()


def main():
    username = input("Enter the existing username: ").strip()
    new_username = input("Enter the new username: ").strip()

    if not username or not new_username:
        print("Username cannot be empty.")
        return

    new_password = getpass.getpass("Enter new password: ")
    confirm_password = getpass.getpass("Confirm new password: ")

    if len(new_password) < 12:
        print("Use a password with at least 12 characters.")
        return

    if new_password != confirm_password:
        print("Passwords do not match.")
        return

    hashed = password_hash.hash(new_password)

    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.execute(
                """
                UPDATE users
                SET username = ?, password_hash = ?
                WHERE username = ? AND active = 1
                """,
                (new_username, hashed, username)
            )

            if cursor.rowcount == 0:
                print("Existing active worker account not found.")
                return

        print("Worker username and password updated successfully.")

    except sqlite3.IntegrityError:
        print("That new username is already in use.")


if __name__ == "__main__":
    main()
