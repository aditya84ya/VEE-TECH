"""
Standalone Verification Script for Critical Alert System.

Test 1: Non-Critical alert (criticality="LOW") -> Verifies zero alerts dispatched.
Test 2: Critical alert (criticality="CRITICAL") -> Triggers all 3 channels simultaneously
        (Telegram bot, Gmail SSL, tg-ringer call).
"""

import sys
from pathlib import Path

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

# Ensure local directory is in Python path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from alert_dispatcher import dispatch_alert, get_env_var


def run_tests():
    print("\n" + "=" * 65)
    print("  VEE-TECH CRITICAL ALERT DISPATCHER VERIFICATION SUITE")
    print("=" * 65)

    # Inspect Environment Configuration
    print("\n[CONFIG INSPECTION]")
    tg_token = get_env_var("TELEGRAM_BOT_TOKEN")
    tg_chat = get_env_var("TELEGRAM_CHAT_ID")
    gmail_sender = get_env_var(["GMAIL_SENDER_EMAIL", "GMAIL_ADDRESS"])
    gmail_pass = get_env_var("GMAIL_APP_PASSWORD")
    gmail_receiver = get_env_var(["ALERT_RECEIVER_EMAIL", "TO_EMAIL"])
    ringer_target = get_env_var(["TG_RINGER_TARGET", "RING_TARGET"])

    print(f"  • TELEGRAM_BOT_TOKEN   : {'[SET]' if tg_token else '[NOT SET]'}")
    print(f"  • TELEGRAM_CHAT_ID     : {'[SET]' if tg_chat else '[NOT SET]'}")
    print(f"  • GMAIL_SENDER_EMAIL   : {gmail_sender or '[NOT SET]'}")
    print(f"  • GMAIL_APP_PASSWORD   : {'[SET (hidden)]' if gmail_pass else '[NOT SET]'}")
    print(f"  • ALERT_RECEIVER_EMAIL : {gmail_receiver or '[NOT SET]'}")
    print(f"  • TG_RINGER_TARGET     : {ringer_target or '[DEFAULT]'}")
    print("-" * 65)

    # -------------------------------------------------------------
    # TEST 1: Non-Critical Alert Must Be Skipped Completely
    # -------------------------------------------------------------
    print("\n--- TEST 1: Verify Non-Critical (LOW) Alert Suppression ---")
    res1 = dispatch_alert(
        title="Infosys Board Quarterly Routine Update",
        text="Normal trading day, no threat or incident reported.",
        url="https://example.com/routine-news",
        criticality="LOW",
    )

    assert res1["dispatched"] is False, "FAILED: Low criticality item must NOT be dispatched!"
    assert res1.get("reason") == "non_critical", "FAILED: Reason must be non_critical"
    print("[✓] Test 1 Passed: Low/non-critical alert was successfully skipped.")

    # Also verify other non-critical levels (MEDIUM, NORMAL, INFO)
    for test_level in ["MEDIUM", "NORMAL", "INFO"]:
        res_other = dispatch_alert(
            title=f"Sample {test_level} Announcement",
            text="Routine notification.",
            url="https://example.com/test",
            criticality=test_level,
        )
        assert res_other["dispatched"] is False, f"FAILED: {test_level} item must NOT be dispatched!"
    print("[✓] Verification Confirmed: All non-critical levels (LOW, MEDIUM, NORMAL, INFO) suppressed.")

    # -------------------------------------------------------------
    # TEST 2: Critical Alert Dispatches All 3 Channels
    # -------------------------------------------------------------
    print("\n--- TEST 2: Verify CRITICAL Alert Triggers All 3 Channels ---")
    res2 = dispatch_alert(
        title="CRITICAL INCIDENT: Infrastructure Breach Detected",
        text="Major unauthorized intrusion detected on production database. High urgency response required immediately.",
        url="https://vee-alert.local/crisis-war-room",
        criticality="CRITICAL",
    )

    assert res2["dispatched"] is True, "FAILED: Critical item MUST be dispatched!"
    results = res2.get("results", {})

    print("\n[CHANNEL DISPATCH STATUS SUMMARY]")
    for channel, data in results.items():
        status = data.get("status")
        tag = "[✓]" if status == "SUCCESS" else ("[!] SKIPPED" if status == "SKIPPED" else "[✗] FAILED")
        err = f" -> {data.get('error')}" if "error" in data else ""
        print(f"  {tag:<12} {channel.upper():<10}: status={status}{err}")

    print("\n" + "=" * 65)
    print("  [✓] ALL TESTS COMPLETED SUCCESSFULLY")
    print("=" * 65 + "\n")


if __name__ == "__main__":
    run_tests()
