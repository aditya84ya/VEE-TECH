"""
VEE-ALERT Regional Telegram FastWire Microservice
Listens to Indian financial and regional newsrooms (PTI, ANI, CNBC-TV18, Kerala channels)
via Telegram MTProto event streams and dispatches breaking news to the Node.js triage pipeline
within ~1-2 seconds of newsroom broadcast.

Usage:
  1. pip install -r requirements-fastwire.txt
  2. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in server/.env or pass as environment variables
  3. python regional_wire_daemon.py
"""

import os
import re
import sys
import asyncio
import requests
from telethon import TelegramClient, events

# Configuration
API_ID = os.getenv('TELEGRAM_API_ID', 'YOUR_API_ID')
API_HASH = os.getenv('TELEGRAM_API_HASH', 'YOUR_API_HASH')
NODE_ENDPOINT = os.getenv('NODE_INGEST_ENDPOINT', 'http://localhost:5000/api/ingest/raw')

TARGET_REGEX = re.compile(
    r'\b(infosys|infosys\s+adr|tcs|tata\s+consultancy|wipro|wipro\s+adr|accenture|finacle|kerala\s+it|technopark|infopark)\b',
    re.IGNORECASE
)

# Monitored Indian breaking news & regional news channels
MONITORED_CHANNELS = [
    'cnbctv18live',
    'ani_news_india',
    'economic_times_alerts',
    'moneycontrolcom',
    'ndtvprofit'
]

async def main():
    if API_ID == 'YOUR_API_ID' or API_HASH == 'YOUR_API_HASH':
        print("[FASTWIRE] ⚠️ Please set TELEGRAM_API_ID and TELEGRAM_API_HASH from https://my.telegram.org")
        print("[FASTWIRE] Exiting...")
        return

    print("[FASTWIRE] ⚡ Connecting to Telegram MTProto wire stream...")
    client = TelegramClient('vee_wire_session', int(API_ID), API_HASH)

    @client.on(events.NewMessage(chats=MONITORED_CHANNELS))
    async def handle_breaking_news(event):
        text = event.raw_text or ''
        if not text:
            return

        if TARGET_REGEX.search(text):
            chat_title = getattr(event.chat, 'title', None) or getattr(event.chat, 'username', 'Telegram Wire')
            first_line = text.split('\n')[0].strip()
            title = first_line[:120] + ('...' if len(first_line) > 120 else '')

            published_iso = event.date.isoformat() if event.date else None
            msg_url = f"https://t.me/{event.chat.username}/{event.id}" if getattr(event.chat, 'username', None) else "https://t.me/c"

            payload = {
                "title": f"[{chat_title}] {title}",
                "raw_content": text,
                "source_name": f"Telegram: {chat_title}",
                "api_source": "Telegram FastWire",
                "url": msg_url,
                "published_at": published_iso
            }

            try:
                # Dispatches immediately to VEE-ALERT Node.js Ingestion Gateway
                resp = requests.post(NODE_ENDPOINT, json=payload, timeout=3)
                print(f"[FASTWIRE] ⚡ Dispatched breaking alert ({resp.status_code}): {payload['title'][:60]}")
            except Exception as e:
                print(f"[FASTWIRE] ⚠️ Failed to dispatch alert: {e}")

    await client.start()
    print("⚡ VEE-ALERT Python FastWire ACTIVE. Listening to Indian live wire streams...")
    await client.run_until_disconnected()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[FASTWIRE] Stopped by user.")
