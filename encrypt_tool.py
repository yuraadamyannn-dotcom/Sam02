#!/usr/bin/env python3
"""
encrypt_tool.py — Bundle API keys into a single encrypted blob.

Usage:
    python3 encrypt_tool.py
    python3 encrypt_tool.py --output blob.txt   # also saves blob to file
"""

import base64
import getpass
import json
import os
import sys

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

KEYS = [
    ("TELEGRAM_BOT_TOKEN",  "Telegram Bot Token (from @BotFather)", True),
    ("GROQ_API_KEY",        "Groq API Key (primary AI engine)", True),
    ("GEMINI_API_KEY",      "Gemini API Key (Python bot primary AI)", True),
    ("GROK_API_KEY",        "Grok / xAI API Key (Python bot fallback AI)", True),
    ("ADMIN_TELEGRAM_ID",   "Admin Telegram User ID (your numeric Telegram ID)", True),
    ("ELEVENLABS_API_KEY",  "ElevenLabs API Key (TTS voice, optional)", False),
    ("OPENAI_API_KEY",      "OpenAI API Key (embeddings, optional)", False),
    ("QDRANT_URL",          "Qdrant URL (vector DB, optional)", False),
    ("QDRANT_API_KEY",      "Qdrant API Key (optional)", False),
    ("ZILLIZ_URL",          "Zilliz URL (cold vector memory, optional)", False),
    ("ZILLIZ_API_KEY",      "Zilliz API Key (optional)", False),
    ("SESSION_SECRET",      "Express Session Secret (random string, optional)", False),
    ("DATABASE_URL",        "PostgreSQL Database URL (optional)", False),
    ("REPLIT_API_TOKEN",    "Replit API Token (needed by decrypt_setup.py to auto-set secrets)", False),
    ("SPARE_KEY_15",        "Spare slot — any extra key you want to bundle", False),
]


def derive_key(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=480_000,
    )
    return base64.urlsafe_b64encode(kdf.derive(password.encode()))


def collect_keys() -> dict:
    print("\n=== API Key Collection ===")
    print("Press Enter to skip optional keys.\n")
    payload: dict = {}
    for env_key, label, required in KEYS:
        tag = "[required]" if required else "[optional]"
        while True:
            value = input(f"  {tag} {label}\n        {env_key}: ").strip()
            if value:
                payload[env_key] = value
                break
            elif not required:
                break
            else:
                print("        This key is required — please enter a value.")
    return payload


def get_password() -> str:
    print("\n=== Master Password ===")
    print("This password is used to encrypt your keys.")
    print("Keep it safe — you'll need it to decrypt.\n")
    while True:
        pw1 = getpass.getpass("  Enter master password: ")
        pw2 = getpass.getpass("  Confirm master password: ")
        if pw1 == pw2 and pw1:
            return pw1
        if pw1 != pw2:
            print("  Passwords do not match, try again.")
        else:
            print("  Password cannot be empty.")


def main():
    save_file = None
    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        if idx + 1 < len(sys.argv):
            save_file = sys.argv[idx + 1]

    print("=" * 60)
    print("  Sam Bot — Encrypted Config Tool")
    print("=" * 60)

    payload = collect_keys()
    password = get_password()

    salt = os.urandom(16)
    key = derive_key(password, salt)
    f = Fernet(key)

    plaintext = json.dumps(payload).encode()
    token = f.encrypt(plaintext)

    # Format: base64( salt || encrypted_token )
    blob = base64.urlsafe_b64encode(salt + token).decode()

    print("\n" + "=" * 60)
    print("  ENCRYPTED BLOB (copy everything between the lines)")
    print("=" * 60)
    print(blob)
    print("=" * 60)
    print(f"\nKeys bundled: {list(payload.keys())}")
    print("Share this blob freely — it is useless without the password.")

    if save_file:
        with open(save_file, "w") as fh:
            fh.write(blob + "\n")
        print(f"\nBlob saved to: {save_file}")


if __name__ == "__main__":
    main()
