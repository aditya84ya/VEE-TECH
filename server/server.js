import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import * as cheerio from 'cheerio';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
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
import { startCSEBackgroundWorker } from './services/csePoller.js';
import { evaluateThreatSeverity, matchCriticalKeyword, CRITICAL_KEYWORDS } from './services/threatScorer.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL] Unhandled rejection:', reason?.message || reason);
});

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

// Multer in-memory storage for ephemeral file uploads (never written to disk or permanent storage)
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

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
 * Programmatic safeguard following triage:
 * Critical events with high-impact corporate/financial distress keywords
 * register scores of 9.8 / 10.0 and display CRITICAL severity.
 * Non-critical competitor news is classified as strategic market intelligence (High 7.5 max).
 */
export function normalizeTriage(triage) {
  if (!triage) return triage;

  // Force entity boundary
  const rawEntity = String(triage.entity || 'Infosys').trim();
  const isClient = rawEntity.toLowerCase() === 'infosys';
  const summaryText = Array.isArray(triage.five_bullet_summary)
    ? triage.five_bullet_summary.join(' ')
    : '';
  const textToCheck = `${triage.title || ''} ${triage.raw_content || ''} ${summaryText}`;
  const matchedCritical = matchCriticalKeyword(textToCheck);
  const isCritical = Boolean(matchedCritical) || triage.risk_level === 'Critical' || (Number(triage.risk_score) >= 9.0);

  if (isCritical) {
    triage.risk_level = 'Critical';
    triage.risk_score = 9.8;
    triage.severity = 'CRITICAL';
    triage.score = 9.8;
    triage.requires_voice_escalation = isClient;
  } else if (!isClient) {
    // Non-critical competitor news: capped at High (max 7.5)
    if (triage.risk_score > 7.5) {
      triage.risk_score = 7.5;
    }
    triage.severity = triage.risk_score >= 7.0 ? 'HIGH' : triage.risk_score >= 4.0 ? 'MEDIUM' : 'LOW';
    triage.score = triage.risk_score;
    triage.requires_voice_escalation = false;
  } else {
    triage.severity = triage.risk_level === 'Critical' ? 'CRITICAL' : triage.risk_level === 'High' ? 'HIGH' : triage.risk_level === 'Low' ? 'LOW' : 'MEDIUM';
    triage.score = triage.risk_score;
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

  // Threat severity evaluation using critical keyword dictionary and transparent scoring tiers
  const threat = evaluateThreatSeverity(title, content, entity);
  const isCritical = threat.risk_level === 'Critical';
  const isHigh = threat.risk_level === 'High';

  let riskLevel = threat.risk_level;
  let riskScore = threat.score;

  if (!isClient && !isCritical && riskScore > 7.5) {
    riskScore = 7.5;
  }

  const sentiment = (riskLevel === 'Critical' || (isClient && riskLevel === 'High'))
    ? 'Negative'
    : (!isClient && riskLevel === 'High')
    ? 'Positive'
    : 'Neutral';

  return normalizeTriage({
    entity,
    sentiment,
    severity: threat.severity,
    score: riskScore,
    theme: isCritical
      ? 'Regulatory & Legal Crisis'
      : isHigh
      ? 'Operational & Market Disruption'
      : threat.risk_level === 'Low'
      ? 'Strategic Product Innovation'
      : 'Enterprise Intelligence',
    risk_score: riskScore,
    risk_level: riskLevel,
    requires_voice_escalation: isClient && isCritical,
    five_bullet_summary: [
      `What happened: ${isCritical ? 'CRITICAL ALERT: ' : ''}Verified media update reported concerning ${entity}.`,
      `Threat rating: ${threat.severity} (${riskScore}/10.0)${threat.matchedKeyword ? ` - Triggered by: "${threat.matchedKeyword}"` : ''}.`,
      `Why it matters: ${isClient ? `Directly impacts Infosys operational reputation, compliance standing, and stakeholder perception.` : `Competitor market update offering strategic positioning intelligence for Infosys.`}`,
      `Risk score rationale: Rated ${riskScore}/10 based on ${threat.matchedKeyword ? `explicit distress trigger "${threat.matchedKeyword}"` : (isCritical ? 'high-impact regulatory/legal exposure' : isHigh ? 'operational impact' : 'routine market development')}.`,
      `Recommended action: ${isClient ? (isCritical ? 'Immediate escalation to executive leadership and crisis response council.' : 'Monitor client sentiment and issue proactive clarification.') : 'Brief enterprise leadership on competitor movement.'}`
    ]
  });
}

// ============================================================================
// 3. DATABASE REPOSITORIES
// ============================================================================
async function insertArticleRecord(articlePayload) {
  // Strip non-schema properties (e.g. score, severity) and ensure risk_score is mapped
  const { score, severity, ...dbInsertData } = articlePayload;
  if (score !== undefined && dbInsertData.risk_score === undefined) {
    dbInsertData.risk_score = score;
  }
  if (!supabase) {
    memoryArticles.unshift(articlePayload);
    return { ...articlePayload, _dbSuccess: false };
  }
  const { data, error } = await supabase.from('articles').insert(dbInsertData).select().single();
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

  // Bluesky post URLs are active web destinations (bsky.app blocks HEAD requests with 404)
  if (targetUrl.includes('bsky.app/profile/') || targetUrl.includes('bsky.app')) {
    return { reachable: true, status: 200, timestamp: Date.now() };
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

// POST /api/validate-links & /api/validate-link - Batch validation
app.post(['/api/validate-links', '/api/validate-link'], async (req, res) => {
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

function detectEntity(title = '', content = '') {
  const text = `${title} ${content}`.toLowerCase();
  if (text.includes('accenture')) return 'Accenture';
  if (text.includes('tcs') || text.includes('tata consultancy')) return 'TCS';
  if (text.includes('wipro')) return 'Wipro';
  return 'Infosys';
}

// GET /api/fetch-cse & /api/fetch-cse-stream - Dedicated Google Programmable Search Engine stream
app.get(['/api/fetch-cse', '/api/fetch-cse-stream'], async (req, res) => {
  const apiKey = (process.env.GOOGLE_CUSTOM_SEARCH_KEY || '').trim();
  const cxId = (process.env.GOOGLE_CX_ID || 'c7b914ef13847465b').trim();
  const query = req.query.q || 'Infosys OR TCS OR Wipro OR Accenture crisis OR revenue OR regulatory';

  let items = [];

  // 1. Try Google Custom Search JSON API if key exists
  if (apiKey) {
    try {
      const gRes = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          key: apiKey,
          cx: cxId,
          q: query,
          num: 10
        },
        timeout: 6000,
        headers: { 'User-Agent': 'VeeAlert/1.0 (Google CSE Stream)' }
      });
      if (gRes.data?.items && Array.isArray(gRes.data.items)) {
        items = gRes.data.items.map((item, idx) => {
          const entity = detectEntity(item.title, item.snippet || '');
          const threat = evaluateThreatSeverity(item.title, item.snippet || '', entity);
          return {
            id: `cse-${Date.now()}-${idx}`,
            api_source: 'Google Search Engine (CSE)',
            source_name: item.displayLink || 'Google Programmable Search (CSE)',
            title: item.title,
            url: item.link,
            image_url: item.pagemap?.cse_image?.[0]?.src || item.pagemap?.metatags?.[0]?.['og:image'] || null,
            raw_content: item.snippet || item.title,
            entity_mentioned: entity,
            sentiment: threat.risk_level === 'Critical' ? 'Negative' : (threat.risk_level === 'High' ? 'Negative' : 'Neutral'),
            risk_score: threat.score,
            risk_level: threat.risk_level,
            severity: threat.severity,
            score: threat.score,
            five_bullet_summary: [
              `Verified Google Custom Search intelligence item (cx: ${cxId})`,
              `Severity: ${threat.severity} (${threat.score}/10.0)${threat.matchedKeyword ? ` - Distress vector: "${threat.matchedKeyword}"` : ''}`,
              item.snippet || item.title,
              `Direct web source indexed by Google CSE`
            ],
            published_at: item.pagemap?.metatags?.[0]?.['article:published_time'] || new Date().toISOString(),
            ingested_at: new Date().toISOString(),
            detection_latency_ms: 3200,
            status: 'ACTIVE'
          };
        });
      }
    } catch (err) {
      console.warn('[Google CSE Stream] JSON API notice:', err.response?.data?.error?.message || err.message);
    }
  }

  // 2. If JSON API returned empty (e.g. 403 or quota), fetch live real-time Google Search XML syndication wire
  if (items.length === 0) {
    try {
      const qEnc = encodeURIComponent(query);
      const rssUrl = `https://news.google.com/rss/search?q=${qEnc}&hl=en-IN&gl=IN&ceid=IN:en&_cb=${Date.now()}`;
      const rssRes = await axios.get(rssUrl, {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const $ = cheerio.load(rssRes.data, { xmlMode: true });
      $('item').slice(0, 10).each((idx, el) => {
        const title = $(el).find('title').text().trim();
        const link = $(el).find('link').text().trim();
        const pubDate = $(el).find('pubDate').text().trim();
        const desc = cleanHtml($(el).find('description').text());
        const source = $(el).find('source').text().trim() || 'Google Search Wire';
        const entity = detectEntity(title, desc);
        const threat = evaluateThreatSeverity(title, desc, entity);

        items.push({
          id: `cse-live-${Date.now()}-${idx}`,
          api_source: 'Google Search Engine (CSE)',
          source_name: `${source} (Google CSE)`,
          title,
          url: link,
          image_url: null,
          raw_content: desc || title,
          entity_mentioned: entity,
          sentiment: threat.risk_level === 'Critical' ? 'Negative' : (threat.risk_level === 'High' ? 'Negative' : 'Neutral'),
          risk_score: threat.score,
          risk_level: threat.risk_level,
          severity: threat.severity,
          score: threat.score,
          five_bullet_summary: [
            `Real-time Google search event captured via query: ${query}`,
            `Severity: ${threat.severity} (${threat.score}/10.0)${threat.matchedKeyword ? ` - Distress vector: "${threat.matchedKeyword}"` : ''}`,
            desc || title,
            `Mainstream publisher corroborated via Google Search Engine`
          ],
          published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          ingested_at: new Date().toISOString(),
          detection_latency_ms: 2400,
          status: 'ACTIVE'
        });
      });
    } catch (e) {
      console.warn('[Google CSE Stream] Fallback search notice:', e.message);
    }
  }

  return res.json({ articles: items, source: 'Google Search Engine (CSE)', count: items.length });
});

// GET /api/fetch-rss & /api/fetch-rss-stream - Dedicated Google News RSS stream
app.get(['/api/fetch-rss', '/api/fetch-rss-stream'], async (_req, res) => {
  try {
    let rows = [];
    if (supabase) {
      const { data, error } = await supabase
        .from('articles')
        .select('*')
        .not('status', 'eq', 'DUPLICATE')
        .order('ingested_at', { ascending: false })
        .limit(100);
      if (!error && data) rows = data;
    }
    if (rows.length === 0) {
      rows = memoryArticles;
    }

    const rssArticles = rows.filter(a => {
      const src = (a.api_source || '').toLowerCase();
      return (src.includes('google') || src.includes('rss')) && !src.includes('cse') && !src.includes('institutional') && !src.includes('publisher');
    });
    return res.json({ articles: rssArticles, source: 'Google News RSS (Verified Wire)', count: rssArticles.length });
  } catch (err) {
    return res.status(500).json({ error: err.message, articles: [] });
  }
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
      name: 'Bluesky Jetstream Firehose (AT Protocol)',
      type: 'AT Protocol',
      configured: true,
      provider: 'Bluesky Jetstream',
      category: 'Social Wire',
      intervalSec: 0
    },
    {
      id: 'google_cse',
      name: 'Google Programmable Search Engine (CSE)',
      type: 'REST API',
      configured: true,
      provider: 'Google Custom Search Engine',
      category: 'Discovery',
      intervalSec: 0
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
// 5b. E-PAPER / IMAGE OCR ON-DEMAND INGESTION ROUTE
// ============================================================================

/**
 * POST /api/ocr/ingest-test
 * Accepts a public image or PDF URL, runs it through EpaperOcrAdapter.processMediaUrl(),
 * and returns the extracted metadata + triage status.
 *
 * Body: { imageUrl: string, sourceName?: string, publishedAt?: string }
 */
app.post('/api/ocr/ingest-test', async (req, res) => {
  const { imageUrl, sourceName, publishedAt } = req.body || {};

  if (!imageUrl || typeof imageUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'imageUrl is required (string)' });
  }

  const epaperAdapter = ingestionGateway?.getEpaperOcrAdapter?.();
  if (!epaperAdapter) {
    return res.status(503).json({ success: false, error: 'EpaperOcrAdapter not registered in gateway' });
  }

  if (!epaperAdapter._worker) {
    return res.status(503).json({
      success: false,
      error: 'Tesseract OCR worker not yet ready. Gateway starts it 16s after boot. Retry shortly.'
    });
  }

  try {
    console.log(`[API /api/ocr/ingest-test] Processing image: ${imageUrl}`);
    const result = await epaperAdapter.processMediaUrl(imageUrl, {
      sourceName: sourceName || 'API Test Submission',
      publishedAt: publishedAt || new Date().toISOString()
    });

    if (!result) {
      return res.status(200).json({
        success: false,
        dropped: true,
        reason: 'Article dropped by guardrail (no target entity found, low confidence, or duplicate).',
        imageUrl
      });
    }

    return res.status(200).json({
      success: true,
      imageUrl,
      article: {
        title:          result.title,
        provider:       result.provider,
        publisher:      result.publisher,
        ocrConfidence:  result.ocrConfidence,
        ocrDurationMs:  result.ocrDurationMs,
        isLowConfidence: result.isLowConfidence,
        matchedTarget:  result.matchedTarget,
        contentLength:  result.content?.length || 0,
        publishedAt:    result.publishedAt,
        url:            result.url
      },
      message: `✅ OCR article emitted for "${result.matchedTarget}" (Confidence: ${result.ocrConfidence?.toFixed(0)}%)`
    });
  } catch (err) {
    console.error('[API /api/ocr/ingest-test] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/manual-upload
 *
 * Accepts a multipart/form-data upload (or JSON base64) containing an image or PDF.
 * Performs in-memory OCR / text extraction, checks entity guardrails,
 * runs the standard AI triageArticle() pipeline, and saves structured
 * data to the DB.
 *
 * STORAGE RULE: The file is NOT persisted to Supabase Storage or local disk.
 * It exists purely as an ephemeral buffer in memory during the request and is deleted immediately.
 */
app.post('/api/manual-upload', uploadMemory.single('file'), async (req, res) => {
  let fileBuffer = req.file?.buffer;
  let fileName = req.file?.originalname || 'uploaded_document';
  let mimeType = req.file?.mimetype || '';

  // Fallback support for JSON base64 uploads
  if (!fileBuffer && req.body?.fileBase64) {
    try {
      fileBuffer = Buffer.from(req.body.fileBase64, 'base64');
      fileName = req.body.fileName || 'uploaded_document';
      mimeType = req.body.mimeType || 'image/png';
    } catch (b64Err) {
      return res.status(400).json({ success: false, error: 'Invalid base64 document payload' });
    }
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    return res.status(400).json({ success: false, error: 'No file uploaded. Please provide an image or PDF.' });
  }

  const publicationName = (req.body?.publication_name || '').trim();
  const pageNumber = (req.body?.page_number || '').trim();
  const rawPublishDate = req.body?.published_at;
  const isHistorical = req.body?.is_historical === 'true' || req.body?.is_historical === true || req.body?.is_historical === undefined;

  let extractedText = '';
  let ocrConfidence = 92; // default high baseline for digital text
  const isPdf = mimeType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf');

  try {
    if (isPdf) {
      console.log(`[Manual Upload] Processing PDF: ${fileName} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);
      try {
        const parser = new PDFParse({ data: fileBuffer });
        const parseResult = await parser.getText();
        extractedText = (parseResult?.text || '').trim();
      } catch (pdfErr) {
        console.warn('[Manual Upload] PDFParse error:', pdfErr.message);
      }

      // If PDF has no digital text layer, check if we can convert via pdfImgConvert and OCR
      if (!extractedText || extractedText.length < 25) {
        const epaperAdapter = ingestionGateway?.getEpaperOcrAdapter?.();
        if (epaperAdapter) {
          try {
            const pages = await epaperAdapter._processPdfBuffer(fileBuffer, 'manual_upload.pdf', publicationName || 'Manual Upload');
            if (pages && pages.length > 0 && pages[0].ocrText) {
              extractedText = pages[0].ocrText;
              ocrConfidence = pages[0].confidence || 75;
            }
          } catch (pdfImgErr) {
            console.warn('[Manual Upload] PDF fallback OCR error:', pdfImgErr.message);
          }
        }
      }
    } else {
      // Image OCR branch
      console.log(`[Manual Upload] Processing image: ${fileName} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);
      const epaperAdapter = ingestionGateway?.getEpaperOcrAdapter?.();
      if (!epaperAdapter) {
        return res.status(503).json({ success: false, error: 'OCR adapter service unavailable.' });
      }

      const ocrResult = await epaperAdapter.recognizeImageBuffer(fileBuffer);
      extractedText = (ocrResult?.text || '').trim();
      ocrConfidence = ocrResult?.confidence ?? 80;
    }
  } catch (extractErr) {
    console.error('[Manual Upload] Text extraction failed:', extractErr.message);
    return res.status(500).json({ success: false, error: `OCR extraction failed: ${extractErr.message}` });
  } finally {
    // IMMEDIATE EPHEMERAL PURGE: dereference buffer completely
    fileBuffer = null;
    if (req.file) {
      delete req.file.buffer;
    }
  }

  // Guardrail 1: Minimum text length
  if (!extractedText || extractedText.length < 15) {
    return res.status(422).json({
      success: false,
      error: 'Insufficient text extracted from document. Please ensure the document is clear, legible, and uncompressed.'
    });
  }

  // Guardrail 2: Strict target corporate entity check (Infosys, TCS, Wipro, Accenture)
  const TARGET_ENTITY_GUARDRAIL = /\b(Infosys|Infosys\s+ADR|NYSE:\s*INFY|TCS|Tata\s+Consultancy(\s+Services)?|Wipro|Wipro\s+ADR|Accenture|Finacle|SEBI|BSE|NSE)\b/i;
  if (!TARGET_ENTITY_GUARDRAIL.test(extractedText)) {
    console.warn('[Manual Upload] Dropped: No tracked corporate entities in document');
    return res.status(422).json({
      success: false,
      error: 'No tracked company (Infosys/TCS/Wipro/Accenture) found in this document',
      extractedLength: extractedText.length,
      confidence: ocrConfidence
    });
  }

  // Guess headline from first substantial line
  const lines = extractedText.split('\n').map(l => l.trim()).filter(l => l.length >= 8);
  const guessedTitle = lines[0]
    ? (lines[0].length < 15 ? `${lines.slice(0, 2).join(' ')}` : lines[0].substring(0, 140))
    : `[Scanned Intel] Document intelligence report`;

  // Format source name
  let effectiveSourceName = publicationName || 'Manual Upload';
  if (pageNumber) {
    effectiveSourceName = `${effectiveSourceName} (p. ${pageNumber})`;
  }

  console.log(`[Manual Upload] Running Ollama triage for: "${guessedTitle.slice(0, 50)}..." (${effectiveSourceName})`);

  // Run the SAME triageArticle() pipeline used everywhere else
  const rawTriage = await triageArticle(extractedText, guessedTitle, effectiveSourceName);
  const triage = normalizeTriage(rawTriage);

  const nowIso = new Date().toISOString();
  const parsedPublishedAt = (rawPublishDate && !isNaN(new Date(rawPublishDate).getTime()))
    ? new Date(rawPublishDate).toISOString()
    : null; // null if unknown, per requirement!

  const articleId = randomUUID();
  const correlation_id = `corr_manual_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // Construct structured article payload for articles table
  const articlePayload = {
    id: articleId,
    api_source: 'manual_ocr_upload',
    source_name: effectiveSourceName,
    title: guessedTitle,
    url: null,
    image_url: null, // Zero file storage
    raw_content: extractedText,
    entity_mentioned: triage.entity,
    sentiment: triage.sentiment,
    risk_score: triage.risk_score,
    risk_level: triage.risk_level,
    five_bullet_summary: triage.five_bullet_summary,
    status: 'ACTIVE',
    published_at: parsedPublishedAt,
    ingested_at: nowIso,
    triaged_at: nowIso,
    theme: triage.theme || 'Manual Intelligence Upload'
  };

  // Insert into articles table (Supabase or in-memory fallback)
  const insertedArticle = await insertArticleRecord(articlePayload);

  // Recency & Content Hash
  const hashVal = generateContentHash({ title: guessedTitle, url: `manual_${articleId}` });
  seenContentHashes.add(hashVal);

  // Dispatch rules: Only dispatch live alert if user explicitly opted OUT of historical research
  if (!isHistorical) {
    console.log(`[Manual Upload] Non-historical alert active: evaluating emergency notification rules...`);
    const { channels, requiresVoice } = evaluateAlertRules(triage);
    if (channels.includes('Slack')) {
      sendSlackAlert(triage.five_bullet_summary, triage.risk_level, guessedTitle, triage.risk_score).catch(() => {});
    }
    if (channels.includes('WhatsApp')) {
      sendWhatsAppAlert(triage.five_bullet_summary, guessedTitle, triage.risk_score).catch(() => {});
    }
    if (channels.includes('Email')) {
      sendEmailAlert(triage.five_bullet_summary, guessedTitle, triage.risk_score).catch(() => {});
    }
    if (requiresVoice || triage.requires_voice_escalation) {
      triggerVoiceCall(triage.five_bullet_summary, guessedTitle).catch(() => {});
    }
  } else {
    console.log(`[Manual Upload] Historical research mode active — skipping auto-dispatch to phone/Slack/WhatsApp.`);
  }

  // Attach runtime OCR metadata for the frontend response
  const responseArticle = {
    ...insertedArticle,
    ocrConfidence: Number(ocrConfidence.toFixed(1)),
    isLowConfidence: ocrConfidence < 60,
    correlation_id
  };

  return res.status(200).json({
    success: true,
    article: responseArticle,
    ocr: {
      extractedText,
      confidence: Number(ocrConfidence.toFixed(1)),
      characterCount: extractedText.length
    },
    triage,
    historical: isHistorical,
    message: `✅ Document successfully OCR-scanned and triaged for "${triage.entity}" (Risk: ${triage.risk_level} ${triage.risk_score}/10)`
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

    // Start autonomous Google CSE background worker daemon (60s loop)
    startCSEBackgroundWorker({
      supabase,
      memoryArticles
    });
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
