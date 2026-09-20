import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  sendSlackAlert,
  sendWhatsAppAlert,
  sendEmailAlert,
  triggerVoiceCall,
  sendTelegramAlert
} from './services/notifier.js';
import {
  fetchMultiSourceNews,
  fetchLiveGoogleNews,
  startNewsStream,
  startLiveNewsFeed,
  stopLiveNewsFeed,
  sourceTelemetry
} from './services/newsFetcher.js';
import { IngestionGateway } from './services/ingestion/IngestionGateway.js';
import { SearchService } from './services/SearchService.js';
import { fetchVerificationContext } from './services/verification/GoogleCustomSearchAdapter.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

// ============================================================================
// 1. INITIALIZATION & SETUP
// ============================================================================
const app = express();
const PORT = Number(process.env.PORT || 5000);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

// Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['application/xml', 'text/xml', 'application/atom+xml'], limit: '10mb' }));

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

export const supabase = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false }
    })
  : null;

// ============================================================================
// SHA-256 CONTENT HASHING & ZERO-LATENCY PRE-DATABASE DEDUPLICATION
// ============================================================================
export const seenContentHashes = new Set();

/**
 * Generates an SHA-256 cryptographic hash over normalized title and url.
 * @param {{ title?: string, url?: string }} article
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function generateContentHash(article) {
  const normTitle = String(article?.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const normUrl = String(article?.url || '').trim().toLowerCase();
  return createHash('sha256').update(`${normTitle}-${normUrl}`).digest('hex');
}

/**
 * Hydrates in-memory seenContentHashes Set from Supabase on startup
 * to enable O(1) deduplication rejection before any database query or LLM call.
 */
export async function hydrateSeenContentHashes() {
  if (!supabase) return;
  try {
    console.log('[Deduplicator] Hydrating in-memory seenContentHashes from Supabase...');
    const { data, error } = await supabase
      .from('articles')
      .select('title, url')
      .order('ingested_at', { ascending: false })
      .limit(3000);

    if (error) {
      console.warn('[Deduplicator] ⚠️ Failed to hydrate seenContentHashes:', error.message);
      return;
    }

    if (Array.isArray(data)) {
      for (const item of data) {
        const hash = generateContentHash(item);
        seenContentHashes.add(hash);
      }
      console.log(`[Deduplicator] ✅ Hydrated ${seenContentHashes.size} content hashes into memory for O(1) deduplication.`);
    }
  } catch (err) {
    console.warn('[Deduplicator] ⚠️ Exception hydrating content hashes:', err.message);
  }
}

// In-Memory Fallback Caches (Maintains zero-lag operation if external DB is disconnected)
const memoryArticles = [];
const memoryAlertLogs = [];

// ============================================================================
// 2. LOCAL AI TRIAGE ENGINE (Ollama / qwen2.5)
// ============================================================================
/**
 * Triage raw news content using local Ollama model (Qwen 2.5).
 * Strictly enforces JSON output schema and handles timeouts/parsing errors.
 *
 * @param {string} rawContent Raw article or post text
 * @param {string} [title=''] Article headline
 * @param {string} [sourceName=''] Source publisher or handle
 * @returns {Promise<{
 *   entity: string,
 *   sentiment: 'Positive'|'Neutral'|'Negative',
 *   theme: string,
 *   risk_score: number,
 *   risk_level: 'Low'|'Medium'|'High'|'Critical',
 *   requires_voice_escalation: boolean,
 *   five_bullet_summary: string[]
 * }>}
 */
// ============================================================================
// 2. CONFIGURABLE ALERT RULES ENGINE
// ============================================================================
export const ALERT_RULES = [
  {
    name: 'Critical Existential Crisis',
    entity: 'Infosys',
    minRiskScore: 8.5,
    riskLevel: 'Critical',
    channels: ['Slack', 'WhatsApp', 'Voice'],
    voiceEscalation: true
  },
  {
    name: 'High Risk Regulatory or Outage',
    entity: 'Infosys',
    minRiskScore: 6.5,
    riskLevel: 'High',
    channels: ['Slack', 'WhatsApp'],
    voiceEscalation: false
  },
  {
    name: 'Competitor Strategic Movement',
    entity: 'Competitors',
    minRiskScore: 6.0,
    riskLevel: 'High',
    channels: ['Slack'],
    voiceEscalation: false
  },
  {
    name: 'Operational Intelligence Watch',
    entity: 'All',
    minRiskScore: 4.0,
    riskLevel: 'Medium',
    channels: ['Email'],
    voiceEscalation: false
  }
];

export function evaluateAlertRules(triage) {
  const channels = new Set();
  let requiresVoice = false;
  const entityNorm = String(triage.entity || '').toLowerCase();
  const isClient = entityNorm === 'infosys';

  for (const rule of ALERT_RULES) {
    const entityMatch =
      rule.entity === 'All' ||
      (rule.entity === 'Infosys' && isClient) ||
      (rule.entity === 'Competitors' && !isClient);

    if (entityMatch && triage.risk_score >= rule.minRiskScore) {
      rule.channels.forEach((c) => channels.add(c));
      if (rule.voiceEscalation && isClient) requiresVoice = true;
    }
  }

  return {
    channels: Array.from(channels),
    requiresVoice: requiresVoice || (isClient && triage.risk_level === 'Critical')
  };
}

// Low-Latency Parallel Ingestion Gateway
export const ingestionGateway = new IngestionGateway({
  supabase,
  maxArticleAgeHours: 12,
  ollamaBaseUrl: OLLAMA_BASE_URL,
  ollamaModel: OLLAMA_MODEL,
  alertRulesEvaluator: evaluateAlertRules,
  notifiers: {
    sendSlackAlert,
    sendWhatsAppAlert,
    sendEmailAlert,
    triggerVoiceCall
  },
  onArticleCommitted: (article) => {
    // Keep in-memory cache synchronized for fast client reads
    memoryArticles.unshift(article);
    if (memoryArticles.length > 500) memoryArticles.pop();
  },
  onArticleUpdated: (updated) => {
    // Synchronize AI-triaged fields into memoryArticles in-place without duplicating cards
    const idx = memoryArticles.findIndex((a) => a.id === updated.id);
    if (idx !== -1) {
      memoryArticles[idx] = {
        ...memoryArticles[idx],
        ...updated,
        risk_level: updated.risk_level || memoryArticles[idx].risk_level,
        risk_score: updated.risk_score ?? memoryArticles[idx].risk_score,
        five_bullet_summary: updated.five_bullet_summary || memoryArticles[idx].five_bullet_summary,
        status: updated.status || memoryArticles[idx].status,
        triaged_at: updated.triaged_at || memoryArticles[idx].triaged_at
      };
      console.log(`[Server] 🔄 Synchronized AI triage into memory cache for ID: ${updated.id} (${updated.risk_level} ${updated.risk_score}/10)`);
    }
  }
});

/**
 * Startup warm-up ping for local Ollama model to ensure weights are pre-loaded in VRAM
 */
export async function warmupOllama() {
  console.log(`[Ollama] 🔄 Sending warm-up ping to model ${OLLAMA_MODEL}...`);
  try {
    const start = Date.now();
    await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
      model: OLLAMA_MODEL,
      prompt: 'ping',
      stream: false,
      options: { num_predict: 5 }
    }, { timeout: 35000 });
    console.log(`[Ollama] ✅ Model ${OLLAMA_MODEL} warmed up and ready in VRAM (${Date.now() - start}ms).`);
    return true;
  } catch (err) {
    console.warn(`[Ollama] ⚠️ Warm-up notice (${err.message}). Model will initialize on first inference.`);
    return false;
  }
}

/**
 * Hardcode a programmatic safeguard following triage:
 * Only primary client "Infosys" can ever receive Critical risk or voice escalation.
 * Competitors (TCS, Wipro, Accenture) are strategic market intelligence and are
 * capped at High (max 7.5), with voice escalation always set to false.
 */
export function normalizeTriage(triage) {
  if (!triage) return triage;

  // Force entity boundary
  const rawEntity = String(triage.entity || 'Infosys').trim();
  const isClient = rawEntity.toLowerCase() === 'infosys';

  if (!isClient) {
    // Hard clamp: Competitors can NEVER be CRITICAL
    if (triage.risk_level === 'Critical') {
      triage.risk_level = 'High'; // Downgrade to High
    }
    if (triage.risk_score > 7.5) {
      triage.risk_score = 7.5; // Cap score to 7.5 max
    }
    // Competitors NEVER wake up leadership with an emergency voice call
    triage.requires_voice_escalation = false;
  } else {
    // For primary client (Infosys): voice escalation ONLY if Critical
    triage.requires_voice_escalation = triage.risk_level === 'Critical';
  }

  return triage;
}

// ============================================================================
// SIMILARITY CALCULATION & DEDUPLICATION AUDIT
// ============================================================================
export function calculateStringSimilarity(str1, str2) {
  const s1 = (str1 || '').toLowerCase().trim();
  const s2 = (str2 || '').toLowerCase().trim();
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;
  
  const words1 = s1.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  const words2 = s2.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  if (union.size === 0) return 0.0;
  return Number((intersection.size / union.size).toFixed(3));
}

export const droppedDuplicatePairs = [];

// ============================================================================
// OLLAMA CONCURRENCY LIMITER & TRIAGE METRICS TRACKER
// ============================================================================
let ollamaQueue = Promise.resolve();
let pendingQueueDepth = 0;
const MAX_QUEUE_DEPTH = 35; // Maximum queue backlog before deterministic fallback

export const cycleTriageStats = {
  cycleId: 0,
  sentToOllama: 0,
  succeeded: 0,
  fallback: 0,
  fallbackReasons: {
    timeout: 0,
    error: 0,
    queueFull: 0,
    other: 0
  },
  latencies: []
};

export function startNewTriageCycle(cycleId) {
  cycleTriageStats.cycleId = cycleId;
  cycleTriageStats.sentToOllama = 0;
  cycleTriageStats.succeeded = 0;
  cycleTriageStats.fallback = 0;
  cycleTriageStats.fallbackReasons = { timeout: 0, error: 0, queueFull: 0, other: 0 };
  cycleTriageStats.latencies = [];
}

export function logCycleTriageSummary() {
  const avgLat = cycleTriageStats.latencies.length > 0
    ? (cycleTriageStats.latencies.reduce((a, b) => a + b, 0) / cycleTriageStats.latencies.length).toFixed(0)
    : 0;
  console.log(`\n================== [OLLAMA TRIAGE CYCLE METRICS: Cycle #${cycleTriageStats.cycleId}] ==================`);
  console.log(`📊 Total Articles Sent to Ollama: ${cycleTriageStats.sentToOllama}`);
  console.log(`✅ Succeeded with Real Model:    ${cycleTriageStats.succeeded} (Avg Latency: ${avgLat}ms)`);
  console.log(`⚠️ Hit Deterministic Fallback:  ${cycleTriageStats.fallback}`);
  console.log(`   - Timeouts (>45s):            ${cycleTriageStats.fallbackReasons.timeout}`);
  console.log(`   - Model Errors/HTTP Fail:     ${cycleTriageStats.fallbackReasons.error}`);
  console.log(`   - Queue Full (>35 queued):    ${cycleTriageStats.fallbackReasons.queueFull}`);
  console.log(`============================================================================\n`);
}

/**
 * Triage raw news content using local Ollama model (Qwen 2.5).
 * Processes requests sequentially through a concurrency limiter (queue)
 * to avoid overloading local GPU/CPU VRAM.
 */
export async function triageArticle(rawContent, title = '', sourceName = '') {
  cycleTriageStats.sentToOllama++;

  if (pendingQueueDepth >= MAX_QUEUE_DEPTH) {
    cycleTriageStats.fallback++;
    cycleTriageStats.fallbackReasons.queueFull++;
    console.warn(`[Ollama Queue] ⚠️ Queue backlog exceeded (${pendingQueueDepth} pending). Triggering deterministic fallback.`);
    return deterministicFallbackTriage(rawContent, title);
  }

  pendingQueueDepth++;

  // Serial execution queue: each prompt executes after the previous one finishes
  return new Promise((resolve) => {
    ollamaQueue = ollamaQueue.then(async () => {
      try {
        const result = await executeOllamaTriage(rawContent, title, sourceName);
        resolve(result);
      } catch (err) {
        cycleTriageStats.fallback++;
        cycleTriageStats.fallbackReasons.error++;
        resolve(deterministicFallbackTriage(rawContent, title));
      } finally {
        pendingQueueDepth = Math.max(0, pendingQueueDepth - 1);
      }
    });
  });
}

async function executeOllamaTriage(rawContent, title = '', sourceName = '') {
  const prompt = [
    'You are the Vee-Alert crisis intelligence triage agent for enterprise primary client Infosys.',
    'TARGET CLIENT: Infosys.',
    'COMPETITORS: TCS, Wipro, Accenture.',
    '',
    'STRICT CLASSIFICATION RULES:',
    '1. "Critical" (and requires_voice_escalation: true) is EXCLUSIVELY RESERVED for Infosys facing existential threats (e.g., regulatory bans, SEBI/RBI probes, catastrophic security breaches, C-suite legal action).',
    '2. Competitor news (TCS, Wipro, Accenture) must NEVER be classified as "Critical", and requires_voice_escalation must ALWAYS be false. Competitor news is strategic market intelligence (Low, Medium, or at most High 7.5 max).',
    '3. Routine business developments (product launches, custom chip design, automotive semiconductor services, sponsorships, partnerships, Indore/expansion news, hiring, quarterly commentary) are LOW or MEDIUM risk (score 1.0 - 5.0), NOT regulatory crises.',
    '4. Factuality check: Differentiate verified facts from speculation/rumors. Speculative articles must be capped at "Medium" risk.',
    '',
    'Analyze the raw news content below and return ONLY a valid JSON object matching this exact schema:',
    '{',
    '  "entity": "String (e.g., Infosys, TCS, Wipro, Accenture)",',
    '  "sentiment": "String (Positive, Neutral, Negative)",',
    '  "theme": "String (e.g., Regulatory Compliance, Cloud Outage, Competitor Counter-Play, Strategic Innovation)",',
    '  "risk_score": Number between 1.0 and 10.0,',
    '  "risk_level": "String (Low, Medium, High, Critical)",',
    '  "requires_voice_escalation": Boolean,',
    '  "five_bullet_summary": [',
    '    "What happened: concise 1-sentence breakdown",',
    '    "Why it matters: strategic brand/financial/operational impact",',
    '    "Risk score rationale: justification for risk score",',
    '    "Competitor impact: effect on market parity or opportunity for rival vendors",',
    '    "Recommended action: immediate next operational step for crisis leadership"',
    '  ]',
    '}',
    'Do not include any explanation, conversational text, markdown formatting, or code fences. Output valid JSON only.',
    '',
    `Source: ${sourceName || 'Verified News Wire'}`,
    `Headline: ${title || 'Breaking Industry Alert'}`,
    `Content: ${rawContent}`
  ].join('\n');

  const tStart = Date.now();
  try {
    const controller = new AbortController();
    const ollamaTimeout = setTimeout(() => controller.abort(), 45000); // 45-second SLA timeout

    const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: {
        temperature: 0.1,
        num_predict: 400
      }
    }, {
      timeout: 45000,
      signal: controller.signal
    });

    clearTimeout(ollamaTimeout);

    const rawResponse = response.data?.response;
    if (rawResponse) {
      const sanitized = String(rawResponse).trim().replace(/^```json\s*/i, '').replace(/```$/i, '');
      const parsed = JSON.parse(sanitized);

      const entity = typeof parsed.entity === 'string' && parsed.entity.trim() ? parsed.entity.trim() : 'Infosys';
      const riskScore = Number(parsed.risk_score);
      const validScore = Number.isFinite(riskScore) ? Math.min(10, Math.max(1, Number(riskScore.toFixed(1)))) : 5.0;
      const validLevel = ['Low', 'Medium', 'High', 'Critical'].includes(parsed.risk_level)
        ? parsed.risk_level
        : (validScore >= 8.5 ? 'Critical' : validScore >= 6.5 ? 'High' : validScore >= 4 ? 'Medium' : 'Low');

      const bullets = Array.isArray(parsed.five_bullet_summary) && parsed.five_bullet_summary.length > 0
        ? parsed.five_bullet_summary.map((b) => String(b).trim()).slice(0, 5)
        : null;

      const rawTriage = {
        entity,
        sentiment: ['Positive', 'Neutral', 'Negative'].includes(parsed.sentiment) ? parsed.sentiment : 'Neutral',
        theme: typeof parsed.theme === 'string' && parsed.theme.trim() ? parsed.theme.trim() : 'Industry Intelligence',
        risk_score: validScore,
        risk_level: validLevel,
        requires_voice_escalation: validLevel === 'Critical',
        five_bullet_summary: bullets && bullets.length === 5 ? bullets : [
          `What happened: ${title || 'A major industry event was reported.'}`,
          'Why it matters: Event potentially alters market perception and client confidence.',
          `Risk score rationale: Assigned ${validScore}/10 based on evidence and client-specific threat level.`,
          'Competitor impact: Affects competitive positioning against TCS, Wipro, and Accenture.',
          'Recommended action: Convene response committee and issue proactive communication.'
        ]
      };

      const normalized = normalizeTriage(rawTriage);
      const latencyMs = Date.now() - tStart;
      cycleTriageStats.succeeded++;
      cycleTriageStats.latencies.push(latencyMs);
      console.log(`[Ollama Triage] ✅ Successfully triaged via model=ollama:${OLLAMA_MODEL} for "${(title || rawContent).slice(0, 45)}..." (Latency: ${latencyMs}ms)`);
      return normalized;
    }
  } catch (error) {
    const latencyMs = Date.now() - tStart;
    const isTimeout = error.code === 'ECONNABORTED' || error.name === 'AbortError' || error.message?.includes('timeout') || latencyMs >= 44000;
    cycleTriageStats.fallback++;
    if (isTimeout) {
      cycleTriageStats.fallbackReasons.timeout++;
    } else {
      cycleTriageStats.fallbackReasons.error++;
    }
    console.warn(`[Ollama Triage] ❌ Inference failed after ${latencyMs}ms (${error.code || error.message}). Status: ${error.response?.status || 'N/A'}. Reason: ${isTimeout ? 'Timeout (>45s)' : 'Error'}. Triggering deterministic fallback.`);
  }

  // Deterministic Local Fallback Triage
  return deterministicFallbackTriage(rawContent, title);
}

/**
 * High-accuracy deterministic heuristic triage for zero-downtime offline fallback.
 * Strictly adheres to client-only Critical rules and caps competitors at High (7.0 max).
 */
function deterministicFallbackTriage(content, title) {
  const text = `${title} ${content}`.toLowerCase();
  
  let entity = 'Infosys';
  if (text.includes('tcs') || text.includes('tata consultancy')) entity = 'TCS';
  else if (text.includes('wipro')) entity = 'Wipro';
  else if (text.includes('accenture')) entity = 'Accenture';
  else if (text.includes('infosys')) entity = 'Infosys';

  const isClient = entity === 'Infosys';

  // Routine announcements: product launches, semiconductor/chips, expansions, quarterly commentary
  const isRoutine = /chip design|semiconductor|product launch|partnership|sponsorship|expansion|indore|hiring|patent|facility|centre|results|quarterly|automotive/.test(text);

  // Severe crises
  const hasExistentialCrisis = /rbi|regulator|sebi|audit notice|fraud|subpoena|probe|penalty|sec probe|enforcement action/.test(text);
  const hasOperationalDisruption = /outage|blackout|lawsuit|downgrade|contract loss|ransomware|security breach/.test(text);

  let riskLevel = 'Low';
  let riskScore = 2.5;

  if (isClient) {
    if (hasExistentialCrisis) {
      riskLevel = 'Critical';
      riskScore = 9.5;
    } else if (hasOperationalDisruption) {
      riskLevel = 'High';
      riskScore = 7.5;
    } else if (isRoutine) {
      riskLevel = 'Low';
      riskScore = 2.5;
    } else {
      riskLevel = 'Medium';
      riskScore = 4.8;
    }
  } else {
    // Competitors: NEVER Critical. High is capped at 7.0 for sales counter-play
    if (hasExistentialCrisis || hasOperationalDisruption) {
      riskLevel = 'High';
      riskScore = 7.0;
    } else if (isRoutine) {
      riskLevel = 'Low';
      riskScore = 2.4;
    } else {
      riskLevel = 'Medium';
      riskScore = 4.5;
    }
  }

  const sentiment = (isClient && (riskLevel === 'Critical' || riskLevel === 'High'))
    ? 'Negative'
    : (!isClient && riskLevel === 'High')
    ? 'Positive'
    : 'Neutral';

  return normalizeTriage({
    entity,
    sentiment,
    theme: hasExistentialCrisis
      ? 'Regulatory & Compliance'
      : hasOperationalDisruption
      ? 'Operational Disruption'
      : isRoutine
      ? 'Strategic Product Innovation'
      : 'Enterprise Intelligence',
    risk_score: riskScore,
    risk_level: riskLevel,
    requires_voice_escalation: isClient && riskLevel === 'Critical',
    five_bullet_summary: [
      `What happened: A verified media update was reported concerning ${entity}.`,
      `Why it matters: ${isClient ? `Directly impacts Infosys's operational reputation and stakeholder perception.` : `Competitor market update offering strategic intelligence for Infosys.`}`,
      `Risk score rationale: Rated ${riskScore}/10 based on ${isClient ? (hasExistentialCrisis ? 'regulatory audit scrutiny directly targeting Infosys' : 'client operational impact') : 'competitor market development (non-existential to Infosys)'}.`,
      `Competitor impact: ${isClient ? 'Competitors may seek to exploit this development in competitive cloud deals.' : 'Creates immediate RFP displacement and competitive positioning opportunities for Infosys.'}`,
      `Recommended action: ${isClient ? (riskLevel === 'Critical' ? 'Immediate escalation to executive leadership and crisis response council.' : 'Monitor client sentiment and issue proactive clarification.') : 'Brief enterprise sales teams on competitor movement to capture market share.'}`
    ]
  });
}

// ============================================================================
// 3. DATABASE REPOSITORIES
// ============================================================================
async function insertArticleRecord(articlePayload) {
  if (!supabase) {
    memoryArticles.unshift(articlePayload);
    return { ...articlePayload, _dbSuccess: false };
  }
  const { data, error } = await supabase.from('articles').insert(articlePayload).select().single();
  if (error) {
    console.error('[Supabase] ❌ Insert Error:', error.message);
    memoryArticles.unshift(articlePayload);
    return { ...articlePayload, _dbSuccess: false };
  }
  // ── Latency Audit: split total gap into upstream lag vs our polling lag ──
  const now = new Date();
  const publishedAt = data.published_at ? new Date(data.published_at) : null;
  const ingestedAt  = data.ingested_at  ? new Date(data.ingested_at)  : now;
  const totalLagMin = publishedAt ? Math.round((ingestedAt - publishedAt) / 60000) : null;
  // Our polling lag = time from ingested_at stamp to now (how long it sat in pipeline before DB write)
  const ourPipelineLagSec = Math.round((now - ingestedAt) / 1000);
  const upstreamLagMin = totalLagMin !== null ? totalLagMin : '?';
  console.log(`[Supabase] ✅ COMMITTED TO DB: ID ${data.id} (Source: ${data.api_source}) at ${now.toLocaleTimeString()} | total_lag=${upstreamLagMin}min | pipeline_lag=${ourPipelineLagSec}s`);

  const apiSrc = (data.api_source || '').toLowerCase();
  const srcName = (data.source_name || '').toLowerCase();
  let key = 'newsapi';
  if (apiSrc.includes('currents') || srcName.includes('currents')) key = 'currents';
  else if (apiSrc.includes('bluesky') || srcName.includes('bsky')) key = 'bluesky';
  else if (apiSrc.includes('gnews') || srcName.includes('gnews')) key = 'gnews';
  else if (apiSrc.includes('newsdata') || srcName.includes('newsdata')) key = 'newsdata';
  else if (apiSrc.includes('gdelt') || srcName.includes('gdelt')) key = 'gdelt';
  else if (apiSrc.includes('guardian') || srcName.includes('guardian')) key = 'guardian';
  else if (apiSrc.includes('institutional') || apiSrc.includes('et rss') || srcName.includes('economic') || srcName.includes('mint') || srcName.includes('standard') || srcName.includes('reuters') || srcName.includes('bloomberg')) key = 'institutional';
  else if (apiSrc.includes('google') || srcName.includes('google') || apiSrc.includes('rss')) key = 'googlenews';

  if (sourceTelemetry[key]) {
    sourceTelemetry[key].lastNewArticle = data.ingested_at || new Date().toISOString();
  }
  return { ...data, _dbSuccess: true };
}

async function insertAlertLogRecord(logPayload) {
  if (!supabase) {
    memoryAlertLogs.unshift({ id: randomUUID(), ...logPayload });
    return logPayload;
  }
  const { data, error } = await supabase.from('alert_logs').insert(logPayload).select().single();
  if (error) {
    console.error('[Supabase Error: Insert Alert Log]', error.message);
    memoryAlertLogs.unshift({ id: randomUUID(), ...logPayload });
    return logPayload;
  }
  return data;
}

// ============================================================================
// 4. CENTRAL INGESTION PIPELINE (processIngest) WITH DEDUPLICATION
// ============================================================================
/**
 * Processes incoming raw news event through deduplication, AI triage, DB insertion,
 * alert dispatching, and mathematical SLA audit logging.
 *
 * @param {object} payload { source_name, url, raw_content, published_at, title }
 * @returns {Promise<object>} Ingestion result with SLA telemetry
 */
export async function processIngest(payload) {
  const ingested_at = Date.now();
  const ingestedIso = new Date(ingested_at).toISOString();

  const {
    api_source = 'Google News RSS',
    source_name = 'Verified News Wire',
    url = null,
    image_url = null,
    raw_content,
    published_at,
    title = ''
  } = payload || {};

  if (!raw_content || !String(raw_content).trim()) {
    throw new Error('raw_content is required for AI triage and ingestion');
  }

  const effectiveTitle = String(title || (String(raw_content).slice(0, 70).trim() + '...')).trim();
  const normalizedUrl = url ? String(url).trim() : null;

  // ============================================================================
  // RECENCY GUARDRAIL: HARD 12-HOUR CUTOFF BEFORE ANY DEDUP OR DB COMMIT
  // Enforce uniform maximum article age across all ingestion channels
  // ============================================================================
  if (published_at) {
    const pubTime = new Date(published_at).getTime();
    if (!isNaN(pubTime)) {
      const ageHours = (Date.now() - pubTime) / (3600 * 1000);
      if (ageHours > 12) {
        const ageDesc = ageHours >= 48 ? `${(ageHours / 24).toFixed(1)} days` : `${ageHours.toFixed(1)} hours`;
        console.log(`[Guardrail] 🚫 DROPPED STALE: "${effectiveTitle.slice(0, 50)}..." (published ${ageDesc} ago exceeds 12h window)`);
        return { success: true, skipped: true, reason: `Article published ${ageDesc} ago exceeds 12h recency window` };
      }
    }
  }

  // ============================================================================
  // PHASE 0: SHA-256 PRE-DATABASE O(1) DEDUPLICATION INTERCEPT
  // Reject existing hashes in O(1) time before any database queries or LLM calls occur
  // ============================================================================
  const contentHash = generateContentHash({ title: effectiveTitle, url: normalizedUrl });
  if (seenContentHashes.has(contentHash)) {
    console.log(`[Deduplicator] ⚡ DROPPED DUPLICATE (SHA-256 Hash Match): "${effectiveTitle.slice(0, 55)}..." [${contentHash.slice(0, 8)}]`);
    return { success: true, skipped: true, reason: 'Duplicate article detected (SHA-256 content hash)' };
  }

  // ============================================================================
  // STEP 2: DEDUPLICATION CHECK
  // Check if an article with the exact same URL OR Title already exists
  // ============================================================================
  if (supabase) {
    try {
      if (normalizedUrl) {
        const { data: byUrl } = await supabase
          .from('articles')
          .select('id, url, title, api_source')
          .eq('url', normalizedUrl)
          .limit(1);

        if (byUrl && byUrl.length > 0) {
          console.log(`[Deduplicator] DROPPED DUPLICATE (URL match): "${effectiveTitle.slice(0, 55)}..."`);
          return { success: true, skipped: true, reason: 'Duplicate article detected' };
        }
      }

      if (effectiveTitle) {
        const { data: byTitle } = await supabase
          .from('articles')
          .select('id, title, api_source')
          .eq('title', effectiveTitle)
          .limit(1);

        if (byTitle && byTitle.length > 0) {
          const matchedTitle = byTitle[0].title;
          const similarity = calculateStringSimilarity(effectiveTitle, matchedTitle);
          const pair = {
            incomingTitle: effectiveTitle,
            matchedTitle,
            similarityScore: similarity,
            incomingSource: api_source,
            matchedSource: byTitle[0].api_source,
            timestamp: new Date().toISOString()
          };
          droppedDuplicatePairs.push(pair);
          if (droppedDuplicatePairs.length > 100) droppedDuplicatePairs.shift();

          console.log(`[Deduplicator] 🔁 DROPPED DUPLICATE (Title match):`);
          console.log(`   Incoming:  "${effectiveTitle}" [${api_source}]`);
          console.log(`   Existing:  "${matchedTitle}" [${byTitle[0].api_source || 'DB'}]`);
          console.log(`   Similarity Score: ${(similarity * 100).toFixed(1)}%`);
          return { success: true, skipped: true, reason: 'Duplicate article detected', pair };
        }
      }
    } catch (checkErr) {
      console.warn('[Deduplicator] Check error (continuing):', checkErr.message);
    }
  } else {
    // In-memory deduplication check
    const existing = memoryArticles.find(
      (a) => (normalizedUrl && a.url === normalizedUrl) || (effectiveTitle && a.title === effectiveTitle)
    );
    if (existing) {
      const similarity = calculateStringSimilarity(effectiveTitle, existing.title);
      const pair = {
        incomingTitle: effectiveTitle,
        matchedTitle: existing.title,
        similarityScore: similarity,
        incomingSource: api_source,
        matchedSource: existing.api_source || 'Memory',
        timestamp: new Date().toISOString()
      };
      droppedDuplicatePairs.push(pair);
      if (droppedDuplicatePairs.length > 100) droppedDuplicatePairs.shift();

      console.log(`[Deduplicator] 🔁 DROPPED DUPLICATE (Title match in memory):`);
      console.log(`   Incoming:  "${effectiveTitle}" [${api_source}]`);
      console.log(`   Existing:  "${existing.title}" [${existing.api_source || 'Memory'}]`);
      console.log(`   Similarity Score: ${(similarity * 100).toFixed(1)}%`);
      return { success: true, skipped: true, reason: 'Duplicate article detected', pair };
    }
  }

  // ============================================================================
  // PHASE 1 GUARDRAIL: Strict entity keyword filter
  // Drops any article that does NOT mention our 4 target entities.
  // ============================================================================
  const TARGET_ENTITY_GUARDRAIL = /\b(Infosys|TCS|Tata Consultancy Services|Wipro|Accenture)\b/i;
  const articleText = `${effectiveTitle} ${raw_content}`;
  if (!TARGET_ENTITY_GUARDRAIL.test(articleText)) {
    console.warn(`[Guardrail] DROPPED IRRELEVANT (no target keywords): "${effectiveTitle.slice(0, 55)}..."`);
    return { success: true, skipped: true, reason: 'Failed keyword guardrail' };
  }

  console.log(`[Pipeline] >>> ARTICLE QUALIFIED: "${effectiveTitle.slice(0, 55)}..." [${api_source}] → Enqueuing for Ollama Triage...`);

  // Correlation ID tracking across all stages
  const correlation_id = payload?.correlation_id || `corr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // TRIAGE: Await local AI triage and apply programmatic normalization clamp
  const rawTriage = await triageArticle(raw_content, effectiveTitle, source_name);
  const triage = normalizeTriage(rawTriage);

  // TRIAGE TIMING: Capture triaged_at
  const triaged_at = Date.now();
  const triagedIso = new Date(triaged_at).toISOString();

  // BRIEFING TIMING: Capture briefed_at (completion of 5-point executive brief)
  const briefed_at = Date.now();
  const briefedIso = new Date(briefed_at).toISOString();

  const articleId = randomUUID();
  const articlePayload = {
    id: articleId,
    api_source: String(api_source || 'Google News RSS'),
    source_name: String(source_name),
    title: effectiveTitle,
    url: normalizedUrl,
    image_url: image_url ? String(image_url).trim() : null,
    raw_content: String(raw_content),
    entity_mentioned: triage.entity,
    sentiment: triage.sentiment,
    risk_score: triage.risk_score,
    risk_level: triage.risk_level,
    five_bullet_summary: triage.five_bullet_summary,
    status: 'ACTIVE',
    published_at: published_at ? new Date(published_at).toISOString() : ingestedIso,
    ingested_at: ingestedIso,
    triaged_at: triagedIso
  };

  // PARALLEL FORK A: Insert into Supabase articles table
  const dbForkPromise = insertArticleRecord(articlePayload);

  // PARALLEL FORK B: Evaluate rules and dispatch across multi-channels
  const { channels, requiresVoice } = evaluateAlertRules(triage);
  const dispatchPromises = [];

  if (channels.includes('Slack')) {
    dispatchPromises.push(sendSlackAlert(triage.five_bullet_summary, triage.risk_level, effectiveTitle, triage.risk_score));
  }
  if (channels.includes('WhatsApp')) {
    dispatchPromises.push(sendWhatsAppAlert(triage.five_bullet_summary, effectiveTitle, triage.risk_score));
  }
  if (channels.includes('Email')) {
    dispatchPromises.push(sendEmailAlert(triage.five_bullet_summary, effectiveTitle, triage.risk_score));
  }
  if (requiresVoice || triage.requires_voice_escalation) {
    dispatchPromises.push(triggerVoiceCall(triage.five_bullet_summary, effectiveTitle));
  }

  // Execute Fork A (article insert) and Fork B (dispatches) concurrently
  const [insertedArticle, dispatchResults] = await Promise.all([
    dbForkPromise,
    Promise.all(dispatchPromises)
  ]);

  // Record SHA-256 hash in memory to guarantee future O(1) deduplication
  seenContentHashes.add(contentHash);

  // Determine actual delivery vs skipped channels (Item 1 requirement)
  const dispatched_channels = [];
  const skipped_channels = [];

  for (const res of (dispatchResults || [])) {
    if (!res) continue;
    if (res.skipped === true) {
      if (res.channel) skipped_channels.push(res.channel);
    } else if (res.success === true) {
      if (res.channel) dispatched_channels.push(res.channel);
    } else {
      if (res.channel) skipped_channels.push(res.channel);
    }
  }

  // DISPATCH TIMING: Capture alerted_at / dispatched_at
  const dispatched_at = Date.now();
  const dispatchedIso = new Date(dispatched_at).toISOString();

  // Fire-and-forget update to log the dispatch time on the article
  if (insertedArticle && insertedArticle._dbSuccess === true && supabase) {
    supabase
      .from('articles')
      .update({ dispatched_at: dispatchedIso })
      .eq('id', insertedArticle.id)
      .then(({ error }) => {
        if (error) console.warn('[Supabase] dispatched_at update notice:', error.message);
      });
  }

  // Attach runtime pipeline telemetry & timestamps
  if (insertedArticle) {
    insertedArticle.correlation_id = correlation_id;
    insertedArticle.briefed_at = briefedIso;
    insertedArticle.alerted_at = dispatchedIso;
    insertedArticle.dispatched_at = dispatchedIso;
  }

  /**
   * SLA METRIC SPECIFICATION (Item 2 requirement):
   * 1. sla_seconds_from_ingest: (dispatched_at - ingested_at) / 1000
   *    Measures Vee-Alert's engine processing latency from the exact millisecond the article
   *    was discovered/ingested into the pipeline to when all alerts were dispatched.
   *    This is the contractual SLA metric evaluated against the sub-120 second guarantee,
   *    as published_at from third-party RSS feeds may be hours delayed by publisher syndication.
   *
   * 2. total_seconds_from_publish: (dispatched_at - published_at) / 1000
   *    Measures the macro time elapsed from the publisher's stated publication timestamp
   *    to final alert dispatch.
   */
  const publishTimeMs = articlePayload.published_at ? new Date(articlePayload.published_at).getTime() : ingested_at;
  const sla_seconds_from_ingest = Number(((dispatched_at - ingested_at) / 1000).toFixed(2));
  const total_seconds_from_publish = Number(((dispatched_at - publishTimeMs) / 1000).toFixed(2));
  const sla_breached = sla_seconds_from_ingest > 120;
  const latency_ms = dispatched_at - ingested_at;

  if (insertedArticle._dbSuccess === true) {
    const primaryChannel = requiresVoice ? 'Voice' : (dispatched_channels.includes('Slack') ? 'Slack' : (dispatched_channels[0] || 'Slack'));
    await insertAlertLogRecord({
      article_id: insertedArticle.id,
      channel: primaryChannel,
      dispatched_at: dispatchedIso,
      sla_seconds: sla_seconds_from_ingest,
      sla_breached: sla_breached
    });
  } else {
    console.warn(`[Alert Log] Skipped alert_logs insert — article did not commit to Supabase (in-memory fallback).`);
  }

  return {
    success: true,
    article: insertedArticle,
    triage,
    latency_ms,
    sla: {
      correlation_id,
      sla_metric_standard: 'ingested_at-based (measures internal pipeline velocity to dispatch)',
      published_at: articlePayload.published_at,
      ingested_at: ingestedIso,
      triaged_at: triagedIso,
      briefed_at: briefedIso,
      alerted_at: dispatchedIso,
      dispatched_at: dispatchedIso,
      sla_seconds: sla_seconds_from_ingest,
      sla_seconds_from_ingest,
      total_seconds_from_publish,
      sla_breached,
      sla_target_seconds: 120,
      dispatched_channels,
      skipped_channels
    }
  };
}

// POST /api/ingest - Main Ingest Endpoint
app.post('/api/ingest', async (req, res) => {
  try {
    const result = await processIngest(req.body);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[Ingest Route Error]', error);
    return res.status(400).json({ error: error.message });
  }
});

// POST /api/ingest/raw - Microservice & Python FastWire direct ingress
app.post('/api/ingest/raw', async (req, res) => {
  try {
    const raw = req.body || {};
    const text = raw.raw_content || raw.content || raw.text || raw.title || '';
    const payload = {
      title: raw.title || text.slice(0, 100).trim(),
      raw_content: text,
      source_name: raw.source_name || 'Indian FastWire (Direct)',
      api_source: raw.api_source || 'Telegram Direct',
      url: raw.url || `https://fastwire.internal/${Date.now()}`,
      published_at: raw.published_at || new Date().toISOString()
    };
    const result = await processIngest(payload);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[FastWire Route Error]', error);
    return res.status(400).json({ error: error.message });
  }
});

// ============================================================================
// WEBSUB (PubSubHubbub) PUSH WEBHOOK ENGINE (W3C Standard Google Alerts)
// ============================================================================
// GET /api/webhooks/websub - Handshake verification
app.get('/api/webhooks/websub', (req, res) => {
  const challenge = req.query['hub.challenge'];
  const topic = req.query['hub.topic'];
  const mode = req.query['hub.mode'];

  console.log(`[WebSub] ⚡ Handshake verification received: mode=${mode}, topic=${topic}`);
  if (challenge) {
    return res.status(200).send(String(challenge));
  }
  return res.status(400).send('Missing hub.challenge');
});

// POST /api/webhooks/websub - Instant push event delivery from Google Alerts Hub
app.post('/api/webhooks/websub', async (req, res) => {
  try {
    const rawXml = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || '');
    if (!rawXml || rawXml.length < 10) {
      return res.status(204).send();
    }

    const $ = cheerio.load(rawXml, { xmlMode: true });
    const entries = $('entry, item').toArray();

    console.log(`[WebSub] ⚡ Received push notification with ${entries.length} items from Google Alerts`);

    for (const el of entries) {
      const rawTitle = $(el).find('title').text().trim();
      const cleanTitle = rawTitle.replace(/<[^>]*>?/gm, '').trim();
      const link = $(el).find('link').attr('href') || $(el).find('link').text().trim();
      const published = $(el).find('published, pubDate, updated').text().trim();
      const rawSummary = $(el).find('content, summary, description').text().trim();
      const cleanContent = rawSummary.replace(/<[^>]*>?/gm, '').trim();

      if (!cleanTitle && !cleanContent) continue;

      // Asynchronously process incoming push alert through triage pipeline
      processIngest({
        title: cleanTitle || cleanContent.slice(0, 100),
        raw_content: cleanContent || cleanTitle,
        source_name: 'Google Alerts (WebSub Instant Push)',
        api_source: 'WebSub Push',
        url: link || `https://news.google.com/alert/${Date.now()}`,
        published_at: published ? new Date(published).toISOString() : new Date().toISOString()
      }).catch(err => console.error('[WebSub Process Error]', err.message));
    }

    // Acknowledge receipt to Google PubSubHubbub Hub immediately (204 No Content)
    return res.status(204).send();
  } catch (err) {
    console.error('[WebSub Webhook Error]', err);
    return res.status(500).send(err.message);
  }
});

// ============================================================================
// 5. ADDITIONAL PRODUCTION API ENDPOINTS
// ============================================================================

// ============================================================================
// REAL-TIME LINK REACHABILITY VALIDATOR & CACHE (24h In-Memory TTL)
// ============================================================================
const linkValidationCache = new Map(); // url -> { reachable: boolean, status: number, timestamp: number }

export async function checkUrlReachability(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') {
    return { reachable: false, status: 400, reason: 'Invalid URL' };
  }

  const cached = linkValidationCache.get(targetUrl);
  const now = Date.now();
  if (cached && (now - cached.timestamp < 24 * 3600 * 1000)) {
    return cached;
  }

  let reachable = false;
  let status = 0;
  try {
    const res = await axios.head(targetUrl, {
      timeout: 3500,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      validateStatus: () => true
    });
    status = res.status;
    if (res.status >= 200 && res.status < 400) {
      reachable = true;
    } else if (res.status === 405 || res.status === 403) {
      // Some servers block HEAD requests — fallback to small GET with byte range
      try {
        const getRes = await axios.get(targetUrl, {
          timeout: 3500,
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Range': 'bytes=0-200'
          },
          validateStatus: () => true
        });
        status = getRes.status;
        reachable = (getRes.status >= 200 && getRes.status < 400);
      } catch (_) {
        reachable = false;
      }
    }
  } catch (err) {
    status = err.response?.status || 500;
    reachable = false;
  }

  const entry = { reachable, status, timestamp: now };
  linkValidationCache.set(targetUrl, entry);
  return entry;
}

// GET /api/validate-link?url=...
app.get('/api/validate-link', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url query param' });
  const result = await checkUrlReachability(String(url));
  return res.json(result);
});

// POST /api/validate-links - Batch validation
app.post('/api/validate-links', async (req, res) => {
  const urls = Array.isArray(req.body.urls) ? req.body.urls.slice(0, 100) : [];
  const results = {};
  await Promise.all(
    urls.map(async (u) => {
      const checked = await checkUrlReachability(u);
      results[u] = checked.reachable;
    })
  );
  return res.json({ results });
});

// GET /api/health - Diagnostic telemetry
app.get('/api/health', async (_req, res) => {
  res.json({
    status: 'online',
    system: 'Vee-Alert Real-Time Media Intelligence & Crisis War Room',
    target_client: 'Infosys',
    competitors_monitored: ['TCS', 'Wipro', 'Accenture'],
    sla_target: '< 120 seconds',
    ollama: {
      endpoint: OLLAMA_BASE_URL,
      model: OLLAMA_MODEL
    },
    supabase_connected: Boolean(supabase),
    total_articles_cached: memoryArticles.length
  });
});

// GET /api/sources - Configured intelligence sources status & telemetry
app.get('/api/sources', (_req, res) => {
  const sourcesConfig = [
    {
      id: 'newsapi',
      name: 'NewsAPI (Global Aggregator)',
      type: 'REST API',
      configured: Boolean((process.env.NEWSAPI_KEY || '').trim()),
      provider: 'NewsAPI.org',
      category: 'Aggregator',
      intervalSec: 60
    },
    {
      id: 'gdelt',
      name: 'GDELT DOC 2.0 (Global Discovery)',
      type: 'REST API',
      configured: true,
      provider: 'GDELT Project',
      category: 'Discovery',
      intervalSec: 60
    },
    {
      id: 'currents',
      name: 'Currents Global News API',
      type: 'REST API',
      configured: Boolean((process.env.CURRENTS_API_KEY || '').trim()),
      provider: 'Currents API',
      category: 'Aggregator',
      intervalSec: 60
    },
    {
      id: 'googlenews',
      name: 'Google News RSS (Instant Wire)',
      type: 'XML Stream',
      configured: true,
      provider: 'Google News Syndicate',
      category: 'Wire',
      intervalSec: 30
    },
    {
      id: 'institutional',
      name: 'Institutional Publisher Wires (ET, Mint, BS)',
      type: 'RSS/XML',
      configured: true,
      provider: 'Financial Wire Feeds',
      category: 'Institutional',
      intervalSec: 30
    },
    {
      id: 'bluesky',
      name: 'Bluesky Social Wire (AT Protocol Trial)',
      type: 'AT Protocol',
      configured: true,
      provider: 'Bluesky Network',
      category: 'Social Wire',
      intervalSec: 45
    },
    {
      id: 'gnews',
      name: 'GNews AI-Curated Wire',
      type: 'REST API',
      configured: Boolean((process.env.GNEWS_API_KEY || '').trim()),
      provider: 'GNews.io',
      category: 'Aggregator',
      intervalSec: 60
    },
    {
      id: 'newsdata',
      name: 'NewsData.io Real-Time Archive',
      type: 'REST API',
      configured: Boolean((process.env.NEWSDATA_API_KEY || '').trim()),
      provider: 'NewsData.io',
      category: 'Archive',
      intervalSec: 60
    },
    {
      id: 'guardian',
      name: 'The Guardian Content API',
      type: 'REST API',
      configured: Boolean((process.env.GUARDIAN_API_KEY || '').trim()),
      provider: 'The Guardian OpenPlatform',
      category: 'Publisher',
      intervalSec: 60
    },
    {
      id: 'eventregistry',
      name: 'Event Registry (Minute Stream)',
      type: 'Minute Stream',
      configured: Boolean((process.env.EVENT_REGISTRY_API_KEY || '').trim()),
      provider: 'Event Registry',
      category: 'Wire',
      intervalSec: 60
    }
  ];

  const gatewayHealth = ingestionGateway ? ingestionGateway.getHealthSummary() : null;
  const providerHealthMap = {};
  if (gatewayHealth && Array.isArray(gatewayHealth.providers)) {
    for (const p of gatewayHealth.providers) {
      providerHealthMap[p.providerName] = p;
    }
  }

  const enrichedSources = sourcesConfig.map((s) => {
    const telem = sourceTelemetry[s.id] || {};
    const adapterHealth = providerHealthMap[s.id] || {};

    let status = adapterHealth.status || telem.lastStatus || (s.configured ? 'Operational' : 'Disabled');
    if (status === 'HEALTHY' || status === 'POLLING' || status === 'CONNECTED') status = 'Operational';
    if (status === 'RATE_LIMITED') status = 'Rate Limited';
    if (status === 'DEGRADED') status = 'Degraded';
    if (status === 'DISABLED') status = 'Disabled';

    return {
      ...s,
      lastPolled: adapterHealth.lastSuccessAt || adapterHealth.lastFailureAt || telem.lastPolled || null,
      lastStatus: status,
      lastCount: adapterHealth.successCount ?? (typeof telem.lastCount === 'number' ? telem.lastCount : 0),
      lastNewArticle: adapterHealth.lastArticleAt || telem.lastNewArticle || null,
      metrics: {
        requests: adapterHealth.requests || 0,
        errors: adapterHealth.errorCount || 0,
        rateLimits: adapterHealth.rateLimitCount || 0,
        averageLatencyMs: adapterHealth.averageLatencyMs || 0,
        p95LatencyMs: adapterHealth.p95LatencyMs || 0,
        eventsPerMinute: adapterHealth.eventsPerMinute || 0
      }
    };
  });

  res.json({ sources: enrichedSources });
});

// GET /api/providers/health - Real-time Provider Adapter & Gateway Health
app.get('/api/providers/health', (_req, res) => {
  if (!ingestionGateway) {
    return res.status(503).json({ error: 'Ingestion gateway not initialized' });
  }
  res.json(ingestionGateway.getHealthSummary());
});

// GET /api/search/live - Ultra-fast multi-source on-demand news search (Google News RSS + GDELT 2.0)
app.get('/api/search/live', async (req, res) => {
  try {
    const query = req.query.query || req.query.q || 'Infosys';
    const limit = parseInt(req.query.limit, 10) || 50;
    const result = await SearchService.searchAll(query, { maxResults: limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

// POST /api/verify-threat - On-demand threat deep-dive verification (Google Custom Search)
app.post('/api/verify-threat', async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ success: false, error: 'Query required' });
  }

  try {
    const results = await fetchVerificationContext(query.trim());
    res.json({ success: true, count: results.length, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/articles - Fetch active crisis feeds
app.get('/api/articles', async (_req, res) => {
  try {
    let rows = [];
    if (supabase) {
      const { data, error } = await supabase
        .from('articles')
        .select('*')
        .not('status', 'eq', 'DUPLICATE')
        .order('ingested_at', { ascending: false })
        .limit(300);

      if (error) throw error;
      rows = data || [];
    } else {
      rows = memoryArticles.filter(a => a.status !== 'DUPLICATE');
    }

    // Enrich rows to satisfy the full Frontend Data Contract (Section 44)
    const enriched = rows.map((art) => {
      const cluster = ingestionGateway?.deduplicator?.storyClusters ? 
        Array.from(ingestionGateway.deduplicator.storyClusters.values()).find(c => c.articles.includes(art.id)) : null;

      return {
        ...art,
        articleId: art.id,
        provider: art.api_source,
        publisher: art.source_name,
        publishedAt: art.published_at,
        receivedAt: art.received_at || art.ingested_at,
        detectedAt: art.ingested_at,
        triagedAt: art.triaged_at,
        dispatchedAt: art.dispatched_at,
        severity: art.risk_level,
        riskScore: art.risk_score,
        entities: [art.entity_mentioned].filter(Boolean),
        themes: [art.theme].filter(Boolean),
        summary: art.five_bullet_summary,
        storyClusterId: cluster?.id || null,
        sourceCount: cluster?.publishers?.size || 1,
        duplicateStatus: art.duplicate_status || (art.status === 'DUPLICATE' ? 'EXACT_DUPLICATE' : 'UNIQUE')
      };
    });

    return res.json({ articles: enriched });
  } catch (err) {
    console.error('[Articles Route Error]', err.message);
    return res.status(500).json({ error: err.message, articles: [] });
  }
});

// GET /api/duplicates - Audit trail of dropped duplicate articles
app.get('/api/duplicates', (_req, res) => {
  const audit = ingestionGateway?.deduplicator?.getDuplicateAuditTrail() || [];
  res.json({ total: audit.length, duplicates: audit });
});

// PATCH /api/articles/:id/acknowledge
app.patch('/api/articles/:id/acknowledge', async (req, res) => {
  const { id } = req.params;
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from('articles')
        .update({ status: 'ACKNOWLEDGED' })
        .eq('id', id)
        .select()
        .single();

      if (!error && data) {
        return res.json({ success: true, article: data });
      }
    }
    const memItem = memoryArticles.find((item) => item.id === id);
    if (memItem) memItem.status = 'ACKNOWLEDGED';
    return res.json({ success: true, article: memItem || { id, status: 'ACKNOWLEDGED' } });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to acknowledge article' });
  }
});

// GET /api/ingestion/diagnostics - Comprehensive real-time provider health telemetry
app.get('/api/ingestion/diagnostics', (_req, res) => {
  return res.json(ingestionGateway.getDetailedDiagnostics());
});

// POST /api/fetch-live - Manual trigger to immediately scrape & ingest authentic live news across all sources
app.post('/api/fetch-live', async (_req, res) => {
  try {
    console.log('[API] /api/fetch-live triggered: Running on-demand manual fetch across active providers...');
    const results = await ingestionGateway.triggerManualFetch();
    const articles = memoryArticles.slice(0, 30);
    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      results,
      count: articles.length,
      articles
    });
  } catch (error) {
    console.error('[API] /api/fetch-live error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Backward compatibility alias for legacy triggers
app.post('/api/simulate-crisis', async (_req, res) => {
  try {
    console.log('[API] /api/simulate-crisis called: redirecting to gateway manual fetch...');
    const results = await ingestionGateway.triggerManualFetch();
    return res.status(200).json({
      success: true,
      message: 'Gateway manual fetch triggered',
      results,
      count: memoryArticles.length,
      articles: memoryArticles.slice(0, 30)
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/news/fetch - On-demand trigger for live multi-source aggregation
app.post('/api/news/fetch', async (_req, res) => {
  try {
    const results = await ingestionGateway.triggerManualFetch();
    return res.json({ success: true, results, count: memoryArticles.length, articles: memoryArticles.slice(0, 30) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/debug/triage-stats - Audit metrics and dropped duplicate pairs
app.get('/api/debug/triage-stats', (_req, res) => {
  return res.json({
    cycleTriageStats,
    droppedDuplicatePairs: droppedDuplicatePairs.slice(-20)
  });
});

// ============================================================================
// 6. SERVER LAUNCH & AUTOMATED BACKGROUND INGESTION ENGINE
// ============================================================================
async function initSourceTelemetryFromDb() {
  if (!supabase) return;
  try {
    const { data: latestArticles, error } = await supabase
      .from('articles')
      .select('api_source, source_name, ingested_at, published_at')
      .order('ingested_at', { ascending: false })
      .limit(500);

    if (!error && latestArticles && Array.isArray(latestArticles)) {
      for (const art of latestArticles) {
        const apiSrc = (art.api_source || '').toLowerCase();
        const srcName = (art.source_name || '').toLowerCase();
        let key = 'newsapi';
        if (apiSrc.includes('currents') || srcName.includes('currents')) key = 'currents';
        else if (apiSrc.includes('bluesky') || srcName.includes('bsky')) key = 'bluesky';
        else if (apiSrc.includes('gnews') || srcName.includes('gnews')) key = 'gnews';
        else if (apiSrc.includes('newsdata') || srcName.includes('newsdata')) key = 'newsdata';
        else if (apiSrc.includes('gdelt') || srcName.includes('gdelt')) key = 'gdelt';
        else if (apiSrc.includes('guardian') || srcName.includes('guardian')) key = 'guardian';
        else if (apiSrc.includes('institutional') || apiSrc.includes('et rss') || srcName.includes('economic') || srcName.includes('mint') || srcName.includes('standard') || srcName.includes('reuters') || srcName.includes('bloomberg')) key = 'institutional';
        else if (apiSrc.includes('google') || srcName.includes('google') || apiSrc.includes('rss')) key = 'googlenews';

        if (sourceTelemetry[key] && !sourceTelemetry[key].lastNewArticle) {
          sourceTelemetry[key].lastNewArticle = art.ingested_at || art.published_at;
        }
      }
    }
  } catch (err) {
    console.warn('[Telemetry] DB telemetry init notice:', err.message);
  }
}

const isTestRun = process.env.NODE_ENV === 'test' || Boolean(process.argv[1] && (
  process.argv[1].includes('test_verify') ||
  process.argv[1].includes('test.') ||
  process.argv[1].endsWith('test.js')
));

if (!isTestRun) {
  const server = app.listen(PORT, async () => {
    console.log(`\n=============================================================`);
    console.log(`🚀 [Vee-Alert Backend] Listening on http://localhost:${PORT}`);
    console.log(`🧠 [Local AI Engine] Ollama model: ${OLLAMA_MODEL} at ${OLLAMA_BASE_URL}`);
    console.log(`📦 [Database] Supabase ${supabase ? 'Configured & Connected' : 'Not configured (In-memory fallback)'}`);
    console.log(`⚡ [SLA Target] Sub-60s polling lag on RSS; upstream aggregator lag varies by source`);
    console.log(`🛡️ [Deduplicator] SHA-256 Pre-Database O(1) deduplication active`);
    console.log(`📰 [News Sources] Low-Latency Parallel Ingestion Gateway Active`);
    console.log(`⏱️ [Scheduler] Single Authoritative Gateway Scheduler with Independent Provider Cooldowns`);
    console.log(`=============================================================\n`);

    // Pre-warm local Ollama weights in VRAM to eliminate cold inference lag
    await warmupOllama();

    // Hydrate SHA-256 content hashes from Supabase for instant O(1) deduplication
    await hydrateSeenContentHashes();

    // Hydrate source telemetry with most recent article timestamps from DB
    await initSourceTelemetryFromDb();

    // Start the low-latency parallel ingestion gateway
    await ingestionGateway.start();
  });

  // Handle port-already-in-use gracefully instead of crashing with unhandled error event
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ [Vee-Alert] Port ${PORT} is already in use.`);
      console.error(`   Another server process is still running.`);
      console.error(`   Fix: run  netstat -ano | findstr :${PORT}  to find the PID,`);
      console.error(`   then:     taskkill /F /PID <PID>\n`);
    } else {
      console.error(`\n❌ [Vee-Alert] Server error:`, err.message);
    }
    process.exit(1);
  });
}

export default app;
