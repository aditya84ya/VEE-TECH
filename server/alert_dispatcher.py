"""
Standalone Critical Alert Dispatcher Module.

Fires ALL THREE alert channels simultaneously ONLY when criticality is CRITICAL:
1. Telegram Bot Message (Formatted Executive 5-Bullet Intelligence Brief with Source Link)
2. Gmail Email Alert (SSL smtp.gmail.com:465 with HTML & plain-text brief)
3. Telegram Audio Call Ring (via tg-ringer CLI background process)

STRICT SUPPRESSION RULE:
DO NOT send message for LOW, Normal, HIGH, or anything other than CRITICAL (risk_score >= 9.0).
Immediately skips and exits with 0 without dispatching anything.
"""

import json
import os
import shutil
import smtplib
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
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


def get_env_var(keys: Union[str, List[str]], default: Optional[str] = None) -> Optional[str]:
    """Retrieve environment variable supporting multiple alias names."""
    if isinstance(keys, str):
        keys = [keys]
    for key in keys:
        val = os.getenv(key)
        if val is not None and val.strip():
            return val.strip()
    return default


def format_five_bullet_brief(bullets: Union[str, List[str]]) -> str:
    """
    Format the 5-bullet executive intelligence brief cleanly with bold bullet headers.
    Headers:
      - What happened: ...
      - Why it matters: ...
      - Risk score rationale: ...
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
                detail = clean_item[len(prefix) :].strip()
                formatted.append(f"• {header} {detail}")
                matched = True
                break
        if not matched and clean_item:
            formatted.append(f"• {clean_item}")

    return "\n".join(formatted)


def send_telegram_message(title: str, bullets: Union[str, List[str]], url: str = "") -> Dict[str, Any]:
    """
    Send an urgent Telegram alert to the configured chat via Telegram Bot API.
    Builds the exact format required:
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

    html_bullets = "".join(
        f'<li style="margin-bottom: 8px;">{line.lstrip("• ")}</li>'
        for line in formatted_brief.split("\n")
        if line.strip()
    )

    html_link = (
        f'<p><a href="{url}" style="display: inline-block; background: #dc2626; color: #ffffff; '
        f'padding: 10px 18px; text-decoration: none; border-radius: 4px; font-weight: bold;">🔗 View Source Article / Post</a></p>'
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
      <h2 style="margin-top: 0; color: #111827; font-size: 18px;">{title}</h2>
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
    msg.attach(MIMEText(plain_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as server:
            server.login(sender, password)
            server.sendmail(sender, recipients, msg.as_string())
        print("Gmail : send")
        return {"channel": "email", "status": "SUCCESS"}
    except Exception as e:
        print(f"[✗] Gmail Failed: {e}")
        return {"channel": "email", "status": "FAILED", "error": str(e)}


def _find_tg_ringer_binary(vee_tech_root: Path) -> Optional[str]:
    """Find tg-ringer binary in system PATH, node_modules/.bin, or python scripts."""
    for cmd_name in ["tg-ringer", "tg-ringer.cmd", "tg-ringer.exe"]:
        which_path = shutil.which(cmd_name)
        if which_path:
            return which_path

    # Check node_modules/.bin in vee_tech_root or server
    for base in [vee_tech_root, vee_tech_root / "server"]:
        node_bin = base / "node_modules" / ".bin"
        for name in ["tg-ringer.cmd", "tg-ringer.exe", "tg-ringer"]:
            cand = node_bin / name
            if cand.is_file():
                return str(cand)

    # Check Python executable directory and Scripts
    py_bin_dir = Path(sys.executable).parent
    for name in ["tg-ringer.exe", "tg-ringer.cmd", "tg-ringer"]:
        cand = py_bin_dir / name
        if cand.is_file():
            return str(cand)

    scripts_dir = py_bin_dir / "Scripts"
    for name in ["tg-ringer.exe", "tg-ringer.cmd", "tg-ringer"]:
        cand = scripts_dir / name
        if cand.is_file():
            return str(cand)

    return None


def trigger_tg_call(seconds: Optional[int] = None) -> Dict[str, Any]:
    if seconds is None:
        try:
            seconds = int(get_env_var(["RING_SECONDS"], "30"))
        except Exception:
            seconds = 30

    if seconds < 30:
        seconds = 30

    current_dir = Path(__file__).resolve().parent
    vee_tech_root = current_dir if (current_dir / "node_modules").exists() else current_dir.parent
    target = get_env_var(["TG_RINGER_TARGET", "RING_TARGET"])
    bin_path = _find_tg_ringer_binary(vee_tech_root)

    if not bin_path:
        return {"channel": "call", "status": "SKIPPED", "error": "Missing binary"}

    # Use Windows 'start' command to launch an independent, minimized console.
    # This completely divorces tg-ringer from Python's lifecycle.
    target_arg = f" {target}" if target else ""
    if os.name == "nt":
        cmd_str = f'start /MIN "" "{bin_path}" call{target_arg} --seconds {seconds}'
    else:
        cmd_str = f'"{bin_path}" call{target_arg} --seconds {seconds} > /dev/null 2>&1 &'

    try:
        subprocess.Popen(
            cmd_str,
            cwd=str(vee_tech_root),
            shell=True
        )
        print("call : done")
        return {"channel": "call", "status": "SUCCESS"}
    except Exception as e:
        print(f"[✗] TG-Ringer Failed: {e}")
        return {"channel": "call", "status": "FAILED", "error": str(e)}


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

    try:
        seconds = int(get_env_var(["RING_SECONDS"], "30"))
    except Exception:
        seconds = 30

    if seconds < 30:
        seconds = 30

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


if __name__ == "__main__":
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
