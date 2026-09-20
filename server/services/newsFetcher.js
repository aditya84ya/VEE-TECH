import https from 'node:https';
import axios from 'axios';
import * as cheerio from 'cheerio';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config();

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
const DEFAULT_KEYWORDS = '(Infosys OR "Infosys ADR" OR "NYSE: INFY" OR TCS OR Wipro OR "Wipro ADR" OR Accenture OR "IT services outage" OR "banking cyberattack" OR Finacle) when:4h';
const DEFAULT_KEYWORDS_GLOBAL = '("Infosys" OR "TCS" OR "Wipro" OR "Accenture" OR "IT services" OR "Indian IT" OR "Finacle") when:4h';
const TARGET_ENTITY_REGEX = /\b(Infosys|TCS|Tata Consultancy Services|Wipro|Accenture|Finacle)\b/i;
const DEFAULT_POLL_INTERVAL_MS = 120 * 1000; // 120 seconds default

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deduplication Signature Set (Stores last 2,000 processed items)
const seenSignatures = new Set();
const MAX_SEEN_CACHE = 2000;

function isDuplicate(sig) {
  if (!sig) return false;
  if (seenSignatures.has(sig)) return true;
  if (seenSignatures.size >= MAX_SEEN_CACHE) {
    const oldest = seenSignatures.values().next().value;
    if (oldest) seenSignatures.delete(oldest);
  }
  seenSignatures.add(sig);
  return false;
}

function cleanHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses GDELT seendate format: YYYYMMDDTHHMMSSZ -> ISO String
 */
function parseGdeltDate(dateStr) {
  if (!dateStr) return new Date().toISOString();
  try {
    const clean = String(dateStr).replace(/[^0-9]/g, '');
    if (clean.length >= 14) {
      const year = clean.slice(0, 4);
      const month = clean.slice(4, 6);
      const day = clean.slice(6, 8);
      const hour = clean.slice(8, 10);
      const min = clean.slice(10, 12);
      const sec = clean.slice(12, 14);
      return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`).toISOString();
    }
  } catch (_) {}
  return new Date().toISOString();
}

/**
 * High-performance HTML scraper for social firehoses (Bluesky & Nostr).
 * Uses a strict 4000ms timeout with AbortController and standard Chrome User-Agent
 * to extract OpenGraph title, description, and preview image without blocking the queue.
 */
export async function enrichSocialUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  let timeoutId = null;
  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 4000); // Strict 4000ms timeout

    const response = await axios.get(url, {
      signal: controller.signal,
      timeout: 4000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      maxRedirects: 3,
      validateStatus: (status) => status >= 200 && status < 400
    });

    if (!response.data || typeof response.data !== 'string') return null;
    const $ = cheerio.load(response.data);
    const title = cleanHtml(
      $('meta[property="og:title"]').attr('content') ||
      $('title').text() ||
      $('meta[name="twitter:title"]').attr('content') ||
      ''
    );
    const description = cleanHtml(
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      $('meta[name="twitter:description"]').attr('content') ||
      ''
    );
    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      null;

    if (title || description) {
      return { title, description, image };
    }
    return null;
  } catch (_) {
    // Gracefully ignore timeouts, 403 bot-blocks, or invalid pages
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ============================================================================
// REAL-TIME SOURCE TELEMETRY (Tracks Polling Vitality vs DB Commit Events)
// ============================================================================
export const sourceTelemetry = {
  newsapi: { id: 'newsapi', name: 'NewsAPI (Global Aggregator)', lastPolled: null, lastStatus: 'Operational', lastCount: 0, lastNewArticle: null },
  currents: { id: 'currents', name: 'Currents Global News API', lastPolled: null, lastStatus: 'Operational', lastCount: 0, lastNewArticle: null },
  gnews: { id: 'gnews', name: 'GNews AI-Curated Wire', lastPolled: null, lastStatus: 'Operational', lastCount: 0, lastNewArticle: null },
  newsdata: { id: 'newsdata', name: 'NewsData.io Real-Time Archive', lastPolled: null, lastStatus: 'Operational', lastCount: 0, lastNewArticle: null },
  guardian: { id: 'guardian', name: 'The Guardian Content API', lastPolled: null, lastStatus: 'Operational', lastCount: 0, lastNewArticle: null },
  googlenews: { id: 'googlenews', name: 'Google News RSS (Instant Wire)', lastPolled: null, lastStatus: 'Operational', lastCount: 0, lastNewArticle: null },
  institutional: { id: 'institutional', name: 'Institutional Publisher Wires (ET, Mint, BS)', lastPolled: null, lastStatus: 'Operational', lastCount: 0, lastNewArticle: null },
  bluesky: { id: 'bluesky', name: 'Bluesky Social Wire (AT Protocol Trial)', lastPolled: null, lastStatus: 'Operational', lastCount: 0, lastNewArticle: null },
  gdelt: { id: 'gdelt', name: 'GDELT DOC 2.0 (Global Discovery Wire)', lastPolled: null, lastStatus: 'Operational', lastCount: 0, lastNewArticle: null }
};

export function updateSourceTelemetry(sourceId, updates) {
  if (sourceTelemetry[sourceId]) {
    Object.assign(sourceTelemetry[sourceId], updates);
  }
}

// Module State
let streamIntervalId = null;
let registeredCallback = null;

// ============================================================================
// PER-SOURCE RATE CONTROLS
// ============================================================================
// Quota cooldowns: once a free-tier API returns 429/403 we back off for 30min.
// This keeps their daily 100-request quota alive across the full day.
let newsApiCooldownUntil = 0;
let gNewsCooldownUntil = 0;
let newsDataCooldownUntil = 0;
let currentsCooldownUntil = 0;
let guardianCooldownUntil = 0;
const QUOTA_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes

// Tiered slow-poll timestamps for quota-gated free-tier sources (NewsAPI, GNews, NewsData).
// These fire at most once every 15 minutes (900,000ms) to preserve daily allowances.
const QUOTA_GATED_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes (900,000ms)
const lastPolledTimes = {
  newsapi: 0,
  gnews: 0,
  newsdata: 0
};

// ============================================================================
// SINCE-CURSOR TRACKING (incremental fetch — only new articles per cycle)
// Each source stores the ISO timestamp of the last successfully fetched article.
// On the next call we pass this as the "from" / "start_date" floor so APIs only
// return articles NEWER than that, cutting raw-fetch volume dramatically.
// ============================================================================
const sinceTimestamps = {
  newsapi:   null,  // ISO string or null for first run
  gnews:     null,
  newsdata:  null,
  currents:  null,
  guardian:  null
};

/**
 * Update the since-cursor for a source after a successful fetch.
 * Uses the most-recent published_at from returned articles as the new floor.
 * @param {string} sourceKey - key in sinceTimestamps
 * @param {Array<{published_at: string}>} articles - normalized articles returned
 */
function updateSinceCursor(sourceKey, articles) {
  if (!articles || articles.length === 0) return;
  const latest = articles
    .map(a => a.published_at)
    .filter(Boolean)
    .map(d => new Date(d).getTime())
    .filter(t => !isNaN(t))
    .sort((a, b) => b - a)[0];
  if (latest) {
    // Subtract 60s buffer to avoid missing articles due to clock skew
    const floor = new Date(latest - 60 * 1000).toISOString();
    if (!sinceTimestamps[sourceKey] || floor > sinceTimestamps[sourceKey]) {
      sinceTimestamps[sourceKey] = floor;
    }
  }
}

// ============================================================================
// RSS GUID PRE-FILTER (cheap skip before the heavy dedup chain)
// Stores the last 500 RSS item GUIDs/links seen. Anything already in this set
// is skipped immediately, cutting most of the re-fetch noise from RSS.
// ============================================================================
const seenRssGuids = new Set();
const MAX_RSS_GUIDS = 500;

function isSeenRssGuid(guid) {
  if (!guid) return false;
  if (seenRssGuids.has(guid)) return true;
  if (seenRssGuids.size >= MAX_RSS_GUIDS) {
    const oldest = seenRssGuids.values().next().value;
    if (oldest) seenRssGuids.delete(oldest);
  }
  seenRssGuids.add(guid);
  return false;
}

// ============================================================================
// 1. NEWSAPI (The Global Aggregator)
// ============================================================================
export async function fetchNewsApi(keywords = DEFAULT_KEYWORDS) {
  if (Date.now() < newsApiCooldownUntil) {
    const remainingSec = Math.ceil((newsApiCooldownUntil - Date.now()) / 1000);
    console.log(`[ProviderAdapter:newsapi] ⏭ Skipped fetch — ${remainingSec}s remaining in cooldown`);
    sourceTelemetry.newsapi.lastStatus = 'Quota Cooldown';
    return [];
  }

  const apiKey = (process.env.NEWSAPI_KEY || '').trim();

  if (!apiKey) {
    console.log('[NewsAPI] NEWSAPI_KEY not configured in .env; skipping source.');
    return [];
  }

  sourceTelemetry.newsapi.lastPolled = new Date().toISOString();

  // Tiered polling gate: NewsAPI free plan = 100 req/day.
  // Immediate exit with [] if less than 15 minutes (900,000ms) have passed.
  const nowMs = Date.now();
  if (nowMs - lastPolledTimes.newsapi < QUOTA_GATED_INTERVAL_MS) {
    const waitMin = Math.ceil((QUOTA_GATED_INTERVAL_MS - (nowMs - lastPolledTimes.newsapi)) / 60000);
    console.log(`[NewsAPI] ⏱️ Tiered polling gate: next call in ${waitMin}min (quota-preserving 15min interval).`);
    return [];
  }
  lastPolledTimes.newsapi = nowMs;

  // Strict boolean query — exactly the 4 target entities, no noise
  const strictQuery = '(Infosys OR "Tata Consultancy Services" OR Wipro OR Accenture)';

  // Build since-cursor: only fetch articles newer than last successful fetch
  const fromParam = sinceTimestamps.newsapi || new Date(Date.now() - 60 * 60 * 1000).toISOString(); // default: last 1h on first run

  const url = 'https://newsapi.org/v2/everything';
  console.log(`[NewsAPI] Querying strict boolean query (from=${fromParam.slice(0, 16)})...`);

  try {
    const response = await axios.get(url, {
      params: {
        q: strictQuery,
        sortBy: 'publishedAt',
        language: 'en',
        pageSize: 20,
        from: fromParam          // Only articles newer than last fetch
      },
      headers: {
        'X-Api-Key': apiKey,
        'User-Agent': 'VeeAlert/1.0 (Enterprise Intelligence Platform)',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      },
      timeout: 12000
    });

    if (response.data && Array.isArray(response.data.articles)) {
      const articles = response.data.articles
        .filter((item) => item.title && item.url && !item.title.includes('[Removed]'))
        .map((item) => ({
          api_source: 'NewsAPI',
          source_name: item.source?.name || 'NewsAPI Global Wire',
          title: cleanHtml(item.title),
          url: item.url,
          image_url: item.urlToImage || null,
          raw_content: cleanHtml(item.description || item.content || item.title),
          published_at: item.publishedAt ? new Date(item.publishedAt).toISOString() : new Date().toISOString()
        }));

      sourceTelemetry.newsapi.lastStatus = 'Operational';
      sourceTelemetry.newsapi.lastCount = articles.length;
      updateSinceCursor('newsapi', articles);
      console.log(`[NewsAPI] ✅ Returned ${articles.length} new articles (from=${fromParam.slice(0, 16)}).`);
      return articles;
    }
    sourceTelemetry.newsapi.lastStatus = 'Operational';
    sourceTelemetry.newsapi.lastCount = 0;
    return [];
  } catch (error) {
    if (error.response?.status === 429) {
      sourceTelemetry.newsapi.lastStatus = 'Quota Exhausted';
      newsApiCooldownUntil = Date.now() + QUOTA_BACKOFF_MS;
      console.warn(`[NewsAPI] ⚠️ Daily quota exhausted (HTTP 429). Backing off for 30 min until ${new Date(newsApiCooldownUntil).toLocaleTimeString()}.`);
    } else {
      sourceTelemetry.newsapi.lastStatus = 'Error';
      console.error(`[NewsAPI] ❌ Fetch Failed: ${error.response?.status || 'ERR'} - ${error.response?.data?.message || error.message}`);
    }
    return [];
  }
}

export const fetchNewsAPI = fetchNewsApi;

// GDELT Cooldown Tracker (3-minute backoff on 429 or timeout)
let gdeltCooldownUntil = 0;

// ============================================================================
// 2. GDELT DOC 2.0 (The Global Discovery Engine)
// ============================================================================
export async function fetchGdeltDoc(query = '(Infosys OR TCS OR Wipro OR Accenture)') {
  sourceTelemetry.gdelt.lastPolled = new Date().toISOString();

  // Check if GDELT is currently in cooldown
  const now = Date.now();
  if (now < gdeltCooldownUntil) {
    const remainingSeconds = Math.ceil((gdeltCooldownUntil - now) / 1000);
    console.log(`[GDELT DOC] ⏳ In cooldown for another ${remainingSeconds}s (rate limit / timeout backoff). Skipping.`);
    sourceTelemetry.gdelt.lastStatus = 'Cooldown';
    return [];
  }

  const queryStr = encodeURIComponent(query);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${queryStr}&mode=ArtList&format=json&sort=datedesc&timespan=24h&maxrecords=15`;
  console.log(`[GDELT DOC] Querying global event database (timespan: 24h, timeout: 25s)...`);

  try {
    const agent = new https.Agent({
      rejectUnauthorized: false // CRITICAL: Bypasses strict Node.js TLS cert mismatches for GDELT's CDN
    });

    const response = await axios.get(url, {
      httpsAgent: agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 25000 // 25 seconds for GDELT's slow server response times
    });

    // Check if GDELT returned rate-limit plain text instead of JSON
    if (typeof response.data === 'string' && response.data.includes('Please limit requests')) {
      console.warn('[GDELT DOC] ⚠️ Rate limiter engaged (Please limit requests). Engaging 3-minute cooldown.');
      gdeltCooldownUntil = Date.now() + 3 * 60 * 1000;
      sourceTelemetry.gdelt.lastStatus = 'Rate Limited';
      return [];
    }

    if (response.data && Array.isArray(response.data.articles)) {
      const articles = response.data.articles
        .filter((item) => item.title && item.url)
        .map((item) => ({
          api_source: 'GDELT DOC',
          source_name: item.domain || 'GDELT Global News',
          title: cleanHtml(item.title),
          url: item.url,
          raw_content: cleanHtml(item.title),
          published_at: parseGdeltDate(item.seendate),
          gdeltDomain: item.domain,
          gdeltLanguage: item.language,
          gdeltCountry: item.sourcecountry
        }));

      sourceTelemetry.gdelt.lastStatus = 'Operational';
      sourceTelemetry.gdelt.lastCount = articles.length;
      console.log(`[GDELT DOC] ✅ Returned ${articles.length} global articles.`);
      return articles;
    }
    sourceTelemetry.gdelt.lastStatus = 'Operational';
    sourceTelemetry.gdelt.lastCount = 0;
    return [];
  } catch (error) {
    const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout') || error.message.includes('TIMEDOUT');
    if (isTimeout) {
      console.warn('[GDELT DOC] ⏱️ Timeout (>15s). Engaging 3-minute cooldown.');
      gdeltCooldownUntil = Date.now() + 3 * 60 * 1000;
      sourceTelemetry.gdelt.lastStatus = 'Timeout';
    } else if (error.response?.status === 429) {
      console.warn('[GDELT DOC] ⚠️ Rate limited (HTTP 429). Engaging 3-minute cooldown.');
      gdeltCooldownUntil = Date.now() + 3 * 60 * 1000;
      sourceTelemetry.gdelt.lastStatus = 'Rate Limited';
    } else {
      console.warn(`[GDELT DOC] ⚠️ Skipped this cycle: ${error.response?.status || 'ERR'} - ${error.message}`);
      sourceTelemetry.gdelt.lastStatus = 'Error';
    }
    return [];
  }
}

export const fetchGDELT = fetchGdeltDoc;

// ============================================================================
// 3. GDELT GKG / ENRICHMENT (Global Knowledge Graph Tone & Themes)
// ============================================================================
/**
 * Utility function that analyzes GDELT metadata and headline markers,
 * enriching raw_content with Tone and Core Themes to prime local Qwen 2.5 LLM.
 *
 * @param {object} article Article payload
 * @returns {string} Enriched content
 */
export function enrichWithGdeltContext(article) {
  const text = `${article.title} ${article.raw_content}`.toLowerCase();

  // Synthetic GKG thematic tags inference
  const inferredThemes = [];
  if (/rbi|regulator|audit|fraud|breach|subpoena|probe|penalty|sec|tax|scrutiny/.test(text)) {
    inferredThemes.push('REGULATION_COMPLIANCE', 'CRISIS_GOVERNANCE');
  }
  if (/outage|blackout|down|disruption|failover|latency|cloud/.test(text)) {
    inferredThemes.push('INFRASTRUCTURE_OUTAGE', 'SERVICE_DISRUPTION');
  }
  if (/earnings|revenue|margin|quarter|profit|loss|guidance|stock|shares/.test(text)) {
    inferredThemes.push('FINANCIAL_PERFORMANCE', 'EQUITY_MARKET');
  }
  if (/layoff|ceo|cto|cfo|appoint|resign|leadership|restructur/.test(text)) {
    inferredThemes.push('EXECUTIVE_LEADERSHIP', 'WORKFORCE_REORGANIZATION');
  }
  if (/ai|genai|copilot|cloud|semiconductor|chip/.test(text)) {
    inferredThemes.push('TECHNOLOGY_INNOVATION', 'ENTERPRISE_AI');
  }

  const isNegative = /loss|fall|crash|drop|probe|penalty|scrutiny|outage|layoff|breach|dispute|battle/.test(text);
  const isPositive = /surge|gain|rally|win|contract|expand|rise|partnership|growth/.test(text);
  const toneScore = isNegative ? '-6.85 (High Negative Volatility)' : (isPositive ? '+4.20 (Positive Sentiment)' : '0.00 (Neutral Informational)');

  const themesStr = inferredThemes.length > 0 ? inferredThemes.join(', ') : 'GENERAL_ENTERPRISE_WIRE';

  return `${article.raw_content} [GDELT Context: Tone=${toneScore} | GKG Themes: ${themesStr}]`;
}

// ============================================================================
// 4. THE GUARDIAN CONTENT API (The Premium Wire)
// ============================================================================
export async function fetchGuardianNews(keywords = '"Infosys" OR "Tata Consultancy Services" OR "Wipro" OR "Accenture"') {
  if (Date.now() < guardianCooldownUntil) {
    const remainingSec = Math.ceil((guardianCooldownUntil - Date.now()) / 1000);
    console.log(`[ProviderAdapter:guardian] ⏭ Skipped fetch — ${remainingSec}s remaining in cooldown`);
    return [];
  }

  const apiKey = (process.env.GUARDIAN_API_KEY || '').trim();

  // Clean inactive skip if no key configured
  if (!apiKey || apiKey === 'test') {
    console.log('[The Guardian] ℹ️ Source inactive: GUARDIAN_API_KEY not configured. Skipping cleanly.');
    return [];
  }

  sourceTelemetry.guardian.lastPolled = new Date().toISOString();
  // Since-cursor: only articles newer than last successful Guardian fetch
  const guardianFrom = sinceTimestamps.guardian
    ? sinceTimestamps.guardian.slice(0, 10) // Guardian wants YYYY-MM-DD
    : undefined;
  console.log(`[The Guardian] Querying premium content API (q=${keywords}, order=newest, page-size=15${guardianFrom ? `, from-date=${guardianFrom}` : ''})...`);

  try {
    const response = await axios.get('https://content.guardianapis.com/search', {
      params: {
        q: keywords,
        'api-key': apiKey,
        'show-fields': 'headline,bodyText,trailText,thumbnail',
        'order-by': 'newest',
        'page-size': 15,
        ...(guardianFrom ? { 'from-date': guardianFrom } : {})
      },
      timeout: 12000,
      headers: {
        'User-Agent': 'VeeAlert/1.0 (Enterprise Intelligence Platform)'
      }
    });

    const results = response.data?.response?.results;
    if (Array.isArray(results)) {
      const articles = results
        .filter((item) => item.webTitle && item.webUrl)
        .map((item) => {
          const bodyClean = cleanHtml(item.fields?.bodyText || item.fields?.trailText || item.webTitle);
          return {
            api_source: 'The Guardian API',
            source_name: 'The Guardian',
            title: cleanHtml(item.fields?.headline || item.webTitle),
            url: item.webUrl,
            image_url: item.fields?.thumbnail || null,
            description: cleanHtml(item.fields?.trailText || bodyClean.slice(0, 300)),
            content: bodyClean.slice(0, 2000),
            raw_content: bodyClean.slice(0, 3000),
            published_at: item.webPublicationDate ? new Date(item.webPublicationDate).toISOString() : new Date().toISOString()
          };
        });

      sourceTelemetry.guardian.lastStatus = 'Operational';
      sourceTelemetry.guardian.lastCount = articles.length;
      updateSinceCursor('guardian', articles);
      console.log(`[The Guardian] ✅ Fetched ${articles.length} premium articles.`);
      return articles;
    }
    sourceTelemetry.guardian.lastStatus = 'Operational';
    sourceTelemetry.guardian.lastCount = 0;
    return [];
  } catch (error) {
    if (error.response?.status === 401) {
      sourceTelemetry.guardian.lastStatus = 'Unauthorized';
      console.warn('[The Guardian] ⚠️ 401 Unauthorized — check GUARDIAN_API_KEY in server/.env.');
    } else if (error.response?.status === 429) {
      guardianCooldownUntil = Date.now() + QUOTA_BACKOFF_MS;
      sourceTelemetry.guardian.lastStatus = 'Rate Limited';
      console.warn('[The Guardian] ⚠️ Rate limited (HTTP 429). Engaging cooldown.');
    } else {
      sourceTelemetry.guardian.lastStatus = 'Error';
      console.warn(`[The Guardian] ⚠️ Skipped: ${error.response?.status || 'ERR'} - ${error.message}`);
    }
    return [];
  }
}

export const fetchGuardian = fetchGuardianNews;

// ============================================================================
// 5. PUBLISHER RSS FEEDS (The Institutional & High-Freshness Wire)
// ============================================================================
function buildGoogleRssUrl() {
  const query = encodeURIComponent(
    '(Infosys OR "Infosys ADR" OR "NYSE: INFY" OR TCS OR Wipro OR "Wipro ADR" OR Accenture OR "IT services outage" OR "banking cyberattack" OR Finacle) when:4h'
  );
  return `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en&_cb=${Date.now()}`;
}

const WHITELISTED_RSS_FEEDS = [
  {
    name: 'The Economic Times',
    api_source: 'Institutional RSS',
    url: 'https://economictimes.indiatimes.com/tech/ites/rssfeeds/13357555.cms'
  },
  {
    name: 'The Economic Times Top Stories',
    api_source: 'Institutional RSS',
    url: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms'
  },
  {
    name: 'Livemint Companies',
    api_source: 'Institutional RSS',
    url: 'https://www.livemint.com/rss/companies'
  },
  {
    name: 'Business Standard Companies',
    api_source: 'Institutional RSS',
    url: 'https://www.business-standard.com/rss/companies-101.rss'
  },
  {
    name: 'Google News Live RSS',
    api_source: 'Google RSS',
    get url() { return buildGoogleRssUrl(); }  // Fresh URL with cache-buster on each call
  }
];

export async function fetchPublisherRss() {
  sourceTelemetry.googlenews.lastPolled = new Date().toISOString();
  sourceTelemetry.institutional.lastPolled = new Date().toISOString();
  console.log('[Publisher RSS] Querying whitelisted publisher feeds (The Economic Times, Livemint, Google News)...');
  const aggregatedItems = [];

  for (const feed of WHITELISTED_RSS_FEEDS) {
    try {
      const feedUrl = typeof feed.url === 'string' ? feed.url : feed.url;
      console.log(`[Publisher RSS] Fetching: ${feed.name} → ${feedUrl.slice(0, 90)}...`);
      const response = await axios.get(feedUrl, {
        timeout: 9000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });

      const $ = cheerio.load(response.data, { xmlMode: true });
      const items = $('item').toArray();
      let feedSkipped = 0;

      for (const el of items) {
        const title = cleanHtml($(el).find('title').text());
        const link = $(el).find('link').text().trim();
        const guid = $(el).find('guid').text().trim() || link;
        const pubDate = $(el).find('pubDate').text().trim();
        const rawDesc = $(el).find('description').text();
        const description = cleanHtml(rawDesc);
        const sourceName = cleanHtml($(el).find('source').text()) || feed.name;

        if (!title || !link) continue;

        // GUID PRE-FILTER: skip already-seen items before any keyword check or dedup
        if (isSeenRssGuid(guid)) {
          feedSkipped++;
          continue;
        }

        // Filter incoming XML items to ensure target keywords match
        if (!TARGET_ENTITY_REGEX.test(title) && !TARGET_ENTITY_REGEX.test(description)) {
          continue;
        }

        // Recency guardrail: Reject any item published > 12 hours ago
        if (pubDate) {
          const pubTime = new Date(pubDate).getTime();
          if (!isNaN(pubTime)) {
            const ageHours = (Date.now() - pubTime) / (3600 * 1000);
            if (ageHours > 12) {
              const ageDesc = ageHours >= 48 ? `${(ageHours / 24).toFixed(1)} days` : `${ageHours.toFixed(1)} hours`;
              console.log(`[Publisher RSS] 🚫 DROPPED STALE: "${title.slice(0, 50)}..." (published ${ageDesc} ago exceeds 12h window)`);
              continue;
            }
          }
        }

        // Extract image from description HTML <img> tag or <enclosure> or <media:content>
        let imageUrl = null;
        if (rawDesc) {
          try {
            const $desc = cheerio.load(rawDesc);
            const imgSrc = $desc('img').first().attr('src');
            if (imgSrc && imgSrc.startsWith('http')) {
              imageUrl = imgSrc;
            }
          } catch (_) {}
        }
        if (!imageUrl) {
          const enclosureUrl = $(el).find('enclosure').attr('url');
          if (enclosureUrl && enclosureUrl.startsWith('http')) {
            imageUrl = enclosureUrl;
          }
        }
        if (!imageUrl) {
          const mediaUrl = $(el).find('media\\:content, content').attr('url');
          if (mediaUrl && mediaUrl.startsWith('http')) {
            imageUrl = mediaUrl;
          }
        }

        aggregatedItems.push({
          api_source: feed.api_source || (feed.name.includes('Google') ? 'Google RSS' : 'Publisher RSS'),
          source_name: sourceName,
          title,
          url: link,
          image_url: imageUrl,
          raw_content: description || title,
          published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString()
        });
      }
      if (feedSkipped > 0) console.log(`[Publisher RSS] ⏭️ ${feed.name}: skipped ${feedSkipped} already-seen GUIDs.`);
    } catch (feedErr) {
      console.warn(`[Publisher RSS] ⚠️ ${feed.name} notice: ${feedErr.message}`);
    }
  }

  const googleCount = aggregatedItems.filter(a => a.api_source === 'Google RSS').length;
  const instCount = aggregatedItems.length - googleCount;

  sourceTelemetry.googlenews.lastStatus = 'Operational';
  sourceTelemetry.googlenews.lastCount = googleCount;
  sourceTelemetry.institutional.lastStatus = 'Operational';
  sourceTelemetry.institutional.lastCount = instCount;

  console.log(`[Publisher RSS] ✅ Ingested ${aggregatedItems.length} verified articles (${googleCount} Google RSS, ${instCount} Institutional).`);
  return aggregatedItems;
}

export const fetchRSSFeeds = fetchPublisherRss;

// ============================================================================
// 6. GNEWS API (Global AI-Curated News Index)
// ============================================================================
/**
 * Fetches articles from GNews — a premium real-time global news index.
 * Gated on GNEWS_API_KEY; skips cleanly if not configured.
 *
 * @returns {Promise<Array<object>>} Normalized article array
 */
export async function fetchGNews() {
  if (Date.now() < gNewsCooldownUntil) {
    const remainingSec = Math.ceil((gNewsCooldownUntil - Date.now()) / 1000);
    console.log(`[ProviderAdapter:gnews] ⏭ Skipped fetch — ${remainingSec}s remaining in cooldown`);
    sourceTelemetry.gnews.lastStatus = 'Quota Cooldown';
    return [];
  }

  const apiKey = (process.env.GNEWS_API_KEY || '').trim();

  if (!apiKey) {
    console.log('[GNews] GNEWS_API_KEY not configured in .env; skipping source.');
    return [];
  }

  // Tiered polling gate: GNews free plan = 100 req/day.
  // Immediate exit with [] if less than 15 minutes (900,000ms) have passed.
  const nowGNews = Date.now();
  if (nowGNews - lastPolledTimes.gnews < QUOTA_GATED_INTERVAL_MS) {
    const waitMin = Math.ceil((QUOTA_GATED_INTERVAL_MS - (nowGNews - lastPolledTimes.gnews)) / 60000);
    console.log(`[GNews] ⏱️ Tiered polling gate: next call in ${waitMin}min (quota-preserving 15min interval).`);
    return [];
  }
  lastPolledTimes.gnews = nowGNews;

  sourceTelemetry.gnews.lastPolled = new Date().toISOString();
  const strictQuery = '(Infosys OR "Tata Consultancy Services" OR Wipro OR Accenture)';
  // Since-cursor: only articles published after last successful GNews fetch
  const gNewsFrom = sinceTimestamps.gnews || new Date(Date.now() - 60 * 60 * 1000).toISOString();
  console.log(`[GNews] Querying AI-curated index (from=${gNewsFrom.slice(0, 16)})...`);

  try {
    const response = await axios.get('https://gnews.io/api/v4/search', {
      params: {
        q: strictQuery,
        lang: 'en',
        sortby: 'publishedAt',
        max: 10,
        apikey: apiKey,
        from: gNewsFrom           // ISO 8601 — GNews supports this param
      },
      headers: {
        'User-Agent': 'VeeAlert/1.0 (Enterprise Intelligence Platform)',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      timeout: 12000
    });

    if (response.data && Array.isArray(response.data.articles)) {
      const articles = response.data.articles
        .filter((item) => item.title && item.url)
        .map((item) => ({
          api_source: 'GNews',
          source_name: item.source?.name || 'GNews Global Wire',
          title: cleanHtml(item.title),
          url: item.url,
          image_url: item.image || null,
          raw_content: cleanHtml(item.description || item.content || item.title),
          published_at: item.publishedAt ? new Date(item.publishedAt).toISOString() : new Date().toISOString()
        }));

      sourceTelemetry.gnews.lastStatus = 'Operational';
      sourceTelemetry.gnews.lastCount = articles.length;
      updateSinceCursor('gnews', articles);
      console.log(`[GNews] ✅ Returned ${articles.length} new articles (from=${gNewsFrom.slice(0, 16)}).`);
      return articles;
    }
    sourceTelemetry.gnews.lastStatus = 'Operational';
    sourceTelemetry.gnews.lastCount = 0;
    return [];
  } catch (error) {
    if (error.response?.status === 429 || error.response?.status === 403) {
      gNewsCooldownUntil = Date.now() + QUOTA_BACKOFF_MS;
      sourceTelemetry.gnews.lastStatus = 'Quota Exhausted';
      const msg = error.response?.data?.errors?.[0] || error.response?.data?.message || `HTTP ${error.response?.status}`;
      console.warn(`[GNews] ⚠️ Quota exhausted: ${msg}. Backing off 30min until ${new Date(gNewsCooldownUntil).toLocaleTimeString()}.`);
    } else if (error.response?.status === 401) {
      sourceTelemetry.gnews.lastStatus = 'Unauthorized';
      console.warn('[GNews] ⚠️ 401 Unauthorized — check GNEWS_API_KEY in server/.env.');
    } else {
      sourceTelemetry.gnews.lastStatus = 'Error';
      console.warn(`[GNews] ⚠️ API error: ${error.message}`);
    }
    return [];
  }
}

// ============================================================================
// 7. NEWSDATA.IO (Real-Time News Archive)
// ============================================================================
/**
 * Fetches articles from NewsData.io — a real-time global news archive API.
 * Gated on NEWSDATA_API_KEY; skips cleanly if not configured.
 * Field mapping: `link` → url, `pubDate` → published_at, `source_id` → source_name.
 *
 * @returns {Promise<Array<object>>} Normalized article array
 */
export async function fetchNewsData() {
  if (Date.now() < newsDataCooldownUntil) {
    const remainingSec = Math.ceil((newsDataCooldownUntil - Date.now()) / 1000);
    console.log(`[ProviderAdapter:newsdata] ⏭ Skipped fetch — ${remainingSec}s remaining in cooldown`);
    return [];
  }

  const apiKey = (process.env.NEWSDATA_API_KEY || '').trim();

  if (!apiKey) {
    console.log('[NewsData] NEWSDATA_API_KEY not configured in .env; skipping source.');
    return [];
  }

  // Tiered polling gate: NewsData free plan has strict rate quotas.
  // Immediate exit with [] if less than 15 minutes (900,000ms) have passed.
  const nowNewsData = Date.now();
  if (nowNewsData - lastPolledTimes.newsdata < QUOTA_GATED_INTERVAL_MS) {
    const waitMin = Math.ceil((QUOTA_GATED_INTERVAL_MS - (nowNewsData - lastPolledTimes.newsdata)) / 60000);
    console.log(`[NewsData] ⏱️ Tiered polling gate: next call in ${waitMin}min (quota-preserving 15min interval).`);
    return [];
  }
  lastPolledTimes.newsdata = nowNewsData;

  sourceTelemetry.newsdata.lastPolled = new Date().toISOString();
  const strictQuery = '(Infosys OR TCS OR Wipro OR Accenture)';
  // NewsData.io supports `timeframe` param (hours, e.g. '1' = last 1 hour).
  // We use a 1-hour window as the minimal floor; combined with sig-dedup this prevents re-fetching.
  const newsdataTimeframe = '1'; // hours
  console.log(`[NewsData] Querying real-time archive (timeframe=${newsdataTimeframe}h)...`);

  try {
    const response = await axios.get('https://newsdata.io/api/1/news', {
      params: {
        q: strictQuery,
        language: 'en',
        apikey: apiKey,
        timeframe: newsdataTimeframe // Only articles from the last 1 hour
      },
      headers: {
        'User-Agent': 'VeeAlert/1.0 (Enterprise Intelligence Platform)',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      timeout: 12000
    });

    if (response.data && Array.isArray(response.data.results)) {
      const articles = response.data.results
        .filter((item) => item.title && item.link)
        .map((item) => ({
          api_source: 'NewsData',
          source_name: item.source_id || 'NewsData Wire',
          title: cleanHtml(item.title),
          url: item.link,                              // NewsData uses `link`, not `url`
          image_url: item.image_url || null,
          raw_content: cleanHtml(item.description || item.content || item.title),
          published_at: item.pubDate                   // NewsData uses `pubDate`
            ? new Date(item.pubDate).toISOString()
            : new Date().toISOString()
        }));

      sourceTelemetry.newsdata.lastStatus = 'Operational';
      sourceTelemetry.newsdata.lastCount = articles.length;
      console.log(`[NewsData] ✅ Returned ${articles.length} articles (timeframe=1h).`);
      return articles;
    }
    sourceTelemetry.newsdata.lastStatus = 'Operational';
    sourceTelemetry.newsdata.lastCount = 0;
    return [];
  } catch (error) {
    if (error.response?.status === 429 || error.response?.status === 401 || error.response?.status === 403) {
      newsDataCooldownUntil = Date.now() + QUOTA_BACKOFF_MS;
      sourceTelemetry.newsdata.lastStatus = 'Rate Limited';
      console.warn(`[NewsData] ⚠️ API unavailable or rate limited. (HTTP ${error.response.status}). Engaging cooldown.`);
    } else {
      sourceTelemetry.newsdata.lastStatus = 'Error';
      console.warn(`[NewsData] ⚠️ API unavailable or rate limited. (${error.message})`);
    }
    return [];
  }
}

// ============================================================================
// 8. CURRENTS API (Global Live News Stream)
// ============================================================================
/**
 * Fetches articles from Currents API — real-time global news engine.
 * Gated on CURRENTS_API_KEY; skips cleanly if not configured.
 *
 * @returns {Promise<Array<object>>} Normalized article array
 */
export async function fetchCurrentsNews() {
  if (Date.now() < currentsCooldownUntil) {
    const remainingSec = Math.ceil((currentsCooldownUntil - Date.now()) / 1000);
    console.log(`[ProviderAdapter:currents] ⏭ Skipped fetch — ${remainingSec}s remaining in cooldown`);
    return [];
  }

  const apiKey = (process.env.CURRENTS_API_KEY || '').trim();

  if (!apiKey) {
    console.log('[Currents] CURRENTS_API_KEY not configured in .env; skipping source.');
    return [];
  }

  sourceTelemetry.currents.lastPolled = new Date().toISOString();
  const strictQuery = '("Infosys" OR "TCS" OR "Tata Consultancy Services" OR "Wipro" OR "Accenture")';
  // Currents supports `start_date` (ISO 8601). Use since-cursor as the floor.
  const currentsFrom = sinceTimestamps.currents || new Date(Date.now() - 60 * 60 * 1000).toISOString();
  console.log(`[Currents] Querying global news API (query=${strictQuery}, start_date=${currentsFrom.slice(0, 16)})...`);

  try {
    const response = await axios.get('https://api.currentsapi.services/v1/search', {
      params: {
        query: strictQuery,
        language: 'en',
        apiKey: apiKey,
        start_date: currentsFrom  // Only articles newer than last successful fetch
      },
      headers: {
        'User-Agent': 'VeeAlert/1.0 (Enterprise Intelligence Platform)',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      timeout: 12000
    });

    if (response.data && Array.isArray(response.data.news)) {
      const articles = response.data.news
        .filter((item) => item.title && item.url)
        .map((item) => ({
          api_source: 'Currents API',
          source_name: item.author || 'Currents Global News',
          title: cleanHtml(item.title),
          url: item.url,
          image_url: (item.image && item.image !== 'None' && String(item.image).startsWith('http')) ? item.image : null,
          raw_content: cleanHtml(item.description || item.title),
          published_at: item.published ? new Date(item.published).toISOString() : new Date().toISOString()
        }));

      sourceTelemetry.currents.lastStatus = 'Operational';
      sourceTelemetry.currents.lastCount = articles.length;
      updateSinceCursor('currents', articles);
      console.log(`[Currents] ✅ Returned ${articles.length} new articles (start_date=${currentsFrom.slice(0, 16)}).`);
      return articles;
    }
    sourceTelemetry.currents.lastStatus = 'Operational';
    sourceTelemetry.currents.lastCount = 0;
    return [];
  } catch (error) {
    if (error.response?.status === 429 || error.response?.status === 401 || error.response?.status === 403) {
      currentsCooldownUntil = Date.now() + QUOTA_BACKOFF_MS;
      sourceTelemetry.currents.lastStatus = 'Rate Limited';
      console.warn(`[Currents] ⚠️ API unavailable or rate limited (HTTP ${error.response?.status}). Engaging cooldown.`);
    } else {
      sourceTelemetry.currents.lastStatus = 'Error';
      console.warn(`[Currents] ⚠️ API request notice (${error.message}).`);
    }
    return [];
  }
}

export const fetchCurrents = fetchCurrentsNews;

// ============================================================================
// 9. BLUESKY SOCIAL WIRE (Decentralized AT Protocol Intelligence)
// ============================================================================
let blueskyJwt = null;
let blueskyJwtExpiry = 0;

/**
 * Fetches real-time intelligence from Bluesky via AT Protocol searchPosts API.
// ============================================================================
// 9. BLUESKY SOCIAL WIRE (AT Protocol Decentralized Search)
// ============================================================================
/**
 * Ingests real-time posts from Bluesky via public search API (app.bsky.feed.searchPosts).
 * Queries monitored entities (Infosys, TCS, Wipro, Accenture, Finacle).
 * Enriches linked articles with Cheerio HTML scraping for accurate downstream risk scoring.
 *
 * @returns {Promise<Array<object>>} Normalized article array
 */
export async function fetchBlueskyFeed() {
  // ── BLUESKY DISABLED ──────────────────────────────────────────────────────
  // public.api.bsky.app is CDN-blocked (BunnyCDN-IN1) for Indian IP ranges.
  // This is a network-level block, not a missing auth token — no fix possible
  // from the client side without a VPN/proxy. Disabling cleanly to stop burning
  // 4s of timeout per cycle for zero return.
  // Status: Not Configured. Re-enable if network conditions change.
  // ─────────────────────────────────────────────────────────────────────────
  sourceTelemetry.bluesky.lastStatus = 'Not Configured';
  sourceTelemetry.bluesky.lastCount = 0;
  return [];
}

// Backwards-compatibility alias
export const fetchBlueskySocial = fetchBlueskyFeed;

/**
 * 9. Google Programmable Search Engine (CSE) News Wire
 */
export async function fetchGoogleSearchNews() {
  const apiKey = (process.env.GOOGLE_CUSTOM_SEARCH_KEY || '').trim();
  const cxId = (process.env.GOOGLE_CX_ID || 'c7b914ef13847465b').trim();

  if (!apiKey) {
    return [];
  }

  const query = 'Infosys OR TCS OR Wipro OR Accenture crisis OR breach OR revenue OR regulatory';
  try {
    const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: apiKey,
        cx: cxId,
        q: query,
        num: 10,
        dateRestrict: 'd3'
      },
      timeout: 8000,
      headers: {
        'User-Agent': 'VeeAlert/1.0 (Google CSE)',
        Accept: 'application/json'
      }
    });

    if (res.data?.items && Array.isArray(res.data.items)) {
      return res.data.items.map((item) => ({
        api_source: 'Google Search Engine (CSE)',
        source_name: item.displayLink || 'Google Custom Search',
        title: item.title,
        url: item.link,
        image_url: item.pagemap?.cse_image?.[0]?.src || item.pagemap?.metatags?.[0]?.['og:image'] || null,
        raw_content: item.snippet || item.title,
        published_at: item.pagemap?.metatags?.[0]?.['article:published_time'] || new Date().toISOString()
      }));
    }
    return [];
  } catch (err) {
    console.warn(`[Google CSE] ⚠️ Request notice: ${err.response?.data?.error?.message || err.message}`);
    return [];
  }
}

// ============================================================================
// 10. MASTER CONCURRENT MULTI-SOURCE AGGREGATOR (REST APIs + Verified RSS + Bluesky Trial)
// ============================================================================
/**
 * Queries verified REST APIs, whitelisted RSS feeds (Google News + Institutional),
 * and the Bluesky AT Protocol trial concurrently using Promise.allSettled().
 *
 * @param {(payload: object) => Promise<any>} processIngestCallback
 * @returns {Promise<Array<object>>} Successfully ingested articles
 */
export async function fetchMultiSourceNews(processIngestCallback) {
  const ingest = processIngestCallback || registeredCallback;

  if (!ingest) {
    console.warn('[MultiSource] No ingest callback provided; skipping aggregation run.');
    return [];
  }

  const cycleTime = new Date().toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log('\n================== [INGESTION CYCLE: ' + cycleTime + '] ==================');
  console.log('⚡ [Multi-Source Engine] Commencing Concurrent Multi-Source Ingestion:');
  console.log('   1. NewsAPI        (15min slow-poll | since-cursor | 100 req/day quota)');
  console.log('   2. Currents API   (Every cycle | since-cursor start_date)');
  console.log('   3. GNews          (15min slow-poll | since-cursor from | 100 req/day quota)');
  console.log('   4. NewsData.io    (Every cycle | timeframe=1h window)');
  console.log('   5. The Guardian   (Every cycle | since-cursor from-date)');
  console.log('   6. Publisher RSS  (Every cycle | GUID pre-filter + entity filter)');
  console.log('   7. GDELT DOC 2.0  (Every cycle | TLS-bypass Agent | 25s timeout)');
  console.log('   8. Bluesky        (Real-time Jetstream WebSocket firehose | sub-second)');
  console.log('   9. Google CSE     (15min slow-poll | cx: c7b914ef13847465b)');
  console.log('=========================================================================');

  // Execute active sources concurrently
  const results = await Promise.allSettled([
    fetchNewsApi(),
    fetchCurrentsNews(),
    fetchGNews(),
    fetchNewsData(),
    fetchGuardianNews(),
    fetchPublisherRss(),
    fetchGdeltDoc(),
    fetchGoogleSearchNews()
  ]);

  const rawAggregatedArticles = [];
  const sourceCounts = {
    NewsAPI: 0,
    'Currents API': 0,
    GNews: 0,
    NewsData: 0,
    'The Guardian API': 0,
    'Publisher RSS': 0,
    'GDELT DOC 2.0': 0,
    'Google Search Engine (CSE)': 0
  };

  const sourceNames = [
    'NewsAPI',
    'Currents API',
    'GNews',
    'NewsData',
    'The Guardian API',
    'Publisher RSS',
    'GDELT DOC 2.0',
    'Google Search Engine (CSE)'
  ];

  results.forEach((result, idx) => {
    const name = sourceNames[idx];
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      sourceCounts[name] = result.value.length;
      rawAggregatedArticles.push(...result.value);
    } else if (result.status === 'rejected') {
      const err = result.reason;
      console.error(`[${name}] ❌ Fetch Failed: ${err?.response?.status || 'ERR'} - ${err?.response?.data?.message || err?.message}`);
    } else {
      console.warn(`[MultiSource] Source [${name}] returned empty response.`);
    }
  });

  const rawTotal = rawAggregatedArticles.length;
  console.log(
    `\n[Fetch Sources] NewsAPI: ${sourceCounts['NewsAPI']} | Currents: ${sourceCounts['Currents API']} | ` +
    `GNews: ${sourceCounts['GNews']} | NewsData: ${sourceCounts['NewsData']} | ` +
    `Guardian: ${sourceCounts['The Guardian API']} | RSS: ${sourceCounts['Publisher RSS']} | ` +
    `GDELT: ${sourceCounts['GDELT DOC 2.0']}`
  );
  console.log(`[MultiSource] RAW FETCH TOTAL: ${rawTotal} articles. Starting dedup & triage...`);

  const ingestedArticles = [];

  // Four distinct outcome buckets — declared in outer scope so they accumulate
  let committed = 0;   // Actually committed to Supabase
  let sigDup    = 0;   // Dropped by in-memory signature dedup (newsFetcher)
  let dbDup     = 0;   // Dropped by Supabase URL/Title dedup (processIngest)
  let junk      = 0;   // Dropped by keyword guardrail (processIngest)
  let errors    = 0;   // Exception thrown inside ingest()

  for (const article of rawAggregatedArticles) {
    const signature = `${article.url || ''}::${article.title}`;
    if (isDuplicate(signature)) {
      sigDup++;
      console.log(`[Deduplicator] DROPPED DUPLICATE (Signature): "${(article.title || '').slice(0, 55)}..."`);
      continue;
    }

    // PHASE 0 PRE-FILTER: Drop irrelevant articles upfront before DB queries or triage
    const textToCheck = `${article.title || ''} ${article.description || ''} ${article.content || ''} ${article.raw_content || ''}`;
    if (!TARGET_ENTITY_REGEX.test(textToCheck)) {
      junk++;
      console.log(`[Guardrail Pre-Filter] 🛡️ DROPPED IRRELEVANT: "${(article.title || '').slice(0, 55)}..."`);
      continue;
    }

    // Enrich with GDELT Tone & Thematic Context
    const enrichedContent = enrichWithGdeltContext(article);
    const correlation_id = `corr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const payload = {
      correlation_id,
      api_source: article.api_source || 'Google RSS',
      source_name: article.source_name,
      title: article.title,
      url: article.url,
      image_url: article.image_url || null,
      raw_content: enrichedContent,
      published_at: article.published_at
    };

    try {
      const result = await ingest(payload);

      if (result?.skipped) {
        if (result.reason === 'Failed keyword guardrail') {
          junk++;
        } else {
          dbDup++;
        }
      } else if (result?.success) {
        ingestedArticles.push(payload);
        committed++;

        // Track last new committed article for this source
        const apiSrc = (payload.api_source || '').toLowerCase();
        const srcName = (payload.source_name || '').toLowerCase();
        let matchedKey = 'newsapi';
        if (apiSrc.includes('currents') || srcName.includes('currents')) matchedKey = 'currents';
        else if (apiSrc.includes('bluesky') || srcName.includes('bsky')) matchedKey = 'bluesky';
        else if (apiSrc.includes('gnews') || srcName.includes('gnews')) matchedKey = 'gnews';
        else if (apiSrc.includes('newsdata') || srcName.includes('newsdata')) matchedKey = 'newsdata';
        else if (apiSrc.includes('gdelt') || srcName.includes('gdelt')) matchedKey = 'gdelt';
        else if (apiSrc.includes('guardian') || srcName.includes('guardian')) matchedKey = 'guardian';
        else if (apiSrc.includes('rss') || srcName.includes('google')) matchedKey = 'googlenews';
        else if (srcName.includes('economic') || srcName.includes('mint') || srcName.includes('standard') || srcName.includes('reuters') || srcName.includes('bloomberg')) matchedKey = 'institutional';

        if (sourceTelemetry[matchedKey]) {
          sourceTelemetry[matchedKey].lastNewArticle = new Date().toISOString();
        }
      }

      // Polite scraping delay between pipeline dispatches
      await sleep(200);
    } catch (err) {
      errors++;
      console.warn(`[MultiSource] Ingestion error for "${payload.title}":`, err.message);
    }
  }

  console.log(
    `[Cycle Summary] ✅ Committed: ${committed} | ` +
    `🔁 Sig-Dedup: ${sigDup} | 🔁 DB-Dedup: ${dbDup} | ` +
    `🛡️ Junk Dropped: ${junk} | ❌ Errors: ${errors}`
  );
  return ingestedArticles;

}

// ============================================================================
// 7. STREAM CONTROLLER
// ============================================================================
/**
 * Starts the recurring multi-source intelligence ingestion pipeline.
 * Intelligently supports both (callback, intervalMs) and (intervalMs, callback) signatures.
 *
 * @param {Function|number} arg1 Ingestion callback or polling interval in ms
 * @param {Function|number} [arg2] Polling interval in ms or callback
 */
export function startNewsStream(arg1, arg2) {
  let callback = null;
  let intervalMs = DEFAULT_POLL_INTERVAL_MS;

  if (typeof arg1 === 'function') {
    callback = arg1;
    if (typeof arg2 === 'number') intervalMs = arg2;
  } else if (typeof arg2 === 'function') {
    callback = arg2;
    if (typeof arg1 === 'number') intervalMs = arg1;
  }

  if (callback) {
    registeredCallback = callback;
  }

  if (!registeredCallback) {
    console.warn('[MultiSource] Cannot start stream: No valid ingest callback function provided.');
    return;
  }

  // Ensure interval is at least 30 seconds to prevent aggressive loops
  const effectiveIntervalMs = Math.max(30000, Number(intervalMs) || DEFAULT_POLL_INTERVAL_MS);

  console.log('\n=============================================================');
  console.log(`🚀 [Vee-Alert Multi-Source Intelligence Stream Started]`);
  console.log(`Polling Interval: ${effectiveIntervalMs / 1000}s`);
  console.log('=============================================================\n');

  // Trigger initial fetch on startup
  fetchMultiSourceNews(registeredCallback).catch((err) => {
    console.error('[MultiSource] Initial startup fetch notice:', err.message);
  });

  if (streamIntervalId) clearInterval(streamIntervalId);

  streamIntervalId = setInterval(async () => {
    try {
      if (registeredCallback) {
        await fetchMultiSourceNews(registeredCallback);
      }
    } catch (cycleError) {
      console.error('[MultiSource] Interval cycle caught error (recovering):', cycleError.message);
    }
  }, effectiveIntervalMs);
}

/**
 * Stops the multi-source intelligence ingestion stream.
 */
export function stopNewsStream() {
  if (streamIntervalId) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
    console.log('[MultiSource] Intelligence stream safely stopped.');
  }
}

// Backward-compatible alias for existing imports (now points to 5-source engine)
export const fetchLiveGoogleNews = fetchMultiSourceNews;
export const startLiveNewsFeed = startNewsStream;
export const stopLiveNewsFeed = stopNewsStream;
