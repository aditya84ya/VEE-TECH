"""
Helper script to publish unique critical test posts directly to Bluesky using credentials in .env.

Usage:
  python test_bluesky_post.py       -> Picks a fresh scenario automatically
  python test_bluesky_post.py 1     -> Ransomware & Critical Cyber Breach
  python test_bluesky_post.py 2     -> US SEC & DOJ Criminal Indictment
  python test_bluesky_post.py 3     -> RBI Banking Suspension & Capital Asset Freeze
  python test_bluesky_post.py 4     -> Global Banking Consortium Blacklist
  python test_bluesky_post.py 5     -> ED Headquarters Raid & Leadership Custody
  python test_bluesky_post.py "..." -> Custom text
"""

import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Load .env
for env_path in [
    Path.cwd() / ".env",
    Path.cwd() / "server" / ".env",
    Path(__file__).parent / ".env",
    Path(__file__).parent / "server" / ".env",
]:
    if env_path.is_file():
        load_dotenv(dotenv_path=env_path, override=False)

BLUESKY_IDENTIFIER = os.getenv("BLUESKY_IDENTIFIER", "luffy-sk.bsky.social")
BLUESKY_PASSWORD = os.getenv("BLUESKY_PASSWORD", "sf5h-xvez-pstv-u4kt")

CRITICAL_SCENARIOS = {
    "1": (
        "FLASH CYBER EMERGENCY: CERT-In and Interpol confirm catastrophic zero-day ransomware "
        "compromise across Infosys production clusters. Massive database exfiltration detected and client "
        "operations suspended indefinitely."
    ),
    "2": (
        "URGENT FRAUD PROBE: US Department of Justice and SEC unseal criminal indictment against "
        "Infosys C-suite executives alleging massive $4.2B fictitious revenue inflation and fraudulent overseas "
        "accounting."
    ),
    "3": (
        "BREAKING REGULATORY SANCTION: Reserve Bank of India (RBI) orders immediate suspension of "
        "Infosys banking core services and freezes overseas wire transfers after severe national security and "
        "compliance breach."
    ),
    "4": (
        "CRISIS ALERT: Global banking consortium comprising 14 international financial institutions "
        "cancels all enterprise master agreements with Infosys with immediate effect citing systemic operational "
        "failure."
    ),
    "5": (
        "BREAKING NEWS: Enforcement Directorate and CBI raid Infosys headquarters in Bengaluru, "
        "placing top executive leadership in immediate judicial detention following forensic evidence of illicit "
        "fund routing."
    ),
}


def publish_to_bluesky(choice: str = None) -> dict:
    if choice and choice in CRITICAL_SCENARIOS:
        base_text = CRITICAL_SCENARIOS[choice]
    elif choice and len(choice) > 10:
        base_text = choice
    else:
        # Pick a random scenario
        key = random.choice(list(CRITICAL_SCENARIOS.keys()))
        base_text = CRITICAL_SCENARIOS[key]

    ts = int(time.time())
    post_text = f"{base_text} [Ref #{ts}]"

    print("\n" + "=" * 65)
    print("  BLUESKY CRITICAL ALERT LIVE INTEGRATION TEST")
    print("=" * 65)
    print(f"  Account : {BLUESKY_IDENTIFIER}")
    print(f"  Message : {post_text}")
    print("-" * 65)

    # 1. Create Session
    session_url = "https://bsky.social/xrpc/com.atproto.server.createSession"
    session_res = requests.post(
        session_url,
        json={"identifier": BLUESKY_IDENTIFIER, "password": BLUESKY_PASSWORD},
        timeout=15,
    )
    session_res.raise_for_status()
    session_data = session_res.json()
    access_token = session_data["accessJwt"]
    did = session_data["did"]

    print(f"[1/2] Authenticated with Bluesky as {did}")

    # 2. Create Post Record
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    create_url = "https://bsky.social/xrpc/com.atproto.repo.createRecord"
    headers = {"Authorization": f"Bearer {access_token}"}
    record_payload = {
        "repo": did,
        "collection": "app.bsky.feed.post",
        "record": {
            "$type": "app.bsky.feed.post",
            "text": post_text,
            "createdAt": now_iso,
        },
    }

    create_res = requests.post(create_url, headers=headers, json=record_payload, timeout=15)
    create_res.raise_for_status()
    result = create_res.json()

    uri = result.get("uri", "")
    rkey = uri.split("/")[-1] if uri else ""
    web_url = f"https://bsky.app/profile/{BLUESKY_IDENTIFIER}/post/{rkey}"

    print(f"[2/2] [✓] Successfully posted to Bluesky!")
    print(f"      URI      : {uri}")
    print(f"      Live URL : {web_url}")
    print("-" * 65)
    print("⚡ The Vee-Alert Jetstream WebSocket will capture this in 1-2 seconds.")
    print("⚡ Ollama will triage it as CRITICAL and trigger your Telegram alert!")
    print("=" * 65 + "\n")

    return {"uri": uri, "url": web_url}


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    publish_to_bluesky(arg)
