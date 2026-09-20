"""
Standalone Test & Live Monitor for Instagram Feed Ingestion
-----------------------------------------------------------
Monitors your own Professional (Business/Creator) Instagram account
through the Instagram Graph API.

Modes:
  1. Single Test Run:
     python test_instagram_check.py

  2. Continuous Live Polling Monitor:
     python test_instagram_check.py --poll

Configuration (.env):
  INSTAGRAM_ACCESS_TOKEN=your_long_lived_token  (required for live checks)
  POLL_SECONDS=30                               (optional, minimum 20)
"""

import sys
import time
from datetime import datetime
from pathlib import Path

# Ensure UTF-8 output on Windows console
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

from instagram_source import (
    load_state,
    save_state,
    maybe_refresh_token,
    fetch_account_info,
    fetch_media,
    normalize_post,
    show_post,
    evaluate_keywords,
    dispatch_alert,
    get_env_token,
    get_poll_interval,
    test_email_setup,
    TokenError,
    AccessError,
    ApiError,
    MAX_SEEN
)


def handle_post_pipeline(post: dict, is_new: bool = True) -> None:
    """Processes a post through keyword evaluation and alert dispatch."""
    title_label = "NEW POST DETECTED" if is_new else "EXISTING POST (Live Account Inspection)"
    show_post(post, title_label, show_delay=is_new)

    caption = post.get("caption") or "(No caption provided)"
    print("\n" + "-" * 68)
    print("  [KEYWORD & THREAT EVALUATION]")
    print("-" * 68)

    evaluation = evaluate_keywords(caption)

    target_matched = "YES" if evaluation["is_target_matched"] else "NO"
    entities_str = ", ".join(evaluation["matched_entities"]) if evaluation["matched_entities"] else "None"
    print(f"  {'Target Matched':<16}: {target_matched} ({entities_str})")
    print(f"  {'Primary Entity':<16}: {evaluation['primary_entity']}")
    print(f"  {'Critical Keys':<16}: {evaluation['matched_critical_keywords'] or 'None'}")
    print(f"  {'High Keys':<16}: {evaluation['matched_high_keywords'] or 'None'}")
    print(f"  {'Classification':<16}: {evaluation['severity']} (Risk: {evaluation['risk_level']} | Score: {evaluation['risk_score']}/10.0)")
    print(f"  {'Voice Escalation':<16}: {'YES [CRITICAL ALERT]' if evaluation['requires_voice_escalation'] else 'NO'}")

    print("\n" + "-" * 68)
    print("  [ALERT DISPATCH EXECUTION]")
    print("-" * 68)

    dispatch_res = dispatch_alert(post, evaluation)
    print(f"  {'Dispatch Status':<16}: {dispatch_res.get('status')}")
    if dispatch_res.get("reason"):
        print(f"  {'Status Detail':<16}: {dispatch_res['reason']}")
    print(f"  {'Active Channels':<16}: {', '.join(dispatch_res.get('channels', [])) or 'Pipeline Ingested / Cached'}")
    if dispatch_res.get("article_id"):
        print(f"  {'Ingested DB ID':<16}: {dispatch_res['article_id']}")
    if dispatch_res.get("gateway_response"):
        triage_summary = dispatch_res["gateway_response"].get("triage", {}).get("five_bullet_summary", [])
        if triage_summary:
            print(f"  {'AI Triage Brief':<16}:")
            for b in triage_summary[:3]:
                print(f"                    • {b}")
    if dispatch_res.get("error"):
        print(f"  {'Notice':<16}: {dispatch_res['error']}")
    print("=" * 68 + "\n")


def run_test_check() -> None:
    """Executes a real-time live check directly against the user's Instagram account."""
    token = get_env_token()

    print("\n====================================================================")
    print("  [IG] VEE-ALERT REAL-TIME INSTAGRAM ACCOUNT INSPECTION")
    print("====================================================================")
    print(f"  Timestamp   : {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"  Token Status: {'[OK] Detected in environment (' + token[:8] + '...' + token[-4:] + ')' if token else '[!] NOT DETECTED IN ENVIRONMENT'}")
    print("  Endpoints   : GET /me & GET /me/media")
    print("=" * 68)

    if not token:
        print("\n[!] Error: INSTAGRAM_ACCESS_TOKEN was not found in your environment.")
        print("\n--> ACTION REQUIRED:")
        print("    1. Open server/.env")
        print("    2. Make sure the line looks like: INSTAGRAM_ACCESS_TOKEN=your_token_here")
        print("    3. IMPORTANT: Press Ctrl + S in your editor to SAVE server/.env to disk!")
        print("\n(Note: Strictly real-time account data will be fetched; mock data is disabled.)\n")
        return

    try:
        # Step 1: Fetch Account Metadata & Token ID from /me
        print("\n[1/2] Connecting to Instagram Graph API (GET /me)...")
        account_info = fetch_account_info(token)
        account_id = account_info.get("id", "Unknown")
        username = account_info.get("username", "Unknown")
        account_type = account_info.get("account_type", "Standard/Personal")
        media_count = account_info.get("media_count", "N/A")

        print("\n" + "=" * 68)
        print("  [INSTAGRAM ACCOUNT PROFILE DATA]")
        print("=" * 68)
        print(f"  {'Token User ID':<16}: {account_id}")
        print(f"  {'Username':<16}: @{username}")
        print(f"  {'Account Type':<16}: {account_type}")
        print(f"  {'Total Media Posts':<16}: {media_count}")
        print("=" * 68)

        # Step 2: Fetch Live Media Posts from /me/media
        print("\n[2/2] Fetching live media posts from account (GET /me/media)...")
        state = load_state()
        maybe_refresh_token(state)
        media = fetch_media(state.get("token") or token, limit=10)

        if not media:
            print(f"\n[OK] Connected to account @{username} (ID: {account_id}).")
            print("     However, 0 posts were returned by the Instagram API.")
            print("     (If the account is private, ensure it is switched to a Professional account")
            print("     or generate the token with instagram_graph_user_media permission).")
            return

        print(f"\n[OK] Retrieved {len(media)} live post(s) from @{username}. Ingesting latest live post into Crisis War Room:\n")
        normalized = normalize_post(media[0], account_label=username)
        handle_post_pipeline(normalized, is_new=False)

    except TokenError as e:
        print(f"\n[!] Token Error (Code 190): {e}")
        print("    The token is either expired, revoked, or invalid. Please generate a fresh token.")
    except AccessError as e:
        print(f"\n[!] Instagram Access Error: {e}")
        print("    Please check that your account is a Professional account (Business or Creator)")
        print("    and that your Meta App has access to the account.")
    except ApiError as e:
        print(f"\n[!] Instagram API Error: {e} (Code: {e.code})")
    except Exception as e:
        print(f"\n[!] Connection Error: {e}")


def run_continuous_monitor() -> None:
    """Continuous polling loop matching the user's reference architecture."""
    token = get_env_token()
    if not token:
        print("\n[!] Error: INSTAGRAM_ACCESS_TOKEN is required for live monitoring.")
        print("Please set INSTAGRAM_ACCESS_TOKEN=your_token in server/.env and run again.\n")
        sys.exit(1)

    poll_seconds = get_poll_interval()
    state = load_state()
    baseline_needed = "seen" not in state
    seen = set(state.get("seen", []))
    announced = False
    failures = 0

    print(f"\nStarting Instagram Monitor - polling every {poll_seconds}s. Press Ctrl+C to stop.\n")

    while True:
        try:
            maybe_refresh_token(state)
            media = fetch_media(state.get("token") or token, limit=10)
            failures = 0

            if baseline_needed:
                seen = {m["id"] for m in media}
                baseline_needed = False
                announced = True
                print(f"[InstagramSource] Connected. {len(seen)} existing post(s) saved as baseline.")
                if media:
                    show_post(normalize_post(media[0]), "MOST RECENT EXISTING POST (for reference)")
                print("\nWatching for new posts...")
            else:
                new_posts = [m for m in media if m["id"] not in seen]
                if not announced:
                    announced = True
                    print("[InstagramSource] Connected. Watching for new posts...")

                for post_raw in sorted(new_posts, key=lambda m: m.get("timestamp", "")):
                    print("\a", end="")  # Terminal beep on new post
                    norm = normalize_post(post_raw)
                    handle_post_pipeline(norm, is_new=True)
                    seen.add(post_raw["id"])

            state["seen"] = list(seen)[-MAX_SEEN:]
            save_state(state)

            print(
                f"\r[{datetime.now().strftime('%I:%M:%S %p')}] Checked - watching... (next check in {poll_seconds}s)   ",
                end="",
                flush=True,
            )

        except TokenError as e:
            print(f"\n[Token Error] {e}\nPlease create a new long-lived token, put it in server/.env, and restart.")
            sys.exit(1)
        except AccessError as e:
            print(f"\n[Access Error] {e}\nEnsure your account is a Professional account with Instagram API permissions.")
            sys.exit(1)
        except (ApiError, Exception) as e:
            failures += 1
            wait = min(poll_seconds * (2 ** min(failures, 4)), 900)
            print(f"\nTemporary error ({e}). Retrying in {wait}s...")
            time.sleep(wait)
            continue

        time.sleep(poll_seconds)


def main():
    if "--test-email" in sys.argv:
        test_email_setup()
    elif "--poll" in sys.argv or "-p" in sys.argv:
        try:
            run_continuous_monitor()
        except KeyboardInterrupt:
            print("\n\n[InstagramSource] Monitor stopped by user.")
    else:
        run_test_check()


if __name__ == "__main__":
    main()
