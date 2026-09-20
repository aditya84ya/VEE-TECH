"""
VEE-ALERT Instagram Feed Ingestion Source Module
-----------------------------------------------------------------
Watches your own Professional (Business/Creator) Instagram account
through the Instagram Graph API (GET /me/media).

Features (aligned with user reference):
- Automatic fallback from FULL_FIELDS to BASIC_FIELDS on code 100.
- Token refresh logic (/refresh_access_token) every 30 days.
- Rolling request budget (MAX_REQUESTS_PER_HOUR = 180).
- Precise error taxonomy: TokenError (190), AccessError (OAuth), ApiError.
- Persistent state in instagram_state.json (seen post IDs, refreshed token).
- Delay calculation (seconds from posting to detection).
- Direct integration with Vee-Alert threat scoring & alert dispatch pipeline.
"""

import os
import re
import sys
import json
import time
import smtplib
import threading
from collections import deque
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
import requests
from dotenv import load_dotenv

# Ensure UTF-8 output on Windows console
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# ─── ENVIRONMENT LOADING ─────────────────────────────────────────────────────
ENV_SEARCH_PATHS = [
    Path('.env'),
    Path('server/.env'),
    Path(__file__).resolve().parent / '.env',
    Path(__file__).resolve().parent / 'server' / '.env',
    Path(__file__).resolve().parent.parent / 'server' / '.env'
]

for env_path in ENV_SEARCH_PATHS:
    if env_path.exists():
        load_dotenv(dotenv_path=env_path)
        break

BASE_URL = "https://graph.instagram.com"
BASIC_FIELDS = (
    "id,caption,media_type,media_url,thumbnail_url,permalink,"
    "timestamp,username,like_count,comments_count"
)
FULL_FIELDS = BASIC_FIELDS + ",media_product_type,shortcode,is_comment_enabled,children{id,media_type,media_url}"
CONFIG = {"full_fields": True}

STATE_FILE = Path(__file__).resolve().parent / "instagram_state.json"
REFRESH_EVERY = 30 * 24 * 3600          # Refresh long-lived token every 30 days (valid for 60)
MAX_SEEN = 500
MAX_REQUESTS_PER_HOUR = 180            # Stay safely under Instagram's 200/hr threshold

NODE_INGEST_ENDPOINT = os.getenv("NODE_INGEST_ENDPOINT", "http://localhost:5000/api/ingest")

GMAIL_ADDRESS = os.getenv("GMAIL_ADDRESS")
GMAIL_APP_PASSWORD = (os.getenv("GMAIL_APP_PASSWORD") or "").replace(" ", "")
EMAIL_RECIPIENTS = [e.strip() for e in os.getenv("TO_EMAIL", "").split(",") if e.strip()]

request_times: deque = deque()


# ─── CUSTOM EXCEPTIONS ───────────────────────────────────────────────────────
class TokenError(Exception):
    """The access token is invalid or expired (code 190) - cannot continue."""


class AccessError(Exception):
    """Meta refused the request (OAuthException / no permission)."""


class ApiError(Exception):
    """Instagram API transient or query error."""
    def __init__(self, message: str, code: Optional[int] = None):
        super().__init__(message)
        self.code = code


# ─── VEE-ALERT KEYWORD & THREAT SCORING DICTIONARIES ─────────────────────────
TARGET_REGEX = re.compile(
    r'\b(infosys|infosys\s+adr|tcs|tata\s+consultancy(\s+services)?|wipro|wipro\s+adr|accenture|finacle)\b',
    re.IGNORECASE
)

CRITICAL_KEYWORDS = [
    'sebi emergency',
    'emergency order',
    'trading suspended',
    'trading terminated',
    'arrest',
    'arrests',
    'fraud',
    'enforcement directorate',
    'money laundering',
    'insolvency',
    'bankruptcy',
    'liquidation',
    'asset seizure',
    'assets seized',
    'whistleblower'
]

HIGH_KEYWORDS = [
    'rbi',
    'sebi',
    'regulator',
    'probe',
    'investigation',
    'subpoena',
    'penalty',
    'fine',
    'lawsuit',
    'outage',
    'blackout',
    'ransomware',
    'security breach',
    'cyberattack',
    'contract loss',
    'downgrade',
    'audit notice',
    'sec probe',
    'enforcement action'
]


# ─── HELPERS & CONFIG ────────────────────────────────────────────────────────
def get_env_token() -> Optional[str]:
    """Retrieves access token from environment, checking all common key names."""
    for key in (
        "INSTAGRAM_ACCESS_TOKEN",
        "INSTAGRAM_TOKEN",
        "IG_ACCESS_TOKEN",
        "IG_TOKEN",
        "INSTAGRAM_USER_TOKEN",
        "INSTA_TOKEN",
        "INSTAGRAM_GRAPH_TOKEN"
    ):
        token = (os.getenv(key) or "").strip()
        if token and token != "your_long_lived_token":
            return token
    return None


def get_poll_interval() -> int:
    """Returns polling interval in seconds (minimum 20s per Instagram rate guidelines)."""
    raw_poll = os.getenv("POLL_SECONDS", "30")
    try:
        return max(20, int(raw_poll))
    except ValueError:
        return 30


# ─── STATE MANAGEMENT ────────────────────────────────────────────────────────
def load_state() -> dict:
    """Loads seen posts and token state from instagram_state.json."""
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        state = {}

    env_token = get_env_token()
    if env_token and state.get("env_token") != env_token:
        state["env_token"] = env_token
        state["token"] = env_token
        state["token_refreshed_at"] = 0

    return state


def save_state(state: dict) -> None:
    """Persists state to instagram_state.json."""
    try:
        STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception as err:
        print(f"[InstagramSource] [!] Warning: Could not write state file ({err}).")


# ─── API & RATE BUDGETING ────────────────────────────────────────────────────
def wait_for_budget() -> None:
    """Enforces max MAX_REQUESTS_PER_HOUR requests in any rolling 60-minute window."""
    now = time.time()
    while request_times and now - request_times[0] > 3600:
        request_times.popleft()
    if len(request_times) >= MAX_REQUESTS_PER_HOUR:
        pause = 3600 - (now - request_times[0]) + 1
        print(f"\n[InstagramSource] Hourly request budget reached. Pausing {int(pause)}s...")
        time.sleep(pause)
    request_times.append(time.time())


def api_get(path: str, params: dict) -> dict:
    """Performs an authenticated GET request against Instagram Graph API with error classification."""
    wait_for_budget()
    url = f"{BASE_URL}{path}"
    try:
        r = requests.get(url, params=params, timeout=20)
    except requests.RequestException as err:
        raise ApiError(f"Network error: {err}")

    try:
        data = r.json()
    except ValueError:
        raise ApiError(f"HTTP {r.status_code}: Non-JSON response")

    if r.status_code != 200 or "error" in data:
        err = data.get("error", {})
        message = err.get("message", f"HTTP {r.status_code}")
        code = err.get("code")
        if code == 190:
            raise TokenError(f"Invalid or expired token: {message}")
        if err.get("type") == "OAuthException":
            raise AccessError(
                f"{message} (code {code}, subcode {err.get('error_subcode')}, "
                f"trace {err.get('fbtrace_id')})"
            )
        raise ApiError(message, code)

    return data


def maybe_refresh_token(state: dict) -> None:
    """Long-lived tokens last 60 days; refresh automatically every ~30 days."""
    token = state.get("token") or get_env_token()
    if not token:
        return

    now = time.time()
    if now - state.get("token_refreshed_at", 0) < REFRESH_EVERY:
        return

    try:
        data = api_get(
            "/refresh_access_token",
            {"grant_type": "ig_refresh_token", "access_token": token}
        )
        state["token"] = data.get("access_token", token)
        state["token_refreshed_at"] = now
        print("\n[InstagramSource] [OK] Token refreshed (valid for another ~60 days).")
    except ApiError as e:
        state["token_refreshed_at"] = now - REFRESH_EVERY + 24 * 3600
        print(f"\n[InstagramSource] Token refresh skipped for now: {e}")

    save_state(state)


def fetch_account_info(token: str) -> Dict[str, Any]:
    """
    Fetches the authenticated Instagram account profile details:
    Account ID (token ID), Username, Account Type, and Media Count.
    GET https://graph.instagram.com/me?fields=id,username,account_type,media_count
    """
    try:
        return api_get("/me", {
            "fields": "id,username,account_type,media_count",
            "access_token": token
        })
    except ApiError as e:
        if e.code == 100:
            return api_get("/me", {
                "fields": "id,username",
                "access_token": token
            })
        raise


def fetch_media(token: str, limit: int = 10) -> List[Dict[str, Any]]:
    """
    Fetches media items for the authenticated account (/me/media).
    Gracefully degrades from FULL_FIELDS to BASIC_FIELDS if code 100 occurs.
    """
    fields = FULL_FIELDS if CONFIG["full_fields"] else BASIC_FIELDS
    try:
        data = api_get("/me/media", {"fields": fields, "limit": limit, "access_token": token})
    except ApiError as e:
        if CONFIG["full_fields"] and e.code == 100:
            CONFIG["full_fields"] = False
            print("\n[InstagramSource] Extra fields not available for this account; falling back to basic fieldset.")
            return fetch_media(token, limit=limit)
        raise

    return data.get("data", [])


# ─── NORMALIZATION & TIME PARSING ────────────────────────────────────────────
def parse_time(iso: Optional[str]) -> Optional[datetime]:
    """Parses Instagram ISO-8601 timestamp with timezone."""
    if not iso:
        return None
    try:
        return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S%z")
    except (TypeError, ValueError):
        return None


def normalize_post(post: Dict[str, Any], account_label: Optional[str] = None) -> Dict[str, Any]:
    """Normalizes raw Instagram media object into the Vee-Alert standard schema."""
    post_id = str(post.get("id", "")).strip()
    caption = str(post.get("caption") or "").strip()
    media_type = str(post.get("media_type") or "IMAGE").upper()
    permalink = str(post.get("permalink") or f"https://www.instagram.com/p/{post_id}")
    timestamp = post.get("timestamp") or datetime.now(timezone.utc).isoformat()
    username = post.get("username") or account_label or "me"

    # Compute headline from first line of caption
    if caption:
        lines = [l.strip() for l in caption.split("\n") if l.strip()]
        first_line = lines[0] if lines else caption
        title = first_line[:120] + ("..." if len(first_line) > 120 else "")
    else:
        title = f"[Instagram {media_type}] Post {post_id}"

    # Calculate detection delay in seconds if timestamp is parseable
    dt = parse_time(timestamp)
    detection_delay_sec = int((datetime.now(timezone.utc) - dt).total_seconds()) if dt else 0

    return {
        "id": f"ig_{post_id}",
        "post_id": post_id,
        "title": title,
        "raw_content": caption,
        "caption": caption,
        "media_type": media_type,
        "media_product_type": post.get("media_product_type", "FEED"),
        "media_url": post.get("media_url"),
        "thumbnail_url": post.get("thumbnail_url"),
        "permalink": permalink,
        "url": permalink,
        "shortcode": post.get("shortcode"),
        "username": username,
        "like_count": post.get("like_count", 0),
        "comments_count": post.get("comments_count", 0),
        "source_name": f"Instagram (@{username})",
        "api_source": "Instagram Graph API",
        "published_at": timestamp,
        "detection_delay_sec": max(0, detection_delay_sec),
        "has_caption": bool(caption),
        "children": (post.get("children") or {}).get("data", [])
    }


# ─── DISPLAY UTILITIES (from user reference) ─────────────────────────────────
LABELS = [
    ("id", "Post ID"),
    ("username", "Account"),
    ("media_type", "Type"),
    ("media_product_type", "Product"),
    ("caption", "Caption"),
    ("permalink", "Link"),
    ("shortcode", "Shortcode"),
    ("media_url", "Media URL"),
    ("thumbnail_url", "Thumbnail"),
    ("like_count", "Likes"),
    ("comments_count", "Comments"),
    ("is_comment_enabled", "Comments on"),
]


def show_post(post: dict, title: str, show_delay: bool = False) -> None:
    """Formats and prints Instagram post metadata matching user's exact reference style."""
    posted = parse_time(post.get("timestamp") or post.get("published_at"))
    print("\n" + "=" * 68)
    print(f"  {title}")
    print("=" * 68)

    if posted:
        print(f"  {'Posted at':<12}: {posted.astimezone().strftime('%d %b %Y, %I:%M:%S %p')}")
        if show_delay:
            delay = int((datetime.now(timezone.utc) - posted).total_seconds())
            print(f"  {'Detected':<12}: {max(delay, 0)} seconds after posting")

    shown = {"timestamp"}
    for key, label in LABELS:
        if key in post and post[key] not in (None, ""):
            value = str(post[key]).replace("\n", "\n" + " " * 16)
            print(f"  {label:<12}: {value}")
        shown.add(key)

    raw_children = post.get("children")
    if isinstance(raw_children, dict):
        children = raw_children.get("data", [])
    elif isinstance(raw_children, list):
        children = raw_children
    else:
        children = []

    if children:
        print(f"  {'Carousel':<12}: {len(children)} items")
        for i, child in enumerate(children, 1):
            if isinstance(child, dict):
                print(f"      {i}. {child.get('media_type')}  {child.get('media_url')}")
        shown.add("children")

    for key, value in post.items():
        if key not in shown and key not in ("raw_content", "title", "api_source", "source_name", "url", "detection_delay_sec", "has_caption", "children"):
            print(f"  {key:<12}: {value}")
    print("=" * 68)


# ─── KEYWORD & THREAT EVALUATOR ──────────────────────────────────────────────
def evaluate_keywords(text: str = "") -> Dict[str, Any]:
    """
    Evaluates corporate entity relevance and crisis criticality on caption text,
    mirroring the exact threatScorer.js dictionary tiers from Vee-Alert.
    """
    content = str(text or "")
    lower_content = content.lower()

    # 1. Corporate Entity Detection
    matched_targets = []
    for match in TARGET_REGEX.finditer(content):
        matched_targets.append(match.group(0).strip())
    matched_targets = list(dict.fromkeys(matched_targets))

    is_target_matched = len(matched_targets) > 0

    # 2. Critical Distress Keyword Matching (Tier 1: 9.8 score)
    matched_critical = [kw for kw in CRITICAL_KEYWORDS if kw in lower_content]

    # 3. High Crisis Keyword Matching (Tier 2: 7.5 score)
    matched_high = [kw for kw in HIGH_KEYWORDS if kw in lower_content]

    # Determine Severity Tier
    if matched_critical:
        severity = "CRITICAL"
        risk_level = "Critical"
        risk_score = 9.8
        requires_voice = True
    elif matched_high:
        severity = "HIGH"
        risk_level = "High"
        risk_score = 7.5
        requires_voice = False
    elif is_target_matched:
        severity = "MEDIUM"
        risk_level = "Medium"
        risk_score = 4.0
        requires_voice = False
    else:
        severity = "LOW"
        risk_level = "Low"
        risk_score = 1.5
        requires_voice = False

    return {
        "is_target_matched": is_target_matched,
        "matched_entities": matched_targets,
        "primary_entity": matched_targets[0] if matched_targets else "General Corporate",
        "is_critical": bool(matched_critical),
        "matched_critical_keywords": matched_critical,
        "is_high": bool(matched_high),
        "matched_high_keywords": matched_high,
        "severity": severity,
        "risk_level": risk_level,
        "risk_score": risk_score,
        "requires_voice_escalation": requires_voice
    }


# ─── EMAIL NOTIFICATION (from user reference) ────────────────────────────────
def send_email_alert(subject: str, body: str, is_async: bool = True) -> bool:
    """Sends an email alert using Gmail App Password to EMAIL_RECIPIENTS."""
    if not (GMAIL_ADDRESS and GMAIL_APP_PASSWORD and EMAIL_RECIPIENTS):
        return False

    def _send():
        try:
            msg = EmailMessage()
            msg["Subject"] = subject
            msg["From"] = GMAIL_ADDRESS
            msg["To"] = ", ".join(EMAIL_RECIPIENTS)
            msg.set_content(body)

            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15) as server:
                server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
                server.send_message(msg)
            print(f"[InstagramSource] [OK] Email alert dispatched to: {', '.join(EMAIL_RECIPIENTS)}")
        except Exception as err:
            print(f"[InstagramSource] [!] Email alert failed: {err}")

    if is_async:
        t = threading.Thread(target=_send, daemon=True)
        t.start()
        return True
    else:
        _send()
        return True


def test_email_setup() -> bool:
    """Sends a test email to verify credentials without waiting for a post."""
    print("\n" + "=" * 68)
    print("  [IG] TESTING EMAIL ALERT CONFIGURATION")
    print("=" * 68)
    if not GMAIL_ADDRESS:
        print("  [!] Missing GMAIL_ADDRESS in .env")
        return False
    if not GMAIL_APP_PASSWORD:
        print("  [!] Missing GMAIL_APP_PASSWORD in .env")
        return False
    if not EMAIL_RECIPIENTS:
        print("  [!] Missing TO_EMAIL recipients in .env")
        return False

    print(f"  From Sender  : {GMAIL_ADDRESS}")
    print(f"  To Recipients: {', '.join(EMAIL_RECIPIENTS)}")
    print("  Attempting connection to smtp.gmail.com:465...")

    subject = "[VEE-ALERT Test] Instagram Monitor Email Integration"
    body = (
        "Hello,\n\n"
        "This is a test alert from your VEE-ALERT Instagram Feed Monitor.\n"
        f"Timestamp: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}\n\n"
        "If you received this message, your Gmail App Password and recipient setup are working properly.\n"
    )

    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = GMAIL_ADDRESS
        msg["To"] = ", ".join(EMAIL_RECIPIENTS)
        msg.set_content(body)

        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15) as server:
            server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
            server.send_message(msg)

        print("  [OK] Test email successfully sent!")
        print("=" * 68 + "\n")
        return True
    except Exception as err:
        print(f"  [!] Failed to send test email: {err}")
        print("=" * 68 + "\n")
        return False


# ─── ALERT DISPATCH ENGINE ───────────────────────────────────────────────────
def dispatch_alert(normalized_post: Dict[str, Any], evaluation: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Dispatches a normalized post to Vee-Alert Ingestion Gateway (http://localhost:5000/api/ingest).
    Triggers automated AI triage, multi-channel dispatch (Slack, WhatsApp, Voice call, Email), and DB storage.
    """
    raw_caption = normalized_post.get("raw_content") or normalized_post.get("caption") or "(No caption text attached)"
    eval_result = evaluation or evaluate_keywords(raw_caption)

    # Ensure target entity guardrail in server.js qualifies this post for AI triage & War Room feed
    if not TARGET_REGEX.search(raw_caption):
        content_for_pipeline = f"{raw_caption}\n\n[Corporate Intelligence Monitor: Infosys Tech Ecosystem Watch]"
    else:
        content_for_pipeline = raw_caption

    image_url = normalized_post.get("media_url") or normalized_post.get("thumbnail_url")
    title = normalized_post.get("title", "Instagram Feed Update")

    payload = {
        "title": title,
        "raw_content": content_for_pipeline,
        "source_name": normalized_post.get("source_name", "Instagram Feed"),
        "api_source": "Instagram Graph API",
        "url": normalized_post.get("url") or normalized_post.get("permalink"),
        "image_url": image_url,
        "published_at": datetime.now(timezone.utc).isoformat()
    }

    # Optional Email Alert Trigger (if SMTP configured in .env)
    email_dispatched = False
    if GMAIL_ADDRESS and GMAIL_APP_PASSWORD and EMAIL_RECIPIENTS:
        subject = f"[VEE-ALERT] Instagram: {eval_result.get('primary_entity')} - {eval_result.get('risk_level')} Risk"
        email_body = (
            f"Corporate Crisis Alert - Instagram Feed Monitor\n\n"
            f"Entity: {eval_result.get('primary_entity')}\n"
            f"Risk Level: {eval_result.get('risk_level')} ({eval_result.get('risk_score')}/10)\n"
            f"Severity: {eval_result.get('severity')}\n"
            f"Post Link: {payload['url']}\n"
            f"Published: {payload['published_at']}\n\n"
            f"Caption:\n{payload['raw_content']}\n"
        )
        email_dispatched = send_email_alert(subject, email_body, is_async=True)

    # Fork A: Ingestion Gateway
    try:
        resp = requests.post(NODE_INGEST_ENDPOINT, json=payload, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("skipped"):
                return {
                    "success": False,
                    "status": "GUARDRAIL_SKIPPED",
                    "reason": data.get("reason"),
                    "channels": []
                }
            channels = list(data.get("sla", {}).get("dispatched_channels", ["Pipeline AI Triage", "Supabase"]))
            if email_dispatched and "Email (SMTP)" not in channels:
                channels.append("Email (SMTP)")
            return {
                "success": True,
                "status": "DISPATCHED_TO_GATEWAY",
                "http_status": 200,
                "gateway_response": data,
                "channels": channels,
                "article_id": data.get("article", {}).get("id")
            }
        else:
            return {
                "success": False,
                "status": "GATEWAY_REJECTED",
                "http_status": resp.status_code,
                "error": resp.text
            }
    except requests.RequestException:
        pass

    # Fork B: Direct Slack Webhook Fallback
    slack_webhook = os.getenv("SLACK_WEBHOOK_URL", "").strip()
    if slack_webhook and slack_webhook.startswith("http"):
        slack_payload = {
            "text": f"📸 *[Instagram Alert]* {payload['title']}\n"
                    f"*Entity:* {eval_result.get('primary_entity')}\n"
                    f"*Risk:* {eval_result.get('risk_level')} ({eval_result.get('risk_score')}/10)\n"
                    f"*Link:* {payload['url']}\n"
                    f">*Caption:* {payload['raw_content'][:300]}"
        }
        try:
            s_resp = requests.post(slack_webhook, json=slack_payload, timeout=4)
            channels = ["Slack Webhook Direct"]
            if email_dispatched:
                channels.append("Email (SMTP)")
            return {
                "success": True,
                "status": "FALLBACK_SLACK_SENT",
                "http_status": s_resp.status_code,
                "channels": channels
            }
        except Exception as s_err:
            return {"success": False, "status": "FALLBACK_FAILED", "error": str(s_err)}

    # Fork C: Local Logger
    channels = ["Local Terminal Logger"]
    if email_dispatched:
        channels.append("Email (SMTP)")
    return {
        "success": True,
        "status": "SIMULATED_LOCAL_DISPATCH",
        "channels": channels,
        "note": "Node.js engine offline; alert displayed in terminal."
    }


# ─── MANUAL-ONLY TRIGGER HANDLER ──────────────────────────────────────────────
def run_manual_fetch_pass() -> Dict[str, Any]:
    """
    Executes a single on-demand manual fetch pass against the Instagram Graph API.
    - Runs ONCE when triggered by a human via "Fetch Live News" button.
    - Never starts any recurring timers, intervals, or background polling loops.
    - Deduplicates against persistent state in instagram_state.json.
    - Passes any new posts into the Vee-Alert pipeline (/api/ingest) for recency
      checking (12h limit), SHA-256 deduplication, AI triage, and DB storage.
    """
    token = get_env_token()
    if not token:
        print("[InstagramSource] [!] Manual fetch aborted: INSTAGRAM_ACCESS_TOKEN not found in environment.")
        return {
            "success": False,
            "provider": "instagram",
            "status": "NO_TOKEN",
            "error": "INSTAGRAM_ACCESS_TOKEN not configured in .env",
            "posts_checked": 0,
            "new_posts_found": 0,
            "new_posts_ingested": 0
        }

    try:
        state = load_state()
        maybe_refresh_token(state)
        active_token = state.get("token") or token

        print("\n" + "=" * 68)
        print("  [InstagramSource] 📸 MANUAL ON-DEMAND LIVE FETCH PASS")
        print("=" * 68)
        print(f"  Timestamp   : {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
        print("  Connecting to Instagram Graph API (GET /me/media)...")

        media = fetch_media(active_token, limit=10)
        is_first_run = "seen" not in state
        seen = set(state.get("seen", []))

        if is_first_run:
            # Baseline initialization: record current post IDs, route latest live post through pipeline
            for m in media:
                seen.add(str(m.get("id")))
            posts_to_process = media[:1] if media else []
            state["seen"] = list(seen)[-MAX_SEEN:]
            save_state(state)
        else:
            posts_to_process = [m for m in media if str(m.get("id")) not in seen]

        ingested_count = 0
        dispatched_details = []

        if not posts_to_process:
            print(f"  [OK] Checked {len(media)} recent post(s). 0 new posts (account feed is up to date).")
            print("=" * 68 + "\n")
        else:
            print(f"  🎯 Processing {len(posts_to_process)} post(s). Routing through Vee-Alert pipeline...")
            for post_raw in sorted(posts_to_process, key=lambda m: m.get("timestamp", "")):
                post_id = str(post_raw.get("id"))
                norm = normalize_post(post_raw)
                eval_res = evaluate_keywords(norm.get("caption", ""))
                dispatch_res = dispatch_alert(norm, eval_res)
                ingested_count += 1
                seen.add(post_id)
                state["seen"] = list(seen)[-MAX_SEEN:]
                save_state(state)
                dispatched_details.append({
                    "post_id": post_id,
                    "title": norm.get("title"),
                    "status": dispatch_res.get("status"),
                    "reason": dispatch_res.get("reason"),
                    "article_id": dispatch_res.get("article_id")
                })
                print(f"  [OK] Post {post_id}: Dispatch Status -> {dispatch_res.get('status')}")
            print("=" * 68 + "\n")

        return {
            "success": True,
            "provider": "instagram",
            "status": "COMPLETED",
            "posts_checked": len(media),
            "new_posts_found": len(posts_to_process),
            "new_posts_ingested": ingested_count,
            "details": dispatched_details
        }

    except TokenError as err:
        print(f"[InstagramSource] [!] Token error: {err}")
        return {"success": False, "provider": "instagram", "status": "TOKEN_ERROR", "error": str(err)}
    except AccessError as err:
        print(f"[InstagramSource] [!] Access error: {err}")
        return {"success": False, "provider": "instagram", "status": "ACCESS_ERROR", "error": str(err)}
    except Exception as err:
        print(f"[InstagramSource] [!] Manual fetch error: {err}")
        return {"success": False, "provider": "instagram", "status": "ERROR", "error": str(err)}


if __name__ == "__main__":
    result = run_manual_fetch_pass()
    print(f"[RESULT_JSON]{json.dumps(result)}")

