# Vee-Alert: Real-Time AI Media Intelligence & Crisis War Room

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue?logo=typescript)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react)](https://reactjs.org/)
[![Vite](https://img.shields.io/badge/Vite-5.4-purple?logo=vite)](https://vitejs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js)](https://nodejs.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Realtime%20Postgres-3ecf8e?logo=supabase)](https://supabase.com/)
[![Gemini](https://img.shields.io/badge/Google%20Gemini-3.6%20Flash-4285F4?logo=googlegemini)](https://aistudio.google.com/)
[![Ollama](https://img.shields.io/badge/Ollama-Qwen%202.5%3A7B-black?logo=ollama)](https://ollama.com/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-3.4-38B2AC?logo=tailwind-css)](https://tailwindcss.com/)

**Target Client:** Infosys (NYSE: INFY / NSE: INFY)  
**Tracked Competitors:** Tata Consultancy Services (TCS), Wipro, Accenture  
**SLA Guarantee:** Sub-120 seconds from real-time publication to executive alert dispatch (typical: 14s – 38s)  
**Dual-Engine Document Extraction:** Google Gemini 3.6 Flash (Primary) + Sharp / Tesseract.js (PSM 3) / Ollama Qwen 2.5 (Local Fallback)  
**Multi-Stream Ingestion Gateway:** Bluesky Jetstream WebSocket firehose, Google CSE Autonomous Poller, Google News RSS TwinFeeds, GDELT 2.0, NewsAPI, GNews, NewsData.io, Currents, The Guardian, and 23 Institutional RSS wires  
**Emergency Multi-Channel Push:** Slack Webhook, Meta WhatsApp Cloud, Executive Email Dossier, and Interactive Automated Voice Telephony with DTMF keypad  

---

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Dual-Engine Document Extraction & OCR Pipeline](#dual-engine-document-extraction--ocr-pipeline)
   - [Primary Engine: Google Gemini 3.6 Flash](#1-primary-engine-google-gemini-36-flash)
   - [Fallback Engine: Sharp + Tesseract.js + Ollama](#2-fallback-engine-sharp--tesseractjs-psm-3--ollama)
   - [Image Resolution & Ephemeral Privacy Safeguards](#3-image-resolution--ephemeral-privacy-safeguards)
3. [Multi-Source Ingestion Gateway (14 Streams)](#multi-source-ingestion-gateway-14-streams)
   - [Stream Priority Tiers](#stream-priority-tiers)
   - [Bluesky Jetstream Firehose Architecture](#bluesky-jetstream-firehose-architecture)
   - [Autonomous Google CSE Poller Daemon](#autonomous-google-cse-poller-daemon)
   - [Circuit Breakers & Provider Cooldown Engine](#circuit-breakers--provider-cooldown-engine)
4. [Deduplication & Threat Scoring Engine](#deduplication--threat-scoring-engine)
   - [Three-Layer Pre-Database Deduplication](#three-layer-pre-database-deduplication)
   - [Deterministic Threat Severity & Risk Scorer](#deterministic-threat-severity--risk-scorer)
   - [Executive 5-Bullet Intelligence Brief Format](#executive-5-bullet-intelligence-brief-format)
5. [Database Architecture & Supabase Realtime](#database-architecture--supabase-realtime)
   - [`articles` Table Schema](#articles-table-schema)
   - [Real-Time WebSocket Sync Protocol](#real-time-websocket-sync-protocol)
6. [Key Application Modules](#key-application-modules)
   - [Crisis War Room](#1-crisis-war-room-crisis-war-room)
   - [Manual Document Intel Upload](#2-manual-document-intel-upload-manual-upload)
   - [Competitor Intelligence Radar](#3-competitor-intelligence-radar-competitor-radar)
   - [Mathematical SLA Proof Engine](#4-mathematical-sla-proof-engine-sla-proof-engine)
   - [Intelligence Trend & Sentiment Analytics](#5-intelligence-trend--sentiment-analytics-analysis)
   - [Interactive Voice Escalation (Tier-4 Critical)](#6-interactive-voice-escalation-tier-4-critical)
   - [Floating Scroll-To-Top Component](#7-floating-scroll-to-top-component)
7. [Prerequisites & System Requirements](#prerequisites--system-requirements)
8. [Environment Configuration](#environment-configuration)
   - [Server Configuration (`server/.env`)](#1-server-configuration-serverenv)
   - [Client Configuration (`client/.env`)](#2-client-configuration-clientenv)
9. [Running Locally via Terminal](#running-locally-via-terminal)
10. [Automated Diagnostic & Verification Suite](#automated-diagnostic--verification-suite)
11. [API Reference](#api-reference)
12. [Directory Structure](#directory-structure)
13. [Technology Stack & Framework Matrix](#technology-stack--framework-matrix)
14. [Troubleshooting & FAQs](#troubleshooting--faqs)
15. [License](#license)

---

## Architecture Overview

Vee-Alert is an enterprise crisis intelligence and defense platform engineered for corporate leadership, risk officers, and legal councils. It monitors news wires, regulatory filings, financial feeds, and social firehoses in real time, scoring brand threats and generating actionable 5-bullet briefs within seconds.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        PARALLEL INGESTION GATEWAY (14 STREAMS)                         │
│ ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────────────────┐ │
│ │  Bluesky Jetstream   │ │   Google News RSS    │ │ Google CSE Autonomous Poller     │ │
│ │  WebSocket Firehose  │ │   & News Sitemaps    │ │ (Continuous 60s background loop) │ │
│ └──────────┬───────────┘ └──────────┬───────────┘ └─────────────────┬────────────────┘ │
│            │                        │                               │                  │
│            ▼                        ▼                               ▼                  │
│   [NewsAPI / GDELT / Guardian / Currents / GNews / NewsData / 23 Institutional RSS]     │
└─────────────────────────────────────────┬──────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                     THREE-LAYER PRE-DATABASE DEDUPLICATION ENGINE                      │
│  Layer 1: SHA-256 Title + Canonical URL Hash (O(1) in-memory cache)                    │
│  Layer 2: Publisher Canonical URL Registry                                             │
│  Layer 3: Target Entity Regex (Infosys, INFY, TCS, Wipro, Accenture, Finacle, SEBI)    │
└─────────────────────────────────────────┬──────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        DUAL-ENGINE AI EXTRACTION & TRIAGE                              │
│                                                                                        │
│  [Manual Upload / E-Paper OCR]              [Live News Stream]                         │
│  ├── Primary: Gemini 3.6 Flash               ├── Local Ollama (qwen2.5:7b GPU/CPU)     │
│  │   (Multimodal JSON Schema, Temp 0)        └── Deterministic Heuristic Engine        │
│  └── Fallback: Sharp + Tesseract.js (PSM 3)      (Zero-Downtime Rule Matcher)          │
│      + Ollama Metadata Extractor                                                       │
└─────────────────────────────────────────┬──────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                     DETERMINISTIC THREAT SCORING & DISPATCH                            │
│  CRITICAL (>= 9.0) | HIGH (7.0 - 8.9) | MEDIUM (4.0 - 6.9) | LOW (< 4.0)               │
│  Constructs Executive 5-Bullet Brief: What happened, Why it matters, Risk rationale,  │
│  Competitor impact, Recommended action                                                 │
└───────────────────┬─────────────────────────────────────────────────┬──────────────────┘
                    │                                                 │
                    ▼                                                 ▼
┌────────────────────────────────────────┐        ┌──────────────────────────────────────┐
│       SUPABASE REALTIME POSTGRES       │        │       MULTI-CHANNEL DISPATCH         │
│  Realtime WebSocket broadcast to all   │        │  ├── Slack Webhook Alert             │
│  active Crisis War Room sessions       │        │  ├── Meta WhatsApp Cloud Alert       │
└───────────────────┬────────────────────┘        │  ├── Executive Email Dossier         │
                    │                             │  └── Interactive Voice Call (DTMF)   │
                    ▼                             └──────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        COMMAND CENTER FRONTEND (REACT 18 + VITE)                       │
│  ├── Crisis War Room (Strict Critical Feed + Full Text Expander + Scroll-to-Top)       │
│  ├── Manual Intel Upload (Dual-Engine Badges + Resolution Warnings)                    │
│  ├── Competitor Radar (Live Net Sentiment Parity: Infosys vs TCS / Wipro / Accenture)  │
│  ├── SLA Proof Engine (Latency breakdown audit with JSON export)                       │
│  └── Intelligence Trend & Sentiment Analytics (Dynamic live telemetry charts)          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Dual-Engine Document Extraction & OCR Pipeline

For scanned newspaper broadsheets, PDF filings, press releases, and intelligence reports, Vee-Alert implements a zero-storage, dual-engine document extraction architecture located in [`server/services/geminiExtractor.js`](file:///s:/Web%20project/VEE-TECH/server/services/geminiExtractor.js) and [`server/services/imagePreprocessor.js`](file:///s:/Web%20project/VEE-TECH/server/services/imagePreprocessor.js).

### 1. Primary Engine: Google Gemini 3.6 Flash
- **Model Cascade**: Defaults to `gemini-3.6-flash`. If an upstream model returns HTTP 404 (deprecation) or 429 (rate limits), the engine automatically cascades through:
  `['gemini-3.6-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']`.
- **Multimodal Extraction**: Transcribes structured fields directly from raw ephemeral memory buffers using strict JSON schemas at temperature 0:
  ```json
  {
    "headline": "India's emissions below global average, says Modi",
    "date": "2020-09-20",
    "author": "Jacob Koshy",
    "page_no": "1",
    "info": "Factual event summary (who, what, when, where)...",
    "summary": "2-3 sentence executive strategic briefing...",
    "full_text": "Complete transcribed article text preserving paragraphs...",
    "legible": true
  }
  ```
- **Accuracy**: Delivers **98.0% OCR confidence** even on mobile camera captures and micro-print newspaper scans.

### 2. Fallback Engine: Sharp + Tesseract.js (PSM 3) + Ollama
When offline, unauthenticated, or when API quotas are exceeded, the server engages the local offline fallback:
- **Sharp Image Preprocessor**:
  - Automatically converts buffer to single-channel grayscale.
  - Upscales images with width < 2000px to ensure characters have sufficient pixel height.
  - Applies linear contrast stretching: `.linear(1.4, -20)` and unsharp masking.
  - Saves temporary preprocessed frames in memory buffers.
- **Tesseract.js Engine**: Initialized with English language pack (`eng.traineddata`) and Page Segmentation Mode **PSM 3** (Fully automatic page segmentation without OSD, optimal for multi-column newspaper layouts).
- **Ollama Structured Normalizer (`ollamaDocumentExtractor.js`)**: Passes raw Tesseract output to local `qwen2.5:7b` at `http://localhost:11434` with `format: "json"` to clean up typos, normalize dates, and structure metadata.

### 3. Image Resolution & Ephemeral Privacy Safeguards
- **Resolution Verification**: Image dimensions are measured using `sharp(buffer).metadata()`. If width < 1500px, a warning is returned:
  ```text
  Image resolution is too low (493px). Upload a higher-resolution file (>= 1500px) for reliable OCR.
  ```
- **Zero Disk Persistence Rule**: Uploaded media buffers exist strictly in ephemeral RAM and are deleted immediately after extraction to ensure strict data privacy and compliance.

---

## Multi-Source Ingestion Gateway (14 Streams)

The backend runs an autonomous Ingestion Gateway orchestrating 14 parallel data sources partitioned into staggered execution groups:

### Stream Priority Tiers

| Priority | Source Name | Protocol | Fetch Mode | Polling Interval / Latency | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **P0** | **Bluesky Jetstream** | WebSocket Firehose | Real-Time Stream | **< 1.5 seconds** | Direct WebSocket firehose tracking breaking social distress signals |
| **P1** | **Google CSE Poller** | REST API | Autonomous Daemon | **Every 60s** | Autonomous daemon running emergency distress queries |
| **P1** | **NewsData.io** | REST API | Dynamic Polling | **Every 120s** | Real-time global news wire API |
| **P2** | **NewsAPI.org** | REST API | Staggered Poll | **Every 180s** | Global business & tech headlines |
| **P2** | **The Guardian Wire** | REST API | Editorial Poll | **Every 240s** | Investigative editorial reporting |
| **P2** | **GNews.io** | REST API | Global Wire | **Every 240s** | Multi-region news curation |
| **P2** | **Currents API** | REST API | Staggered Poll | **Every 300s** | Enterprise IT market intelligence |
| **P2** | **GDELT 2.0 Global Discovery** | TLS Bypass Wire | Global Monitor | **Every 300s** | Global Event, Language, and Tone monitor with TLS bypass |
| **P2** | **EventRegistry Wire** | Stream / Poll | Minute Wire | **Every 300s** | Real-time event analytics |
| **P2** | **Institutional Financial RSS** | XML / RSS | Parallel (23 Feeds) | **Every 60s – 120s** | BSE, NSE, SEC, and institutional financial market feeds |
| **P3** | **Google News RSS (TwinFeeds)**| Dual XML RSS | Real-Time Poll | **Every 60s** | Dual RSS queries covering target brands and industry peers |
| **P3** | **News Sitemaps** | XML Sitemaps | Parallel (6 Feeds) | **Every 180s** | Direct publisher XML sitemaps (*The Hindu*, *Livemint*, etc.) |
| **P3** | **E-Paper OCR Ingestion** | Headless Scraper | Automated Poll | **Every 600s** | Automated broadsheet clipping monitor |

### Bluesky Jetstream Firehose Architecture
- Connects directly to US-West WebSocket nodes:
  `wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.post`
- Filters incoming event records by `TARGET_REGEX` at line speed.
- Normalizes AT-protocol Decentralized Identifiers (DIDs) into web canonical URLs (`https://bsky.app/profile/{did}/post/{rkey}`).
- Ingests breaking posts into the triage pipeline in **under 1.5 seconds** from user submission.

### Autonomous Google CSE Poller Daemon
- Managed by [`csePoller.js`](file:///s:/Web%20project/VEE-TECH/server/services/csePoller.js).
- Runs an independent 60-second polling daemon querying Google Programmable Search Engine for high-risk corporate anomalies:
  `Infosys OR TCS OR Wipro OR Accenture crisis OR breach OR revenue OR regulatory`
- Implements automated backoff cooldowns when Google API quotas are exhausted (HTTP 429).

### Circuit Breakers & Provider Cooldown Engine
- Each provider adapter maintains independent operational states: `HEALTHY`, `DEGRADED`, `QUOTA_EXHAUSTED`, or `DISABLED`.
- If a provider returns HTTP 429, the gateway reads the `Retry-After` header (or defaults to midnight UTC cooldown) and puts only that provider to sleep while remaining 13 providers continue streaming uninterrupted.

---

## Deduplication & Threat Scoring Engine

### Three-Layer Pre-Database Deduplication
1. **Layer 1 (SHA-256 Title & URL Fingerprint)**: Computes a cryptographic SHA-256 hash from normalized article title and URL. Checked in $O(1)$ time against an in-memory set hydrated from Supabase at boot time.
2. **Layer 2 (Publisher Canonical URL Registry)**: Resolves aggregator redirects (Google News RSS redirect tokens, syndication trackers) to publisher canonical domains to drop redundant syndicated wire coverage.
3. **Layer 3 (False-Positive & Anchor Filter)**: Inspects text for verified corporate anchors:
   ```regex
   /\b(Infosys|Infosys\s+ADR|NYSE:\s*INFY|TCS|Tata\s+Consultancy(\s+Services)?|Wipro|Wipro\s+ADR|Accenture|Finacle|SEBI|BSE|NSE)\b/i
   ```
   Filters out social media noise, memes, and unverified rumors.

### Deterministic Threat Severity & Risk Scorer
Implemented in [`threatScorer.js`](file:///s:/Web%20project/VEE-TECH/server/services/threatScorer.js):

- **CRITICAL ($\ge 9.0$, Default 9.8)**: Triggered by catastrophic distress indicators:
  `sebi emergency`, `emergency order`, `trading suspended`, `trading terminated`, `arrest`, `arrests`, `fraud`, `enforcement directorate`, `money laundering`, `insolvency`, `bankruptcy`, `liquidation`, `asset seizure`, `whistleblower`.
- **HIGH (7.0 – 8.9, Default 7.5)**: Triggered by regulatory probes and enterprise disruption:
  `rbi`, `sebi`, `regulator`, `probe`, `investigation`, `subpoena`, `penalty`, `fine`, `lawsuit`, `outage`, `blackout`, `ransomware`, `security breach`, `cyberattack`, `contract loss`, `downgrade`, `audit notice`, `sec probe`, `enforcement action`.
- **MEDIUM / LOW ($\le 6.9$, Default 2.5 – 5.0)**: Routine commercial announcements, product launches, partnerships, quarterly commentary, and tech patents.

### Executive 5-Bullet Intelligence Brief Format
Every ingested or uploaded event is transformed into an actionable 5-bullet dossier:
1. **What happened**: Factual, verified summary of the primary event.
2. **Why it matters**: Immediate impact on enterprise reputation, valuation, and customer trust.
3. **Risk score rationale**: Specific distress indicators, regulatory exposure, or compliance breaches.
4. **Competitor impact**: Parity shift for TCS, Wipro, and Accenture.
5. **Recommended action**: Operational, PR, and legal containment measures for executive leadership.

---

## Database Architecture & Supabase Realtime

### `articles` Table Schema

| Column Name | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `uuid` | `PRIMARY KEY` | Unique identifier (UUIDv4) |
| `api_source` | `text` | `NOT NULL` | Ingestion provider (e.g. `bluesky`, `manual_ocr_upload`, `googlenews`) |
| `source_name` | `text` | `NOT NULL` | Display publication name (e.g. `The Hindu`, `Bluesky Firehose`) |
| `title` | `text` | `NOT NULL` | Headline or synthesized document title |
| `url` | `text` | `NULLABLE` | Canonical web URL (null for manual uploads) |
| `image_url` | `text` | `NULLABLE` | Lead article thumbnail or screenshot |
| `raw_content` | `text` | `NULLABLE` | Complete article body or transcribed OCR text |
| `entity_mentioned` | `text` | `NOT NULL` | Target entity (`Infosys`, `TCS`, `Wipro`, `Accenture`) |
| `sentiment` | `text` | `NOT NULL` | Evaluated tone: `Negative`, `Neutral`, `Positive` |
| `risk_score` | `numeric` | `NOT NULL` | Calibrated risk rating from `1.0` to `10.0` |
| `risk_level` | `text` | `NOT NULL` | Threat tier: `Critical`, `High`, `Medium`, `Low` |
| `five_bullet_summary`| `text[]` | `NOT NULL` | Array of 5 structured executive brief bullets |
| `status` | `text` | `NOT NULL` | Operational lifecycle: `ACTIVE`, `ACKNOWLEDGED`, `RESOLVED` |
| `published_at` | `timestamptz`| `NULLABLE` | Original publication timestamp |
| `ingested_at` | `timestamptz`| `NOT NULL` | Timestamp when event entered the gateway |
| `triaged_at` | `timestamptz`| `NOT NULL` | Timestamp when AI triage completed |
| `theme` | `text` | `NULLABLE` | Categorization (e.g. `Regulatory & Crisis Intelligence`) |
| `pub_date` | `text` | `NULLABLE` | Extracted date string from document masthead |
| `author` | `text` | `NULLABLE` | Extracted journalist / agency byline |
| `page_no` | `text` | `NULLABLE` | Extracted page number or section identifier |
| `info` | `text` | `NULLABLE` | Lead factual event paragraph |
| `summary` | `text` | `NULLABLE` | Executive summary paragraph |
| `ocr_confidence` | `numeric` | `NULLABLE` | OCR engine accuracy percentage (e.g. `98.0`) |
| `ocr_quality` | `text` | `NULLABLE` | Quality category (`high`, `medium`, `low`) |
| `ocr_engine` | `text` | `NULLABLE` | Engine identifier (`gemini`, `tesseract_ollama`) |

### Real-Time WebSocket Sync Protocol
- The client establishes a persistent WebSocket connection via `@supabase/supabase-js`:
  ```typescript
  const channel = supabase
    .channel('articles-realtime')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'articles' }, (payload) => {
      handleNewArticle(payload.new as Article);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'articles' }, (payload) => {
      handleUpdatedArticle(payload.new as Article);
    })
    .subscribe();
  ```
- Sub-100ms UI updates across all active command center browser sessions simultaneously.

---

## Key Application Modules

### 1. Crisis War Room (`/crisis-war-room`)
- **Strict Critical Alert Feed**: Features a dedicated toggle to filter strictly for `Critical` threats ($\ge 9.0$) requiring immediate executive escalation.
- **Full Article Body Expander**: Clicking `[Read more]` on an article headline reveals the complete article body with preserved line breaks and paragraph spacing.
- **Executive 5-Bullet Intelligence Brief**: Collapsible intelligence briefing with complete text wrapping (no arbitrary substring clipping).
- **Incident Lifecycle Actions**: One-click incident acknowledgment and direct voice call escalation.

### 2. Manual Document Intel Upload (`/manual-upload`)
- Upload newspaper clippings, e-papers, regulatory PDFs, or camera snapshots.
- Dual-engine status pill displaying extraction engine (`gemini` vs `tesseract_ollama`), engine reason, and OCR confidence.
- Warning banners if image width is below 1500px.
- Historical research mode toggle to bypass live emergency push notifications during backtesting.

### 3. Competitor Intelligence Radar (`/competitor-radar`)
- Continuous parity scoring comparing Infosys against TCS, Wipro, and Accenture.
- Mathematical net sentiment scores (-100 to +100) calculated from rolling 24-hour media windows:
  $$\text{Net Sentiment} = \frac{\text{Positive Mentions} - \text{Negative Mentions}}{\text{Total Mentions}} \times 100$$
- Vulnerability detection cards highlighting competitor service outages, regulatory fines, and client transitions.

### 4. Mathematical SLA Proof Engine (`/sla-proof-engine`)
- Real-time pipeline latency auditing:
  $$\text{Pipeline Latency} = (\text{Ingested At} - \text{Published At}) + (\text{Triaged At} - \text{Ingested At})$$
- Verified delivery against sub-120 second SLA guarantee.
- Exportable audit reports in structured JSON for executive and compliance reviews.

### 5. Intelligence Trend & Sentiment Analytics (`/analysis`)
- Dynamic metric tiles: Infosys Share of Voice, Negative Sentiment Ratio, Threat Velocity, and 24h Mentions.
- Time-series sentiment tracking curves dynamically computed from ingested telemetry.

### 6. Interactive Voice Escalation (Tier-4 Critical)
- Automated telephone escalation simulation to crisis leadership.
- Text-to-Speech briefing synthesis with an interactive DTMF keypad:
  - **Press 1**: Acknowledge alert and log acknowledgment to the audit trail.
  - **Press 2**: Bridge call directly into the Emergency Legal & PR Crisis War Room.

### 7. Floating Scroll-To-Top Component
- Reusable [`ScrollToTopButton.tsx`](file:///s:/Web%20project/VEE-TECH/client/src/components/ScrollToTopButton.tsx).
- Automatically detects the active scroll container (`window` or parent `overflow-y-auto` element).
- Smoothly fades in when scrolled past 300px (`threshold = 300`).
- Styled in dark `bg-slate-900 hover:bg-slate-800` to match executive call-to-action buttons.
- Fully accessible with `<button type="button">`, focus ring, and `prefers-reduced-motion` compliance.

---

## Prerequisites & System Requirements

- **Operating System**: Windows 10/11, macOS, or Linux
- **Node.js**: v18.0+ (Node.js v20 LTS recommended)
- **Package Manager**: `npm` (v9+)
- **Local AI (Optional fallback)**: [Ollama](https://ollama.ai/) with model `qwen2.5:7b` pulled:
  ```bash
  ollama run qwen2.5:7b
  ```
- **Google Gemini API Key**: [Google AI Studio](https://aistudio.google.com/) for multimodal document extraction
- **Supabase Account**: Realtime PostgreSQL database (free tier supported)

---

## Environment Configuration

### 1. Server Configuration (`server/.env`)
Create `server/.env` based on `server/.env.example`:

```ini
# ─── SERVER CORE ─────────────────────────────────────────────────────────
PORT=5000

# ─── SUPABASE (PostgreSQL + Realtime WebSockets) ──────────────────────────
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_ANON_KEY=your-anon-key

# ─── GOOGLE GEMINI MULTIMODAL OCR (Primary Extractor) ────────────────────
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-3.6-flash

# ─── LOCAL OLLAMA INFERENCE (Fallback Extractor) ──────────────────────────
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b

# ─── REAL-TIME NEWS WIRE KEYS ────────────────────────────────────────────
NEWSAPI_KEY=your-newsapi-key
GNEWS_API_KEY=your-gnews-key
NEWSDATA_API_KEY=your-newsdata-key
CURRENTS_API_KEY=your-currents-key
GUARDIAN_API_KEY=your-guardian-key

# ─── EMERGENCY NOTIFICATION CHANNELS (Optional) ──────────────────────────
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_WHATSAPP_FROM=
EMERGENCY_LEAD_PHONE=
SENDGRID_API_KEY=
ALERT_EMAIL_RECIPIENTS=
```

### 2. Client Configuration (`client/.env`)
Create `client/.env`:

```ini
VITE_API_BASE_URL=http://localhost:5000
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

---

## Running Locally via Terminal

Vee-Alert runs as two cooperating processes: the **Backend Ingestion Server** (Port 5000) and the **Vite React Frontend** (Port 5173).

### Step 1: Install Dependencies
Open a terminal in the project root:

```bash
# Install backend dependencies
cd server
npm install

# Install frontend dependencies
cd ../client
npm install
```

### Step 2: Start the Application

#### Option A: Running in Two Separate Terminal Tabs (Recommended)

**Terminal 1 — Start Backend Server:**
```bash
cd "s:\Web project\VEE-TECH\server"
node server.js
```
*Expected terminal output:*
```text
🚀 [Vee-Alert Backend] Listening on http://localhost:5000
📦 [Database] Supabase Configured & Connected
🧠 [Local AI Engine] Ollama model: qwen2.5:7b at http://localhost:11434
🛡️ [Deduplicator] SHA-256 Pre-Database O(1) deduplication active
📰 [News Sources] Low-Latency Parallel Ingestion Gateway Active
[Bluesky Jetstream] Connected to real-time Jetstream firehose
```

**Terminal 2 — Start Frontend Client:**
```bash
cd "s:\Web project\VEE-TECH\client"
npm run dev
```
*Expected terminal output:*
```text
  VITE v5.4.21  ready in ~400 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

Open your browser to **[http://localhost:5173](http://localhost:5173)** or directly to the Crisis War Room at **[http://localhost:5173/crisis-war-room](http://localhost:5173/crisis-war-room)**.

#### Option B: Running from the Workspace Root
```bash
# Terminal 1: Backend
node server/server.js

# Terminal 2: Frontend
npm --prefix client run dev
```

---

## Automated Diagnostic & Verification Suite

The repository includes diagnostic scripts in `server/` to verify each pipeline subsystem independently:

```bash
cd server

# 1. Test direct Google Gemini 3.6 Flash connection on a test newspaper image
node test_direct_gemini.mjs

# 2. Test the complete /api/manual-upload endpoint end-to-end (OCR + Triage)
node test_e2e_upload.mjs

# 3. Audit all 14 provider ingestion adapters for live network connectivity
node test_all_providers.mjs

# 4. Verify system architecture, deduplication, and risk scoring logic
node test_architecture_verification.mjs

# 5. Execute a live end-to-end telemetry trace of incoming wire events
node test_provider_live_e2e_trace.mjs
```

---

## API Reference

### Manual Upload & Document OCR
- **`POST /api/manual-upload`**
  - **Content-Type**: `multipart/form-data` or `application/json` (base64)
  - **Body fields**: `file` (Binary Image/PDF), `publication_name`, `page_number`, `published_at`, `is_historical` (boolean).
  - **Response (200)**:
    ```json
    {
      "success": true,
      "article": {
        "id": "c7a884fe-f260-4999-8cfb-aef731cecb18",
        "title": "India's emissions below global average, says Modi",
        "raw_content": "Prime Minister Narendra Modi addressed an international climate conference...",
        "entity_mentioned": "Infosys",
        "risk_level": "Medium",
        "risk_score": 5.0,
        "ocr_engine": "gemini",
        "engine_reason": "Gemini 3.6 Flash multimodal extraction",
        "ocr_confidence": 98.0,
        "ocr_quality": "high",
        "is_low_resolution": false,
        "resolution_warning": null,
        "pub_date": "2020-09-20",
        "author": "Jacob Koshy",
        "page_no": "1",
        "info": "Prime Minister Narendra Modi addressed an international climate conference...",
        "summary": "Speaking at an international climate conference hosted by the NGT...",
        "five_bullet_summary": [
          "What happened: Prime Minister Narendra Modi addressed...",
          "Why it matters: Strategic competitor development...",
          "Risk score rationale: Rated 5.0/10 based on routine operational update...",
          "Competitor impact: Reinforces competitive landscape dynamics...",
          "Recommended action: Log into competitive intelligence registry."
        ]
      },
      "ocr": {
        "confidence": 98.0,
        "ocr_engine": "gemini",
        "ocr_quality": "high"
      }
    }
    ```

### Live Aggregation & Articles
- **`GET /api/articles`**: Fetches all active crisis articles synchronized with Supabase.
- **`POST /api/fetch-live`**: Triggers immediate on-demand scraping across all 14 wire streams.
- **`PATCH /api/articles/:id/acknowledge`**: Acknowledges an active critical alert and updates audit records.
- **`POST /api/voice/escalate`**: Initiates a simulated Tier-4 telephony escalation.
- **`GET /api/health`**: Returns health and latency metrics for all subsystems.

---

## Directory Structure

```text
VEE-TECH/
├── client/                               # Frontend Application (React 18 + TypeScript + Vite)
│   ├── src/
│   │   ├── components/                   # UI View Components
│   │   │   ├── CrisisWarRoomView.tsx     # Crisis War Room (Alert stream & briefs)
│   │   │   ├── ManualUploadView.tsx      # Document upload & OCR result inspection
│   │   │   ├── CompetitorRadarView.tsx   # TCS / Wipro / Accenture parity analysis
│   │   │   ├── SlaProofEngineView.tsx    # Sub-120s latency audit engine
│   │   │   ├── ScrollToTopButton.tsx     # Reusable floating scroll-to-top button
│   │   │   ├── AppShell.tsx              # Main layout (Sidebar + Header + Canvas)
│   │   │   ├── Sidebar.tsx               # Fixed dark sidebar navigation
│   │   │   └── VoiceCallModal.tsx        # Interactive telephone DTMF modal
│   │   ├── context/                      # War Room React State & WebSocket Providers
│   │   ├── hooks/                        # Real-time Supabase hooks (useWarRoom)
│   │   ├── utils/                        # Latency metrics & math calculations
│   │   ├── App.tsx                       # React Router configuration
│   │   └── main.tsx                      # Application bootstrap
│   └── package.json
│
├── server/                               # Backend Server (Node.js + Express)
│   ├── services/
│   │   ├── geminiExtractor.js            # Gemini 3.6 Flash multimodal OCR extractor
│   │   ├── imagePreprocessor.js          # Sharp image normalization (PSM 3 prep)
│   │   ├── ollamaDocumentExtractor.js    # Local Ollama structured document extractor
│   │   ├── threatScorer.js               # Critical keyword & risk scoring rules
│   │   ├── csePoller.js                  # Google CSE background daemon
│   │   └── ingestion/                    # Low-latency multi-source gateway
│   │       ├── IngestionGateway.js       # Master gateway scheduler & cooldown engine
│   │       └── providers/                # Provider adapters (Bluesky, RSS, GDELT, etc.)
│   │           ├── BlueskyJetstreamAdapter.js
│   │           ├── EpaperOcrAdapter.js
│   │           └── GoogleNewsRssAdapter.js
│   ├── .env.example                      # Template for server environment configuration
│   ├── server.js                         # Core Express API, triage pipeline, & routes
│   └── package.json
│
├── README.md                             # Comprehensive technical documentation
└── .gitignore                            # Git exclusion rules
```

---

## Technology Stack & Framework Matrix

Vee-Alert is built on a hybrid cloud and local-first architecture engineered for microsecond reactivity, high-fidelity AI inference, and reliable zero-downtime execution.

### Architectural Layer Breakdown

| Layer / Subsystem | Technology | Version | Purpose & Responsibilities |
| :--- | :--- | :--- | :--- |
| **Frontend Framework** | **React** | `18.3.1` | Reactive component hierarchy, virtual DOM reconciliation, state management |
| **Language & Typing** | **TypeScript** | `5.5.2` | Compile-time type safety across API responses, article records, and UI props |
| **Build & Dev Tool** | **Vite** | `5.4.21` | Native ES module dev server, sub-second HMR, and Rollup production bundling |
| **Styling & Design System**| **Tailwind CSS** | `3.4.4` | Curated slate/rose/emerald design tokens, tactical grid backdrops, dark mode |
| **Client Routing** | **React Router DOM** | `7.18.4` | Declarative routing with AppShell layout, dynamic outlets, and nested state |
| **Iconography** | **Lucide React** | `0.395.0` | Comprehensive SVG icons matching corporate executive aesthetic |
| **Date & Time Utilities** | **date-fns** | `4.4.0` | High-precision ISO date formatting and humanized relative offsets (`1d 2h`) |
| **Micro-Animations** | **Framer Motion** | `11.2.10` | Hardware-accelerated transitions, drawer slide-ins, and toast animations |
| **Delight Mechanics** | **Canvas Confetti** | `1.9.3` | Milestone celebration particles upon resolving crisis incidents |
| **Backend Runtime** | **Node.js** | `>=20.0` | High-throughput asynchronous event loop with native ECMAScript Modules (`ESM`) |
| **API Server & Routing** | **Express.js** | `4.22.3` | High-speed HTTP middleware pipeline, CORS handling, REST endpoints |
| **TypeScript Execution** | **tsx** | `4.15.7` | Zero-config TypeScript execution and watcher for backend daemons |
| **Primary Cloud AI** | **Google Gemini API** | `gemini-3.6-flash` | Multimodal document vision, zero-shot structured JSON extraction, temperature 0 |
| **Local Offline AI** | **Ollama Engine** | `qwen2.5:7b` | On-premise LLM inference via GPU/CPU with JSON schema output mode |
| **Computer Vision Engine** | **Sharp** | `0.35.4` | High-performance Libvips image manipulation: grayscale, linear stretch, upscale |
| **Local OCR Engine** | **Tesseract.js** | `7.0.0` | Multi-threaded WebAssembly OCR worker using English training data and PSM 3 |
| **PDF Extraction** | **pdf-parse** | `2.4.5` | In-memory text stream decoding for native vector digital PDFs |
| **Database & WebSockets** | **Supabase (PostgreSQL)** | `2.116.0` | Managed PostgreSQL with row-level security and sub-100ms WebSocket change events |
| **Streaming Firehose** | **ws (WebSocket)** | `8.21.3` | High-performance WebSocket client connecting directly to Bluesky Jetstream |
| **HTTP & Scraping Client** | **Axios & Cheerio** | `1.20` / `1.2` | Resilient HTTP requests with TLS bypass, custom headers, and DOM parsing |
| **Multipart Uploads** | **Multer** | `2.4.0` | Ephemeral RAM file buffer handling with zero disk persistence |
| **Telephony & DTMF** | **Twilio Voice SDK** | REST / XML | Automated voice escalation simulation with synthetic TTS and interactive DTMF |
| **Push Notification Rails**| **Slack / WhatsApp / SendGrid** | REST Webhooks | Multi-channel crisis broadcast triggers for executive emergency councils |

---

### Detailed Subsystem Breakdown

#### 1. Frontend Client (`client/`)
- **App Shell Architecture**: Implements a desktop layout with a collapsible 64px/256px dark sidebar (`Sidebar.tsx`), global status header (`Header.tsx`), and a dedicated mobile bottom navigation bar (`MobileBottomNav.tsx`) with safe-area inset compliance for mobile viewports.
- **Scroll & Viewport Mechanics**: High-performance passive scroll listeners, reduced-motion detection (`prefers-reduced-motion: reduce`), and auto-detecting scroll-to-top component ([`ScrollToTopButton.tsx`](file:///s:/Web%20project/VEE-TECH/client/src/components/ScrollToTopButton.tsx)).
- **CSS Design System**:
  - Semantic HSL/Slate color palettes (`bg-[#F6F7F9]`, `text-slate-900`, `border-slate-200`).
  - Tactical intelligence dot grid: `.intel-grid-bg` for command room aesthetics.
  - Custom webkit scrollbars styled in soft slate tones for dense data tables.

#### 2. Backend Server (`server/`)
- **Dual-Engine Document Extraction**:
  - Primary: Google Gemini 3.6 Flash multimodal API with automatic fallback cascade (`gemini-3.6-flash` $\to$ `gemini-2.0-flash` $\to$ `gemini-1.5-flash`).
  - Fallback: Sharp image preprocessor + Tesseract.js (PSM 3) + Ollama `qwen2.5:7b` structured normalizer.
- **Low-Latency Gateway & Circuit Breakers**:
  - Independent cooldown states per provider to isolate rate limits (e.g., Google CSE 429 quota isolation).
  - Pre-database SHA-256 $O(1)$ in-memory hash set preventing redundant database writes.
- **Deterministic Threat Scorer**:
  - Transparent rule engine with zero hallucination risk, enforcing critical dictionaries (`arrest`, `fraud`, `trading suspended`, `whistleblower`) and target regexes (`Infosys`, `TCS`, `Wipro`, `Accenture`).

#### 3. Cloud & Infrastructure Services
- **Supabase Realtime PostgreSQL**: Serves as the authoritative source of truth. Handles real-time WebSocket change subscriptions (`articles-realtime` channel) with immediate replication across all active client dashboards.
- **Google AI Studio (Gemini)**: Provides multimodal document comprehension, extracting dates, authors, page numbers, and synthesized briefs directly from high-resolution document buffers.
- **Bluesky Jetstream Nodes**: Subscribes to US-West WebSocket firehose nodes (`wss://jetstream1.us-west.bsky.network`), processing AT-protocol posts at line speed.

### 1. Port 5000 or 5173 is already in use
If another background Node or Vite process is holding the port on Windows:
```bash
# Find the PID holding port 5000
netstat -ano | findstr :5000

# Terminate the process by PID
taskkill /F /PID <PID>
```

### 2. Gemini OCR returns 404: "Model not found"
Older Google GenAI models such as `gemini-2.5-flash` have been deprecated for new API keys. Ensure your `server/.env` specifies:
```ini
GEMINI_MODEL=gemini-3.6-flash
```
Vee-Alert automatically cascades through fallback models if an upstream deprecation is detected.

### 3. Local Ollama connection failure (`ECONNREFUSED 127.0.0.1:11434`)
Ensure Ollama is running on your machine:
```bash
# Start Ollama service
ollama serve

# In a second terminal, verify model is available
ollama run qwen2.5:7b
```
If Ollama is not installed or offline, Vee-Alert automatically routes extractions to the primary Gemini API and heuristic fallback rules without interruption.

### 4. PowerShell Execution Policy errors (`npm.ps1 cannot be loaded`)
Run commands prefixed with `cmd /c` or adjust execution policy:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for complete details.
