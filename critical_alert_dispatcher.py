"""
Standalone Critical Alert Dispatcher Module.

Fires ALL THREE alert channels simultaneously ONLY when criticality is CRITICAL:
1. Telegram Bot Message (Formatted Executive 5-Bullet Intelligence Brief with Source Link)
2. Gmail Email Alert (SSL smtp.gmail.com:465 with HTML & plain-text brief)
3. Telegram Audio Call Ring (via tg-ringer CLI)

STRICT SUPPRESSION RULE:
DO NOT send message for LOW, Normal, HIGH, or anything other than CRITICAL.
Immediately skips and exits with 0 without dispatching anything.

WHAT CHANGED IN THIS VERSION (ringing fix / diagnostics):
- The tg-ringer call is no longer launched blind via `start /MIN` + shell=True.
  It now runs as an argument list (no shell quoting problems) and its output
  and exit code are captured and written to tg_ringer_call.log next to this file.
  The call is only reported SUCCESS if tg-ringer exits with code 0.
- RING_MODE=wait (default) keeps the process alive for the whole ring, so the call
  cannot be cut short. RING_MODE=detached launches it in the background instead
  (output still goes to the log file).
- The exact binary being used is printed, so you can tell if the Python, Node, Go
  or Rust build of tg-ringer is running. Override with TG_RINGER_BIN.
- Known Telegram errors (privacy restriction, flood wait, expired session, calling
  yourself) are detected in tg-ringer's output and explained in plain language.
- New test mode: python critical_alert_dispatcher.py --call-test
- Email HTML is now escaped (titles/URLs with < > & no longer break the layout).

.env keys used:
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
  GMAIL_SENDER_EMAIL (or GMAIL_ADDRESS), GMAIL_APP_PASSWORD, ALERT_RECEIVER_EMAIL (or TO_EMAIL)
  TG_API_ID, TG_API_HASH (read by tg-ringer itself)
  TG_RINGER_TARGET (or RING_TARGET) e.g. +91XXXXXXXXXX (with country code)
  RING_SECONDS default 30
  RING_MIN_SECONDS default 30 (lower it, e.g. 10, only for testing)
  RING_MODE wait | detached (default: wait)
  TG_RINGER_BIN optional full path to the tg-ringer executable
"""

import html
import json
import os
import shutil
import smtplib
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import requests
from dotenv import load_dotenv

# Search and load .env from multiple candidate locations
_current_dir = Path(__file__).resolve().parent
_env_candidates = [
    _current_dir / ".env",
    _current_dir / "server" / ".env",
    _current_dir.parent / ".env",
    Path.cwd() / ".env",
    Path.cwd() / "server" / ".env",
]

for env_file in _env_candidates:
    if env_file.is_file():
        load_dotenv(dotenv_path=env_file, override=False)

CALL_LOG_FILE = _current_dir / "tg_ringer_call.log"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def get_env_var(keys: Union[str, List[str]], default: Optional[str] = None) -> Optional[str]:
    """Retrieve environment variable supporting multiple alias names."""
    if isinstance(keys, str):
        keys = [keys]
    for key in keys:
        val = os.getenv(key)
        if val is not None and val.strip():
            return val.strip()
    return default


def _get_ring_seconds(override: Optional[int] = None) -> int:
    """Resolve ring duration, honouring RING_SECONDS and the RING_MIN_SECONDS floor."""
    if override is not None:
        seconds = override
    else:
        try:
            seconds = int(get_env_var(["RING_SECONDS"], "30"))
        except Exception:
            seconds = 30

    try:
        min_seconds = int(get_env_var(["RING_MIN_SECONDS"], "30"))
    except Exception:
        min_seconds = 30

    return max(seconds, min_seconds)


def format_five_bullet_brief(bullets: Union[str, List[str]]) -> str:
    """
    Format the 5-bullet executive intelligence brief cleanly.
    Headers:
      - What happened: ...
      - Why it matters: ...
      - Threat rating: ... / Risk score rationale: ...
      - Competitor impact: ...
      - Recommended action: ...
    """
    prefixes = [
        "What happened:",
        "Why it matters:",
        "Threat rating:",
        "Risk score rationale:",
        "Competitor impact:",
        "Recommended action:",
    ]

    items = []
    if isinstance(bullets, list):
        items = [str(x).strip() for x in bullets if str(x).strip()]
    elif isinstance(bullets, str):
        try:
            parsed = json.loads(bullets)
            if isinstance(parsed, list):
                items = [str(x).strip() for x in parsed if str(x).strip()]
            else:
                items = [line.strip() for line in bullets.split("\n") if line.strip()]
        except Exception:
            items = [line.strip() for line in bullets.split("\n") if line.strip()]
    else:
        items = [str(bullets).strip()]

    formatted = []
    for raw_item in items:
        clean_item = raw_item
        if clean_item.lower().startswith("executive 5-bullet"):
            continue
        clean_item = clean_item.lstrip("•-*0123456789.) ").strip()

        matched = False
        for prefix in prefixes:
            if clean_item.lower().startswith(prefix.lower()):
                header = clean_item[: len(prefix)]
                detail = clean_item[len(prefix):].strip()
                formatted.append(f"• {header} {detail}")
                matched = True
                break
        if not matched and clean_item:
            formatted.append(f"• {clean_item}")

    return "\n".join(formatted)


# --------------------------------------------------------------------------- #
# Channel 1: Telegram bot message
# --------------------------------------------------------------------------- #
def send_telegram_message(title: str, bullets: Union[str, List[str]], url: str = "") -> Dict[str, Any]:
    """
    Send an urgent Telegram alert to the configured chat via Telegram Bot API.

    🚨 [CRITICAL INTELLIGENCE ALERT] 🚨
    Headline: {title}

    📋 EXECUTIVE 5-BULLET INTELLIGENCE BRIEF:
    • What happened: ...
    • Why it matters: ...
    • Risk score rationale: ...
    • Competitor impact: ...
    • Recommended action: ...

    🔗 Source Link: {url}
    """
    token = get_env_var("TELEGRAM_BOT_TOKEN")
    chat_id = get_env_var("TELEGRAM_CHAT_ID")

    if not token or not chat_id:
        warn = "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured in .env"
        print(f"[!] Telegram alert skipped: {warn}")
        return {"channel": "telegram", "status": "SKIPPED", "error": warn}

    formatted_brief = format_five_bullet_brief(bullets)

    text_parts = [
        "🚨 [CRITICAL INTELLIGENCE ALERT] 🚨",
        f"Headline: {title}",
        "",
        "📋 EXECUTIVE 5-BULLET INTELLIGENCE BRIEF:",
        formatted_brief,
    ]
    if url:
        text_parts.extend(["", f"🔗 Source Link: {url}"])

    full_text = "\n".join(text_parts)

    api_url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": full_text[:4096],
        "disable_web_page_preview": False,
    }

    try:
        response = requests.post(api_url, json=payload, timeout=15)
        response.raise_for_status()
        print("telegram message : send")
        return {"channel": "telegram", "status": "SUCCESS"}
    except Exception as e:
        print(f"[✗] Telegram Failed: {e}")
        return {"channel": "telegram", "status": "FAILED", "error": str(e)}


# --------------------------------------------------------------------------- #
# Channel 2: Gmail
# --------------------------------------------------------------------------- #
def send_email_alert(title: str, bullets: Union[str, List[str]], url: str = "") -> Dict[str, Any]:
    """
    Send an urgent SSL email alert through Gmail (smtp.gmail.com:465).
    Sends multipart plain-text & styled HTML 5-bullet brief to ALERT_RECEIVER_EMAIL.
    """
    sender = get_env_var(["GMAIL_SENDER_EMAIL", "GMAIL_ADDRESS"])
    password = get_env_var("GMAIL_APP_PASSWORD")
    receiver = get_env_var(["ALERT_RECEIVER_EMAIL", "TO_EMAIL"])

    if not sender or not password or not receiver:
        missing = []
        if not sender:
            missing.append("GMAIL_SENDER_EMAIL")
        if not password:
            missing.append("GMAIL_APP_PASSWORD")
        if not receiver:
            missing.append("ALERT_RECEIVER_EMAIL")
        warn = f"Missing environment variable(s): {', '.join(missing)}"
        print(f"[!] Gmail alert skipped: {warn}")
        return {"channel": "email", "status": "SKIPPED", "error": warn}

    password = password.replace(" ", "")
    recipients = [r.strip() for r in receiver.split(",") if r.strip()]
    subject = f"[CRITICAL ALERT] {title}"

    formatted_brief = format_five_bullet_brief(bullets)

    msg = MIMEMultipart("alternative")
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject

    plain_body = (
        f"🚨 [CRITICAL INTELLIGENCE ALERT] 🚨\n"
        f"Headline: {title}\n\n"
        f"📋 EXECUTIVE 5-BULLET INTELLIGENCE BRIEF:\n"
        f"{formatted_brief}\n"
    )
    if url:
        plain_body += f"\n🔗 Source Link: {url}\n"

    html_bullets = ""
    for line in formatted_brief.split("\n"):
        if not line.strip():
            continue
        content = line[2:] if line.startswith("• ") else line
        html_bullets += f'<li style="margin-bottom: 8px;">{html.escape(content)}</li>'

    safe_title = html.escape(title)
    safe_url = html.escape(url, quote=True)

    html_link = (
        f'<p><a href="{safe_url}" style="display: inline-block; background: #dc2626; color: #ffffff; '
        f'padding: 10px 18px; text-decoration: none; border-radius: 4px; font-weight: bold;">'
        f'🔗 View Source Article / Post</a></p>'
        if url
        else ""
    )

    html_body = f"""\
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background-color: #f3f4f6; margin: 0; padding: 24px;">
  <div style="max-width: 620px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
    <div style="background-color: #dc2626; color: #ffffff; padding: 18px 24px;">
      <h1 style="margin: 0; font-size: 20px; font-weight: bold;">🚨 [CRITICAL ALERT] URGENT INTELLIGENCE NOTIFICATION</h1>
    </div>
    <div style="padding: 24px;">
      <h2 style="margin-top: 0; color: #111827; font-size: 18px;">{safe_title}</h2>
      <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
        <h3 style="margin: 0 0 10px 0; color: #991b1b; font-size: 15px;">EXECUTIVE 5-BULLET INTELLIGENCE BRIEF:</h3>
        <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #374151; line-height: 1.6;">
          {html_bullets}
        </ul>
      </div>
      {html_link}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0 16px 0;" />
      <p style="font-size: 12px; color: #9ca3af; margin: 0;">VEE-TECH Real-Time Intelligence & Critical Alert System</p>
    </div>
  </div>
</body>
</html>
"""
    msg.attach(MIMEText(plain_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as server:
            server.login(sender, password)
            server.sendmail(sender, recipients, msg.as_string())
        print("Gmail : send")
        return {"channel": "email", "status": "SUCCESS"}
    except Exception as e:
        print(f"[✗] Gmail Failed: {e}")
        return {"channel": "email", "status": "FAILED", "error": str(e)}


# --------------------------------------------------------------------------- #
# Channel 3: Telegram call ring (tg-ringer)
# --------------------------------------------------------------------------- #
def _find_tg_ringer_binary(vee_tech_root: Path) -> Optional[str]:
    """
    Find the tg-ringer executable.
    Order: TG_RINGER_BIN env var -> system PATH -> node_modules/.bin -> Python scripts dir.
    """
    override = get_env_var("TG_RINGER_BIN")
    if override and Path(override).is_file():
        return override

    for cmd_name in ["tg-ringer", "tg-ringer.cmd", "tg-ringer.exe"]:
        which_path = shutil.which(cmd_name)
        if which_path:
            return which_path

    # node_modules/.bin in vee_tech_root or server
    for base in [vee_tech_root, vee_tech_root / "server"]:
        node_bin = base / "node_modules" / ".bin"
        for name in ["tg-ringer.cmd", "tg-ringer.exe", "tg-ringer"]:
            cand = node_bin / name
            if cand.is_file():
                return str(cand)

    # Python executable directory and Scripts
    py_bin_dir = Path(sys.executable).parent
    for folder in [py_bin_dir, py_bin_dir / "Scripts"]:
        for name in ["tg-ringer.exe", "tg-ringer.cmd", "tg-ringer"]:
            cand = folder / name
            if cand.is_file():
                return str(cand)

    return None


def _explain_ringer_output(output: str) -> str:
    """Translate common tg-ringer / Telegram errors into a plain-language hint."""
    low = (output or "").lower()
    hints = []

    if "privacy" in low or "userprivacyrestricted" in low:
        hints.append(
            "Target's call privacy blocks this account. On the TARGET phone: Telegram > Settings > "
            "Privacy and Security > Calls > set 'Everybody', or add the userbot under 'Always allow'."
        )
    if "flood" in low or "too many" in low:
        hints.append("Telegram rate limit hit. Stop retrying for a while; avoid repeated test calls.")
    if "session" in low and ("expired" in low or "revoked" in low or "invalid" in low or "unauthorized" in low):
        hints.append("Userbot session is invalid. Run `tg-ringer login` again.")
    if "auth" in low and "key" in low and "unregistered" in low:
        hints.append("Userbot session was revoked. Run `tg-ringer login` again.")
    if "yourself" in low or "self" in low and "call" in low:
        hints.append("You cannot call yourself. The userbot account must differ from the target account.")
    if "no user" in low or "cannot find" in low or "not found" in low or "usernamenotoccupied" in low:
        hints.append("Target not found. Use the full number with country code (e.g. +91XXXXXXXXXX) that is on Telegram.")
    if "api_id" in low or "api_hash" in low:
        hints.append("TG_API_ID / TG_API_HASH missing or wrong. Get them from https://my.telegram.org.")

    return " | ".join(hints)


def _log_call(message: str) -> None:
    """Append a timestamped line to tg_ringer_call.log (never raises)."""
    try:
        with open(CALL_LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(f"[{datetime.now().isoformat(timespec='seconds')}] {message}\n")
    except Exception:
        pass


def trigger_tg_call(seconds: Optional[int] = None) -> Dict[str, Any]:
    """
    Place a Telegram ring via tg-ringer.

    RING_MODE=wait      (default) run in the foreground of this worker thread, capture output,
                        report real success/failure based on exit code.
    RING_MODE=detached  fire-and-forget in background; output goes to tg_ringer_call.log.
    """
    seconds = _get_ring_seconds(seconds)
    mode = (get_env_var("RING_MODE", "wait") or "wait").lower()

    current_dir = Path(__file__).resolve().parent
    vee_tech_root = current_dir if (current_dir / "node_modules").exists() else current_dir.parent
    target = get_env_var(["TG_RINGER_TARGET", "RING_TARGET"])
    bin_path = _find_tg_ringer_binary(vee_tech_root)

    if not bin_path:
        msg = "tg-ringer executable not found (pip install tg-ringer, or set TG_RINGER_BIN)."
        print(f"[!] Call skipped: {msg}")
        return {"channel": "call", "status": "SKIPPED", "error": msg}

    if not target:
        print("[i] No TG_RINGER_TARGET set; tg-ringer will use its own saved default target.")

    cmd = [bin_path, "call"]
    if target:
        cmd.append(target)
    cmd.extend(["--seconds", str(seconds)])

    print(f"call : using {bin_path}")
    print(f"call : {' '.join(cmd)}  (mode={mode})")
    _log_call(f"START mode={mode} cmd={' '.join(cmd)}")

    # ---------------- detached (background) mode ---------------- #
    if mode == "detached":
        try:
            log_fh = open(CALL_LOG_FILE, "a", encoding="utf-8")
            kwargs: Dict[str, Any] = {}
            if os.name == "nt":
                kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
            else:
                kwargs["start_new_session"] = True
            subprocess.Popen(
                cmd,
                cwd=str(vee_tech_root),
                stdin=subprocess.DEVNULL,
                stdout=log_fh,
                stderr=log_fh,
                **kwargs,
            )
            print(f"call : launched in background (output -> {CALL_LOG_FILE.name})")
            return {"channel": "call", "status": "LAUNCHED", "log": str(CALL_LOG_FILE)}
        except Exception as e:
            print(f"[✗] TG-Ringer Failed to launch: {e}")
            _log_call(f"LAUNCH ERROR {e}")
            return {"channel": "call", "status": "FAILED", "error": str(e)}

    # ---------------- wait (foreground, verified) mode ---------------- #
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(vee_tech_root),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=seconds + 90,  # ring time + connect/login headroom
        )
    except subprocess.TimeoutExpired:
        err = f"tg-ringer did not finish within {seconds + 90}s"
        print(f"[✗] TG-Ringer Failed: {err}")
        _log_call(f"TIMEOUT {err}")
        return {"channel": "call", "status": "FAILED", "error": err}
    except Exception as e:
        print(f"[✗] TG-Ringer Failed: {e}")
        _log_call(f"ERROR {e}")
        return {"channel": "call", "status": "FAILED", "error": str(e)}

    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    combined = "\n".join(x for x in (out, err) if x)
    _log_call(f"EXIT {proc.returncode}\n--- stdout ---\n{out}\n--- stderr ---\n{err}\n--------------")

    if proc.returncode == 0:
        print("call : done (tg-ringer exit code 0)")
        if out:
            print(f"call output: {out[-400:]}")
        return {"channel": "call", "status": "SUCCESS", "output": out[-400:]}

    hint = _explain_ringer_output(combined)
    print(f"[✗] TG-Ringer exited with code {proc.returncode}")
    if combined:
        print(f"    output: {combined[-600:]}")
    if hint:
        print(f"    hint  : {hint}")
    print(f"    full log: {CALL_LOG_FILE}")
    return {
        "channel": "call",
        "status": "FAILED",
        "error": combined[-600:] or f"exit code {proc.returncode}",
        "hint": hint,
    }


# --------------------------------------------------------------------------- #
# Master dispatcher
# --------------------------------------------------------------------------- #
def dispatch_alert(title: str, text: Union[str, List[str]], url: str = "", criticality: str = "LOW") -> Dict[str, Any]:
    """
    Master Dispatcher function.
    STRICT RULE: Only dispatches when criticality.upper() == 'CRITICAL'.
    For any other level (LOW, NORMAL, MEDIUM, HIGH), exits immediately with [SKIP].
    """
    crit_level = (criticality or "").strip().upper()

    if crit_level != "CRITICAL":
        print(f"[SKIP] Non-critical alert ({crit_level or 'UNSPECIFIED'}) - skipping dispatch")
        return {
            "criticality": crit_level,
            "dispatched": False,
            "reason": "non_critical",
            "results": {},
        }

    seconds = _get_ring_seconds()

    # Execute all 3 alert channels simultaneously
    jobs = {
        "telegram": lambda: send_telegram_message(title, text, url),
        "email": lambda: send_email_alert(title, text, url),
        "call": lambda: trigger_tg_call(seconds=seconds),
    }

    results = {}
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {name: pool.submit(fn) for name, fn in jobs.items()}
        for name, future in futures.items():
            try:
                results[name] = future.result()
            except Exception as e:
                results[name] = {"channel": name, "status": "FAILED", "error": str(e)}

    return {
        "criticality": crit_level,
        "dispatched": True,
        "results": results,
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    # Ring-only test: python critical_alert_dispatcher.py --call-test [seconds]
    if len(sys.argv) > 1 and sys.argv[1] == "--call-test":
        test_seconds = None
        if len(sys.argv) > 2:
            try:
                test_seconds = int(sys.argv[2])
                # allow short test rings without editing .env
                os.environ["RING_MIN_SECONDS"] = str(min(test_seconds, 30))
            except ValueError:
                pass
        result = trigger_tg_call(seconds=test_seconds)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        sys.exit(0 if result.get("status") in ("SUCCESS", "LAUNCHED") else 1)

    if len(sys.argv) > 1 and sys.argv[1] == "--json":
        try:
            data = json.loads(sys.argv[2])
            crit = str(data.get("criticality", "CRITICAL")).strip().upper()

            # STRICT CHECK: If not CRITICAL, exit immediately with 0
            if crit != "CRITICAL":
                print(f"[SKIP] Non-critical alert ({crit}) - suppressed.")
                sys.exit(0)

            bullets_data = (
                data.get("bullets")
                or data.get("five_bullet_summary")
                or data.get("message")
                or data.get("text")
                or []
            )

            dispatch_alert(
                title=data.get("title", "Critical Intelligence Incident"),
                text=bullets_data,
                url=data.get("url") or data.get("source_url") or "",
                criticality=crit,
            )
        except Exception as err:
            print(f"[!] Error parsing --json payload: {err}")
            sys.exit(1)
    else:
        test_title = sys.argv[1] if len(sys.argv) > 1 else "Critical Threat Detected"
        test_body = sys.argv[2] if len(sys.argv) > 2 else "Urgent crisis event requires review."
        test_crit = sys.argv[3] if len(sys.argv) > 3 else "CRITICAL"
        test_url = sys.argv[4] if len(sys.argv) > 4 else "https://vee-alert.local/crisis"

        dispatch_alert(test_title, test_body, url=test_url, criticality=test_crit)
