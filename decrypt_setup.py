#!/usr/bin/env python3
"""
decrypt_setup.py — Decrypt an encrypted blob and push secrets to Replit.

Usage:
    python3 decrypt_setup.py                         # prompts for blob + password
    python3 decrypt_setup.py --blob blob.txt         # read blob from file
    python3 decrypt_setup.py --dry-run               # decrypt only, print keys (no upload)

How secrets are pushed (tried in order):
    1. Replit Secrets API — if REPLIT_API_TOKEN is in the decrypted payload
       or already in the environment.
    2. Dry-run fallback — prints export commands you can run manually.
"""

import base64
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

REPLIT_SECRETS_API = "https://replit.com/api/v1/repls/{repl_id}/secrets"


def derive_key(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=480_000,
    )
    return base64.urlsafe_b64encode(kdf.derive(password.encode()))


def decrypt_blob(blob: str, password: str) -> dict:
    try:
        raw = base64.urlsafe_b64decode(blob.strip())
    except Exception:
        raise ValueError("Blob is not valid base64. Did you copy it completely?")

    if len(raw) < 17:
        raise ValueError("Blob is too short — it may be truncated.")

    salt = raw[:16]
    token = raw[16:]
    key = derive_key(password, salt)

    try:
        f = Fernet(key)
        plaintext = f.decrypt(token)
    except InvalidToken:
        raise ValueError("Decryption failed — wrong password or corrupted blob.")

    try:
        return json.loads(plaintext)
    except json.JSONDecodeError:
        raise ValueError("Decrypted data is not valid JSON — blob may be corrupted.")


def push_via_replit_api(secrets: dict, api_token: str) -> tuple[list, list]:
    repl_id = os.environ.get("REPL_ID", "")
    if not repl_id:
        raise RuntimeError("REPL_ID not found in environment.")

    url = REPLIT_SECRETS_API.format(repl_id=repl_id)
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    succeeded, failed = [], []
    for key, value in secrets.items():
        body = json.dumps({"key": key, "value": value}).encode()
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status in (200, 201, 204):
                    succeeded.append(key)
                else:
                    failed.append((key, f"HTTP {resp.status}"))
        except urllib.error.HTTPError as e:
            failed.append((key, f"HTTP {e.code}: {e.reason}"))
        except Exception as e:
            failed.append((key, str(e)))

    return succeeded, failed


def print_export_commands(secrets: dict) -> None:
    print("\n  ── Manual setup (copy-paste into your shell or Replit Secrets tab) ──\n")
    for key, value in secrets.items():
        safe = value.replace("'", "'\\''")
        print(f"  export {key}='{safe}'")
    print()
    print("  Or add each key manually in the Replit Secrets panel (padlock icon).")


def get_blob(save_file: str | None) -> str:
    if save_file:
        with open(save_file) as fh:
            return fh.read().strip()

    print("Paste your encrypted blob (single line), then press Enter:")
    return input("> ").strip()


def main():
    dry_run = "--dry-run" in sys.argv
    blob_file = None
    if "--blob" in sys.argv:
        idx = sys.argv.index("--blob")
        if idx + 1 < len(sys.argv):
            blob_file = sys.argv[idx + 1]

    print("=" * 60)
    print("  Sam Bot — Decrypt & Setup Tool")
    print("=" * 60)

    blob = get_blob(blob_file)
    if not blob:
        print("Error: no blob provided.")
        sys.exit(1)

    password = getpass.getpass("\nEnter master password: ")

    print("\nDecrypting…")
    try:
        secrets = decrypt_blob(blob, password)
    except ValueError as e:
        print(f"\nError: {e}")
        sys.exit(1)

    print(f"Decrypted {len(secrets)} key(s): {list(secrets.keys())}\n")

    if dry_run:
        print("[dry-run] Skipping upload.\n")
        print_export_commands(secrets)
        return

    # Resolve API token: prefer one from the blob, fall back to environment
    api_token = (
        secrets.pop("REPLIT_API_TOKEN", None)
        or os.environ.get("REPLIT_API_TOKEN")
        or os.environ.get("REPLIT_TOKEN")
    )

    if api_token:
        print(f"Pushing {len(secrets)} secret(s) to Replit via API…\n")
        try:
            succeeded, failed = push_via_replit_api(secrets, api_token)
        except RuntimeError as e:
            print(f"API error: {e}")
            print_export_commands(secrets)
            return

        if succeeded:
            print(f"  ✓ Set successfully: {succeeded}")
        if failed:
            print(f"  ✗ Failed: {failed}")
            print("\nFalling back to manual instructions for failed keys:")
            print_export_commands({k: secrets[k] for k, _ in failed if k in secrets})
        else:
            print("\nAll secrets pushed successfully!")
    else:
        print("No REPLIT_API_TOKEN found in blob or environment.")
        print("Tip: re-run encrypt_tool.py and include your Replit API token,")
        print("     or add it to the Replit Secrets panel first.\n")
        print_export_commands(secrets)


if __name__ == "__main__":
    main()
