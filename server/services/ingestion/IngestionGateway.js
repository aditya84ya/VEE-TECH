import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Deduplicator } from './Deduplicator.js';
import { AiTriageQueue } from './AiTriageQueue.js';
import { GuardianAdapter } from './providers/GuardianAdapter.js';
import { GoogleRssAdapter } from './providers/GoogleRssAdapter.js';
import { InstitutionalRssAdapter } from './providers/InstitutionalRssAdapter.js';
import { NewsDataAdapter } from './providers/NewsDataAdapter.js';
import { NewsApiAdapter } from './providers/NewsApiAdapter.js';
import { CurrentsAdapter } from './providers/CurrentsAdapter.js';
import { GNewsAdapter } from './providers/GNewsAdapter.js';
import { EventRegistryAdapter } from './providers/EventRegistryAdapter.js';
import { BlueskyJetstreamAdapter } from './providers/BlueskyJetstreamAdapter.js';
import { BseAnnouncementsAdapter } from './providers/BseAnnouncementsAdapter.js';
import { NewsSitemapAdapter } from './providers/NewsSitemapAdapter.js';
import { GDELTAdapter } from './providers/GDELTAdapter.js';
import { GoogleSearchFeedAdapter } from './providers/GoogleSearchFeedAdapter.js';
import { EpaperOcrAdapter } from './providers/EpaperOcrAdapter.js';
import { validateEntityContext } from '../mediaMetrics.js';
import { logTraceEvent, STAGES } from './TraceLogger.js';
import { evaluateThreatSeverity } from '../threatScorer.js';
import { validatePostContext } from '../contentValidator.js';

const TARGET_ENTITY_REGEX = /\b(Infosys|TCS|Tata Consultancy Services|Wipro|Accenture|Finacle)\b/i;

function detectEntity(title = '', content = '') {
  const text = `${title} ${content}`.toLowerCase();
  if (text.includes('accenture')) return 'Accenture';
  if (text.includes('tcs') || text.includes('tata consultancy')) return 'TCS';
  if (text.includes('wipro')) return 'Wipro';
  return 'Infosys';
}

export class IngestionGateway {
  constructor(options = {}) {
    this.supabase = options.supabase || null;
    this.onArticleCommitted = options.onArticleCommitted || null;
    this.onArticleUpdated = options.onArticleUpdated || null;
    this.cursorFilePath = options.cursorFilePath || path.join(process.cwd(), '.ingestion_cursors.json');

    this.deduplicator = new Deduplicator();
    this.aiTriageQueue = new AiTriageQueue({
      supabase: this.supabase,
      ollamaBaseUrl: options.ollamaBaseUrl,
      ollamaModel: options.ollamaModel,
      alertRulesEvaluator: options.alertRulesEvaluator,
      notifiers: options.notifiers,
      onArticleUpdated: (updated) => {
        const memIdx = this.memoryArticles.findIndex((a) => a.id === updated.id);
        if (memIdx !== -1) {
          this.memoryArticles[memIdx] = { ...this.memoryArticles[memIdx], ...updated };
        }
        if (this.onArticleUpdated) this.onArticleUpdated(updated);
      }
    });

    // Initialize multi-provider pool (including real-time streaming)
    const epaperOcrAdapter = new EpaperOcrAdapter();
    const blueskyAdapter = new BlueskyJetstreamAdapter({ ocrAdapter: epaperOcrAdapter });

    this.adapters = [
      blueskyAdapter,
      new BseAnnouncementsAdapter(),
      new GuardianAdapter(),
      new GoogleRssAdapter(),
      new InstitutionalRssAdapter(),
      new NewsSitemapAdapter(),
      new NewsDataAdapter(),
      new NewsApiAdapter(),
      new CurrentsAdapter(),
      new GNewsAdapter(),
      new EventRegistryAdapter(),
      new GDELTAdapter(),
      new GoogleSearchFeedAdapter(),
      epaperOcrAdapter
    ];

    this.maxArticleAgeHours = options.maxArticleAgeHours || 12;

    this.stats = {
      received: 0,
      committed: 0,
      droppedDuplicates: 0,
      droppedIrrelevant: 0,
      droppedStale: 0,
      fastPathLatencies: [],
      avgFastPathLatencyMs: 0
    };

    this.memoryArticles = []; // Latest articles in memory with full contract
    this.isRunning = false;
  }

  /** Returns the EpaperOcrAdapter instance for on-demand image ingestion */
  getEpaperOcrAdapter() {
    return this.adapters.find(a => a.providerName === 'epaper_ocr') || null;
  }

  /**
   * Load cursors from disk and initialize adapters
   */
  loadCursors() {
    try {
      if (fs.existsSync(this.cursorFilePath)) {
        const raw = fs.readFileSync(this.cursorFilePath, 'utf8');
        const cursors = JSON.parse(raw);
        for (const adapter of this.adapters) {
          if (cursors[adapter.providerName]) {
            adapter.saveCursor(cursors[adapter.providerName]);
          }
        }
        console.log(`[IngestionGateway] 📑 Loaded cursors for ${Object.keys(cursors).length} providers from disk.`);
      }
    } catch (err) {
      console.warn('[IngestionGateway] ⚠️ Failed to load cursors from disk:', err.message);
    }
  }

  /**
   * Persist provider cursors to disk
   */
  saveCursors() {
    try {
      const cursors = {};
      for (const adapter of this.adapters) {
        const c = adapter.getCursor();
        if (c) cursors[adapter.providerName] = c;
      }
      fs.writeFileSync(this.cursorFilePath, JSON.stringify(cursors, null, 2), 'utf8');
    } catch (err) {
      console.warn('[IngestionGateway] ⚠️ Failed to save cursors to disk:', err.message);
    }
  }

  /**
   * Starts the ingestion engine and all provider adapters in parallel
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('[IngestionGateway] ⚡ Starting Low-Latency Real-Time News Ingestion Engine...');

    // 1. Hydrate Deduplicator from Supabase
    if (this.supabase) {
      try {
        const { data: recentArticles } = await this.supabase
          .from('articles')
          .select('id, url, title, source_name, api_source')
          .order('ingested_at', { ascending: false })
          .limit(1000);

        if (recentArticles && recentArticles.length > 0) {
          this.deduplicator.hydrateFromRecords(recentArticles);
        }
      } catch (err) {
        console.warn('[IngestionGateway] ⚠️ Could not hydrate dedup records from DB:', err.message);
      }
    }

    // 2. Load stored watermarks/cursors
    this.loadCursors();

    // 3. Attach fast-path listener to all adapters, then stagger startup by priority group.
    //
    // WHY: Starting all 10 adapters simultaneously creates a TCP/DNS connection storm
    // that competes with Ollama warmup in the same ~500ms window. Evidence: ALL providers
    // (including unrelated hosts) timeout in the same cycle at startup — classic local
    // resource contention, not remote server failure.
    //
    // Startup groups:
    //   Group A (t+0ms):   P0 WebSocket streams (Bluesky) — no HTTP cost, must connect first
    //   Group B (t+2000ms): P1-P2 REST API providers — start after Ollama warmup settles
    //   Group C (t+5000ms): P3 RSS adapters (Google RSS, Institutional) — heaviest HTTP burst, last

    for (const adapter of this.adapters) {
      adapter.on('article', (normalized) => {
        this.handleIncomingArticle(normalized);
      });
    }

    const groupA = this.adapters.filter(a => a.fetchMode === 'STREAM');
    const groupB = this.adapters.filter(a => a.fetchMode !== 'STREAM' && a.fetchMode !== 'RSS');
    const groupC = this.adapters.filter(a => a.fetchMode === 'RSS');

    // Group A: Start streams immediately (WebSocket, zero HTTP socket connection cost)
    for (const adapter of groupA) {
      adapter.start().catch(err =>
        console.warn(`[IngestionGateway] ⚠️ Failed to start adapter ${adapter.providerName}:`, err.message)
      );
    }
    console.log(`[IngestionGateway] ▶ Group A started: ${groupA.map(a => a.providerName).join(', ') || 'none'}`);

    // Group B: REST API providers — start 3s later, staggered 400ms apart to prevent TCP socket burst
    setTimeout(() => {
      groupB.forEach((adapter, idx) => {
        setTimeout(() => {
          adapter.start().catch(err =>
            console.warn(`[IngestionGateway] ⚠️ Failed to start adapter ${adapter.providerName}:`, err.message)
          );
        }, idx * 400);
      });
      console.log(`[IngestionGateway] ▶ Group B started (staggered): ${groupB.map(a => a.providerName).join(', ')}`);
    }, 3000);

    // Group C: RSS adapters — staggered cleanly: Google News RSS at 8s, Institutional RSS at 12s
    setTimeout(() => {
      const googleAdapter = groupC.find(a => a.providerName === 'googlenews');
      if (googleAdapter) {
        googleAdapter.start().catch(err =>
          console.warn(`[IngestionGateway] ⚠️ Failed to start adapter ${googleAdapter.providerName}:`, err.message)
        );
        console.log(`[IngestionGateway] ▶ Group C1 started: googlenews`);
      }
    }, 8000);

    setTimeout(() => {
      const instAdapter = groupC.find(a => a.providerName === 'institutional');
      if (instAdapter) {
        instAdapter.start().catch(err =>
          console.warn(`[IngestionGateway] ⚠️ Failed to start adapter ${instAdapter.providerName}:`, err.message)
        );
        console.log(`[IngestionGateway] ▶ Group C2 started: institutional`);
      }
    }, 12000);

    // Group C3: E-Paper OCR adapter -- starts last (Tesseract init is CPU heavy)
    setTimeout(() => {
      const epaperAdapter = groupC.find(a => a.providerName === 'epaper_ocr');
      if (epaperAdapter) {
        epaperAdapter.start().catch(err =>
          console.warn(`[IngestionGateway] ⚠️ Failed to start adapter ${epaperAdapter.providerName}:`, err.message)
        );
        console.log(`[IngestionGateway] ▶ Group C3 started: epaper_ocr`);
      }
    }, 16000);

    // Periodically save cursors
    this._cursorInterval = setInterval(() => {
      this.saveCursors();
    }, 60000);
    if (this._cursorInterval?.unref) {
      this._cursorInterval.unref();
    }

    console.log(`[IngestionGateway] 🚀 Ingestion Gateway active with ${this.adapters.length} parallel providers.`);
  }

  /**
   * Stops the ingestion gateway and all providers
   */
  async stop() {
    this.isRunning = false;
    if (this._cursorInterval) {
      clearInterval(this._cursorInterval);
    }
    this.saveCursors();

    await Promise.allSettled(this.adapters.map(a => a.stop()));
    console.log('[IngestionGateway] 🛑 Ingestion Gateway stopped.');
  }

  /**
   * FAST-PATH INGESTION PIPELINE (<100ms)
   * Receive -> Validate -> Independent Raw DB Commit -> Dedup & Story Clustering -> Async AI Queue
   */
  async handleIncomingArticle(normalized) {
    const fastStart = Date.now();
    const traceId = normalized.traceId || `tr_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const receivedAt = normalized.receivedAt || new Date().toISOString();
    this.stats.received++;

    const title = normalized.title || '';
    const content = normalized.content || normalized.description || title;

    logTraceEvent({
      stage: STAGES.NORMALIZED,
      traceId,
      provider: normalized.provider,
      extra: { title: title.slice(0, 60), url: normalized.url }
    });

    // Guardrail: Target Entity Relevance & Disambiguation Pre-Filter
    if (!TARGET_ENTITY_REGEX.test(title) && !TARGET_ENTITY_REGEX.test(content)) {
      this.stats.droppedIrrelevant++;
      return;
    }

    const entity = detectEntity(title, content);
    if (!validateEntityContext(`${title} ${content}`, entity)) {
      this.stats.droppedIrrelevant++;
      return;
    }

    // Guardrail: Two-Stage Pre-Publish AI & Context Validation (Lifestyle, Sports, Out-of-Context Filter)
    const caption = title || normalized.description || '';
    const hasImage = Boolean(normalized.image || normalized.mediaUrl);
    const ocrText = normalized.provider === 'epaper_ocr' ? (normalized.content || '') : (normalized.ocrText || '');
    const validation = await validatePostContext(caption, ocrText, entity, hasImage);
    if (!validation.isValid) {
      this.stats.droppedIrrelevant++;
      console.log(`[ContentValidator] 🚫 DROPPED FALSE POSITIVE [${entity}]: ${validation.reason} ("${title.slice(0, 60)}")`);
      logTraceEvent({
        stage: STAGES.VALIDATED,
        traceId,
        provider: normalized.provider,
        extra: { droppedFalsePositive: true, reason: validation.reason, entity }
      });
      return; // Stop here! Do not save to database, do not show on UI.
    }

    // Provider display name mapping
    const providerDisplayNames = {
      bluesky: 'Bluesky Jetstream Firehose (Realtime Stream)',
      guardian: 'The Guardian Content API',
      googlenews: 'Google News RSS',
      institutional: 'Institutional Publisher Wires (ET, Mint, BS)',
      newsdata: 'NewsData.io Real-Time Archive',
      newsapi: 'NewsAPI',
      currents: 'Currents Global News API',
      gnews: 'GNews AI-Curated Wire',
      eventregistry: 'Event Registry (Minute Stream)',
      gdelt: 'GDELT 2.0 Global Event Wire',
      epaper_ocr: 'E-Paper / Image OCR'
    };

    // Guardrail: Recency Cutoff Window
    // Push streams enforce strict 12h; Syndicated RSS/Aggregators allow 48h to prevent dropping syndicated news
    const isSyndicated = normalized.provider === 'institutional' || normalized.provider === 'googlenews' || normalized.provider === 'newsdata';
    const effectiveMaxAgeHours = isSyndicated ? Math.max(this.maxArticleAgeHours, 48) : this.maxArticleAgeHours;
    const publishedAt = normalized.publishedAt || new Date().toISOString();
    const pubTime = new Date(publishedAt).getTime();
    if (!isNaN(pubTime)) {
      const ageHours = (Date.now() - pubTime) / (3600 * 1000);
      if (ageHours > effectiveMaxAgeHours) {
        this.stats.droppedStale++;
        const ageDesc = ageHours >= 48 ? `${(ageHours / 24).toFixed(1)} days` : `${ageHours.toFixed(1)} hours`;
        console.log(`[Guardrail] 🚫 DROPPED STALE: "${title.slice(0, 50)}..." (published ${ageDesc} ago exceeds ${effectiveMaxAgeHours}h window)`);
        return; // DROP IMMEDIATELY BEFORE DEDUP OR DB INSERT
      }
    }

    logTraceEvent({
      stage: STAGES.VALIDATED,
      traceId,
      provider: normalized.provider,
      extra: { entity, publishedAt }
    });

    const pubName = normalized.publisher || 'Verified News Wire';
    const apiSource = providerDisplayNames[normalized.provider] || normalized.provider;
    const articleUrl = normalized.url || normalized.canonicalUrl;
    const candidateId = randomUUID();

    // =========================================================================
    // 1. DEDUPLICATION CHECK (MUST RUN BEFORE ANY DATABASE WRITE)
    // =========================================================================
    const dedup = this.deduplicator.evaluate({
      articleId: candidateId,
      providerArticleId: normalized.providerArticleId,
      url: normalized.url || articleUrl,
      sourceUrl: normalized.sourceUrl,
      publisherUrl: normalized.publisherUrl,
      canonicalUrl: normalized.canonicalUrl || articleUrl,
      title: title,
      publisher: pubName,
      source_name: pubName,
      provider: apiSource
    });

    if (dedup.isDuplicate) {
      this.stats.droppedDuplicates++;
      logTraceEvent({
        stage: STAGES.DEDUP_REJECTED,
        traceId,
        provider: normalized.provider,
        reason: `${dedup.dedupLayer}: ${dedup.dedupReason}`
      });
      console.log(`[Deduplicator] 🚫 DROPPED DUPLICATE [${dedup.dedupLayer}]: "${title.slice(0, 50)}..." (${dedup.dedupReason})`);
      return; // DROP IMMEDIATELY — NOTHING REACHES THE DATABASE
    }

    logTraceEvent({
      stage: STAGES.DEDUP_ACCEPTED,
      traceId,
      provider: normalized.provider,
      extra: { storyClusterId: dedup.storyClusterId }
    });

    // =========================================================================
    // 2. TIMESTAMPS & PAYLOAD PREPARATION (ONLY FOR UNIQUE ARTICLES)
    // =========================================================================
    const nowIso = new Date().toISOString();
    const isTimestampAnomaly = new Date(receivedAt).getTime() < new Date(publishedAt).getTime();

    // Initial Raw Article Payload (evaluated through threat severity scorer)
    const threat = evaluateThreatSeverity(title, content, entity);
    const isThreatCritical = threat.risk_level === 'Critical';

    const computedRiskScore = threat.score ?? threat.risk_score ?? normalized.risk_score ?? 5.0;

    const articlePayload = {
      id: candidateId,
      api_source: apiSource,
      source_name: pubName,
      title: title,
      url: articleUrl,
      image_url: normalized.image || null,
      raw_content: content,
      entity_mentioned: entity,
      sentiment: isThreatCritical ? 'Negative' : (threat.risk_level === 'High' ? 'Negative' : 'Neutral'),
      risk_score: computedRiskScore,
      risk_level: threat.risk_level,
      five_bullet_summary: [
        `Fast-path raw commit from ${pubName}`,
        `Threat assessment: ${threat.severity} (${computedRiskScore}/10.0)${threat.matchedKeyword ? ` - Triggered by: "${threat.matchedKeyword}"` : ''}`,
        `Published: ${publishedAt}`,
        `Awaiting deep AI triage in background queue...`
      ],
      status: 'ACTIVE',
      published_at: publishedAt,
      ingested_at: nowIso,
      theme: isThreatCritical ? 'Regulatory & Crisis Intelligence' : (isTimestampAnomaly ? 'TIMESTAMP_ANOMALY' : 'Enterprise Intelligence'),
      triaged_at: null,    // populated by AiTriageQueue once triage completes
      dispatched_at: null  // populated only if an alert is dispatched
    };

    // Calculate latency metrics
    const recTime = new Date(receivedAt).getTime();
    const detectionLagSec = Math.max(0, Math.round((recTime - pubTime) / 1000));

    // =========================================================================
    // 3. FAST PERSISTENCE: Save unique article to Supabase (<100ms)
    // =========================================================================
    logTraceEvent({
      stage: STAGES.DB_INSERT_START,
      traceId,
      articleId: candidateId,
      provider: normalized.provider
    });

    let committedRecord = articlePayload;
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from('articles')
          .insert(articlePayload)
          .select()
          .single();

        if (error) {
          logTraceEvent({
            stage: STAGES.DB_INSERT_ERROR,
            traceId,
            articleId: candidateId,
            provider: normalized.provider,
            reason: error.message
          });
          console.error(`[IngestionGateway] ❌ Fast-path DB insert error: ${error.message}`);
        } else if (data) {
          committedRecord = data;
        }
      } catch (dbErr) {
        logTraceEvent({
          stage: STAGES.DB_INSERT_ERROR,
          traceId,
          articleId: candidateId,
          provider: normalized.provider,
          reason: dbErr.message
        });
        console.error(`[IngestionGateway] ❌ Supabase communication failure: ${dbErr.message}`);
      }
    }

    const fastDuration = Date.now() - fastStart;
    this._recordFastPathLatency(fastDuration);
    this.stats.committed++;

    logTraceEvent({
      stage: STAGES.DB_INSERT_SUCCESS,
      traceId,
      articleId: committedRecord.id,
      provider: normalized.provider,
      durationMs: fastDuration
    });

    console.log(`[IngestionGateway] ⚡ FAST-PATH RAW COMMITTED: ID ${committedRecord.id} | Source: "${committedRecord.api_source}" | Lag: ${detectionLagSec}s | Fast-Path Time: ${fastDuration}ms`);

    // =========================================================================
    // 4. MEMORY CACHE, REALTIME BROADCAST & ASYNC AI QUEUE
    // =========================================================================
    const enrichedRecord = {
      ...committedRecord,
      severity: threat.severity,
      score: computedRiskScore,
      traceId,
      storyClusterId: dedup.storyClusterId,
      sourceCount: dedup.sourceCount,
      uniquePublisherCount: dedup.uniquePublisherCount,
      uniqueProviderCount: dedup.uniqueProviderCount,
      duplicateStatus: 'UNIQUE',
      status: 'AI_PENDING'
    };

    // Update in memory articles cache
    this.memoryArticles.unshift(enrichedRecord);
    if (this.memoryArticles.length > 500) this.memoryArticles.pop();

    // Broadcast Realtime Event
    logTraceEvent({
      stage: STAGES.REALTIME_BROADCAST,
      traceId,
      articleId: committedRecord.id,
      provider: normalized.provider
    });

    if (this.onArticleCommitted) {
      try {
        this.onArticleCommitted(enrichedRecord);
      } catch (broadcastErr) {
        console.warn('[IngestionGateway] ⚠️ Broadcast callback notice:', broadcastErr.message);
      }
    }

    // Enqueue for Asynchronous Background AI Triage
    logTraceEvent({
      stage: STAGES.AI_QUEUE,
      traceId,
      articleId: committedRecord.id,
      provider: normalized.provider
    });

    this.aiTriageQueue.enqueue(enrichedRecord);
  }

  _recordFastPathLatency(ms) {
    this.stats.fastPathLatencies.push(ms);
    if (this.stats.fastPathLatencies.length > 50) this.stats.fastPathLatencies.shift();
    const sum = this.stats.fastPathLatencies.reduce((a, b) => a + b, 0);
    this.stats.avgFastPathLatencyMs = Math.round(sum / this.stats.fastPathLatencies.length);
  }

  /**
   * Triggers an on-demand manual fetch across all eligible providers (e.g. for /api/fetch-live)
   * Respects each provider's canFetch() and cooldownUntil.
   */
  async triggerManualFetch() {
    console.log('[IngestionGateway] ⚡ Triggering manual fetch across all eligible providers...');
    const results = [];
    for (const adapter of this.adapters) {
      try {
        if (adapter.fetchMode === 'STREAM') {
          // Streaming firehose: ensure connected, does not poll REST endpoint
          if (typeof adapter.pollNow === 'function') await adapter.pollNow();
          results.push({
            provider: adapter.providerName,
            status: adapter.metrics.status || 'CONNECTED',
            mode: 'STREAM',
            message: 'Continuous WebSocket firehose active (streaming push)'
          });
          continue;
        }
        const items = await adapter.pollNow();
        results.push({ provider: adapter.providerName, count: items?.length || 0 });
      } catch (err) {
        results.push({ provider: adapter.providerName, error: err.message });
      }
    }
    return results;
  }

  /**
   * Detailed diagnostics matching Phase 12 specification
   */
  getDetailedDiagnostics() {
    const providersMap = {};
    let activeProviderCount = 0;
    let healthyProviderCount = 0;
    let cooldownProviderCount = 0;
    let quotaExhaustedProviderCount = 0;
    let lastSuccessfulArticleAt = null;
    let lastSuccessfulProvider = null;

    for (const adapter of this.adapters) {
      const health = adapter.getHealth();
      providersMap[adapter.providerName] = health;

      if (health.status === 'ACTIVE' || health.status === 'POLLING' || health.status === 'CONNECTED') {
        activeProviderCount++;
        healthyProviderCount++;
      } else if (health.status === 'COOLDOWN') {
        cooldownProviderCount++;
      } else if (health.status === 'QUOTA_EXHAUSTED') {
        quotaExhaustedProviderCount++;
      }

      if (health.lastArticleAt) {
        if (!lastSuccessfulArticleAt || new Date(health.lastArticleAt) > new Date(lastSuccessfulArticleAt)) {
          lastSuccessfulArticleAt = health.lastArticleAt;
          lastSuccessfulProvider = adapter.providerName;
        }
      }
    }

    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;
    const fifteenMinAgo = now - 15 * 60 * 1000;

    const totalArticlesLast5Minutes = this.memoryArticles.filter(a => {
      const t = new Date(a.ingested_at || a.created_at).getTime();
      return !isNaN(t) && t >= fiveMinAgo;
    }).length;

    const totalArticlesLast15Minutes = this.memoryArticles.filter(a => {
      const t = new Date(a.ingested_at || a.created_at).getTime();
      return !isNaN(t) && t >= fifteenMinAgo;
    }).length;

    return {
      providers: providersMap,
      activeProviderCount,
      healthyProviderCount,
      cooldownProviderCount,
      quotaExhaustedProviderCount,
      lastSuccessfulArticleAt,
      lastSuccessfulProvider,
      totalArticlesLast5Minutes,
      totalArticlesLast15Minutes
    };
  }

  /**
   * Health summary across all providers and gateway pipelines
   */
  getHealthSummary() {
    return {
      status: this.isRunning ? 'OPERATIONAL' : 'STOPPED',
      uptimeSec: Math.round(process.uptime()),
      gatewayStats: {
        totalReceived: this.stats.received,
        totalCommitted: this.stats.committed,
        totalDroppedDuplicates: this.stats.droppedDuplicates,
        totalDroppedIrrelevant: this.stats.droppedIrrelevant,
        avgFastPathLatencyMs: this.stats.avgFastPathLatencyMs,
        activeStoryClusters: this.deduplicator.storyClusters.size
      },
      aiTriageQueueStats: this.aiTriageQueue.getStatus(),
      providers: this.adapters.map(a => a.getHealth())
    };
  }
}
