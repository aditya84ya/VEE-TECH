import axios from 'axios';
import EventEmitter from 'node:events';
import { logTraceEvent, STAGES } from './TraceLogger.js';
import { processAutonomousMedia } from '../AutonomousMediaService.js';
import { evaluateThreatSeverity, matchCriticalKeyword } from '../threatScorer.js';

/**
 * Asynchronous Priority AI Triage Worker Queue
 *
 * Processes Ollama inference in the background without blocking fast-path ingestion.
 * Orders processing by priority (P0 Crisis -> P1 Client -> P2 Competitor -> P3/P4),
 * updates Supabase records in-place, and dispatches multi-channel alerts.
 */
export class AiTriageQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.supabase = options.supabase;
    this.ollamaBaseUrl = options.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.ollamaModel = options.ollamaModel || process.env.OLLAMA_MODEL || 'qwen2.5:7b';
    this.alertRulesEvaluator = options.alertRulesEvaluator;
    this.notifiers = options.notifiers || {};
    this.onArticleUpdated = options.onArticleUpdated || null;

    this.queue = [];
    this.isProcessing = false;
    this.activeWorkers = 0;
    this.maxConcurrency = options.maxConcurrency || 1; // 1 concurrent Ollama call to protect local VRAM

    this.stats = {
      enqueued: 0,
      processed: 0,
      failed: 0,
      avgTriageMs: 0,
      p95TriageMs: 0
    };
    this._triageLatencies = [];
  }

  /**
   * Determine processing priority for an article:
   * P0: Existential crisis targeting Infosys
   * P1: High-risk client operational event
   * P2: Competitor intelligence (TCS, Wipro, Accenture)
   * P3: Normal enterprise intelligence
   * P4: Background news
   */
  determinePriority(article) {
    const text = `${article.title || ''} ${article.raw_content || ''}`.toLowerCase();
    const entity = (article.entity_mentioned || '').toLowerCase();
    const isClient = entity.includes('infosys') || text.includes('infosys');

    if (isClient) {
      if (/rbi|sebi|audit notice|fraud|subpoena|probe|penalty|enforcement action|sec probe/.test(text)) {
        return 0; // P0: Critical Crisis
      }
      if (/outage|blackout|lawsuit|downgrade|contract loss|ransomware|security breach/.test(text)) {
        return 1; // P1: High-Risk Client Event
      }
      return 3; // P3: Normal Client Intelligence
    }

    if (/tcs|tata consultancy|wipro|accenture/.test(text)) {
      return 2; // P2: Competitor Event
    }

    return 4; // P4: Background News
  }

  /**
   * Enqueue a persisted article for background AI enrichment
   */
  enqueue(articlePayload) {
    const priority = this.determinePriority(articlePayload);
    const job = {
      jobId: `job_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      article: articlePayload,
      priority,
      enqueuedAt: Date.now()
    };

    this.queue.push(job);
    // Sort queue by priority ascending (P0 first, then P1, P2, P3, P4)
    this.queue.sort((a, b) => a.priority - b.priority);

    this.stats.enqueued++;
    this._scheduleNext();
  }

  _scheduleNext() {
    if (this.activeWorkers >= this.maxConcurrency || this.queue.length === 0) return;
    this.activeWorkers++;
    this._processNext().finally(() => {
      this.activeWorkers--;
      this._scheduleNext();
    });
  }

  async _processNext() {
    if (this.queue.length === 0) return;
    const job = this.queue.shift();
    const { article, priority, enqueuedAt } = job;
    const startTime = Date.now();
    const queueWaitMs = startTime - enqueuedAt;

    try {
      console.log(`[AiTriageQueue] 🧠 [P${priority}] Processing AI triage for: "${article.title?.slice(0, 50)}..." (waited ${queueWaitMs}ms)`);
      logTraceEvent({
        stage: STAGES.AI_STARTED,
        traceId: article.traceId,
        articleId: article.id,
        provider: article.api_source,
        extra: { priority, waitMs: queueWaitMs }
      });

      // Autonomous media interception & extraction (PDF filings, sitemap images, crowd screenshots)
      if (article.mediaUrl || article.pdfUrl || article.image_url || article.image) {
        try {
          await processAutonomousMedia(article);
        } catch (_) {}
      }

      const triage = await this._executeOllamaTriage(article.raw_content, article.title, article.source_name);

      const triagedAt = new Date().toISOString();
      const triageDurationMs = Date.now() - startTime;
      this._recordTriageLatency(triageDurationMs);

      logTraceEvent({
        stage: STAGES.AI_COMPLETED,
        traceId: article.traceId,
        articleId: article.id,
        provider: article.api_source,
        durationMs: triageDurationMs,
        extra: { risk_level: triage.risk_level, risk_score: triage.risk_score }
      });

      // Evaluate alert rules
      const alertEval = this.alertRulesEvaluator ? this.alertRulesEvaluator(triage) : { channels: [], requiresVoice: false };
      let dispatchedAt = null;

      if (alertEval.channels.length > 0 || alertEval.requiresVoice) {
        dispatchedAt = new Date().toISOString();
        this._dispatchAlerts(alertEval, triage, article);
      }

      // In-place database update: transition to 'ACTIVE'
      const updatedFields = {
        entity_mentioned: triage.entity,
        sentiment: triage.sentiment,
        risk_score: triage.risk_score,
        risk_level: triage.risk_level,
        five_bullet_summary: triage.five_bullet_summary,
        theme: triage.theme || 'Enterprise Intelligence',
        status: 'ACTIVE',
        triaged_at: triagedAt,
        dispatched_at: dispatchedAt
      };

      if (this.supabase) {
        const MAX_RETRIES = 3;
        let lastDbError = null;
        let saved = false;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const { error } = await this.supabase
              .from('articles')
              .update(updatedFields)
              .eq('id', article.id);

            if (error) {
              lastDbError = error;
              // Log full error object on first occurrence so we see the real Supabase/network cause
              if (attempt === 1) {
                console.warn(`[AiTriageQueue] ⚠️ DB update error for ${article.id} (attempt ${attempt}/${MAX_RETRIES}):`, error);
              }
              if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000)); // 1s, 2s, 4s
              }
            } else {
              saved = true;
              console.log(`[AiTriageQueue] ✅ AI Enriched: ID ${article.id} -> ${triage.risk_level} (${triage.risk_score}/10) in ${triageDurationMs}ms`);
              break;
            }
          } catch (fetchErr) {
            lastDbError = fetchErr;
            console.warn(`[AiTriageQueue] ⚠️ DB update network error for ${article.id} (attempt ${attempt}/${MAX_RETRIES}):`, fetchErr.message, fetchErr.cause || '');
            if (attempt < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
            }
          }
        }

        if (!saved) {
          console.error(`[AiTriageQueue] ❌ DB update permanently failed for ${article.id} after ${MAX_RETRIES} attempts. Last error:`, lastDbError);
        }
      }

      const fullyEnriched = { ...article, ...updatedFields };

      if (this.onArticleUpdated) {
        try {
          this.onArticleUpdated(fullyEnriched);
        } catch (_) {}
      }

      this.emit('articleUpdated', fullyEnriched);
      this.stats.processed++;
    } catch (err) {
      this.stats.failed++;
      console.warn(`[AiTriageQueue] ⚠️ AI triage failed for ${article.id} (${err.message}). Article remains persisted.`);
    }
  }

  _recordTriageLatency(ms) {
    this._triageLatencies.push(ms);
    if (this._triageLatencies.length > 50) this._triageLatencies.shift();
    const sum = this._triageLatencies.reduce((a, b) => a + b, 0);
    this.stats.avgTriageMs = Math.round(sum / this._triageLatencies.length);

    const sorted = [...this._triageLatencies].sort((a, b) => a - b);
    const p95Idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    this.stats.p95TriageMs = sorted[p95Idx] || ms;
  }

  async _executeOllamaTriage(rawContent, title = '', sourceName = '') {
    const prompt = [
      'You are the Vee-Alert crisis intelligence triage agent for enterprise primary client Infosys.',
      'TARGET CLIENT: Infosys.',
      'COMPETITORS: TCS, Wipro, Accenture.',
      '',
      'STRICT CLASSIFICATION RULES:',
      '1. "Critical" (and requires_voice_escalation: true) is EXCLUSIVELY RESERVED for Infosys facing existential threats (e.g., regulatory bans, SEBI/RBI probes, catastrophic security breaches, C-suite legal action).',
      '2. Competitor news (TCS, Wipro, Accenture) must NEVER be classified as "Critical", and requires_voice_escalation must ALWAYS be false. Competitor news is strategic market intelligence (Low, Medium, or at most High 7.5 max).',
      '3. Routine business developments (product launches, custom chip design, automotive semiconductor services, sponsorships, partnerships, expansion news, hiring, quarterly commentary) are LOW or MEDIUM risk (score 1.0 - 5.0), NOT regulatory crises.',
      '4. Factuality check: Differentiate verified facts from speculation/rumors. Speculative articles must be capped at "Medium" risk.',
      '',
      'Analyze the raw news content below and return ONLY a valid JSON object matching this exact schema:',
      '{',
      '  "entity": "Infosys" | "TCS" | "Wipro" | "Accenture",',
      '  "sentiment": "Positive" | "Neutral" | "Negative",',
      '  "theme": "Regulatory & Legal" | "Executive & Board" | "Financial & Results" | "Security & Breach" | "Market Performance" | "Strategy & Expansion" | "Client & Delivery",',
      '  "risk_score": <float 1.0 to 10.0>,',
      '  "risk_level": "Low" | "Medium" | "High" | "Critical",',
      '  "requires_voice_escalation": <boolean>,',
      '  "five_bullet_summary": [',
      '    "What happened: [1 clear sentence]",',
      '    "Why it matters: [1 clear sentence explaining direct business impact]",',
      '    "Risk score rationale: [1 sentence justifying the assigned risk level]",',
      '    "Competitor impact: [1 sentence on what this means for other IT firms]",',
      '    "Recommended action: [1 concrete immediate response for leadership]"',
      '  ]',
      '}',
      '',
      `Source: ${sourceName}`,
      `Headline: ${title}`,
      `Content: ${rawContent.slice(0, 1800)}`
    ].join('\n');

    try {
      const resp = await axios.post(
        `${this.ollamaBaseUrl}/api/generate`,
        {
          model: this.ollamaModel,
          prompt,
          format: 'json',
          stream: false,
          options: { temperature: 0.1, num_predict: 512 }
        },
        { timeout: 35000 }
      );

      const parsed = JSON.parse(resp.data.response);
      return this._normalizeTriage(parsed);
    } catch (err) {
      // High-accuracy deterministic heuristic fallback if Ollama times out or errors
      return this._deterministicFallback(rawContent, title);
    }
  }

  _normalizeTriage(triage) {
    if (!triage) return this._deterministicFallback();
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

  _deterministicFallback(content = '', title = '') {
    const text = `${title} ${content}`.toLowerCase();
    let entity = 'Infosys';
    if (text.includes('accenture')) entity = 'Accenture';
    else if (text.includes('tcs') || text.includes('tata consultancy')) entity = 'TCS';
    else if (text.includes('wipro')) entity = 'Wipro';

    const threat = evaluateThreatSeverity(title, content, entity);

    return {
      entity,
      sentiment: threat.risk_level === 'Critical' ? 'Negative' : 'Neutral',
      theme: threat.risk_level === 'Critical' ? 'Regulatory & Legal Crisis' : 'Market Intelligence',
      risk_score: threat.score,
      risk_level: threat.risk_level,
      severity: threat.severity,
      score: threat.score,
      requires_voice_escalation: threat.risk_level === 'Critical' && entity === 'Infosys',
      five_bullet_summary: [
        `What happened: ${threat.risk_level === 'Critical' ? 'CRITICAL DISTRESS EVENT: ' : ''}Telemetry captured report regarding ${entity}.`,
        `Threat assessment: ${threat.severity} (${threat.score}/10.0)${threat.matchedKeyword ? ` - Triggered by: "${threat.matchedKeyword}"` : ''}`,
        'Why it matters: Event recorded into central intelligence memory for tactical tracking.',
        'Competitor impact: Market positioning under immediate watch.',
        'Recommended action: Maintain regular intelligence surveillance and escalate if necessary.'
      ]
    };
  }

  _dispatchAlerts(alertEval, triage, article) {
    try {
      if (alertEval.channels.includes('Slack') && this.notifiers.sendSlackAlert) {
        this.notifiers.sendSlackAlert(triage.five_bullet_summary, triage.risk_level, article.title, triage.risk_score);
      }
      if (alertEval.channels.includes('WhatsApp') && this.notifiers.sendWhatsAppAlert) {
        this.notifiers.sendWhatsAppAlert(triage.five_bullet_summary, article.title, triage.risk_score);
      }
      if (alertEval.channels.includes('Email') && this.notifiers.sendEmailAlert) {
        this.notifiers.sendEmailAlert(triage.five_bullet_summary, article.title, triage.risk_score);
      }
      if (alertEval.requiresVoice && this.notifiers.triggerVoiceCall) {
        this.notifiers.triggerVoiceCall(triage.five_bullet_summary, article.title);
      }
    } catch (e) {
      console.warn('[AiTriageQueue] Dispatch notice:', e.message);
    }
  }

  getStatus() {
    return {
      pendingJobs: this.queue.length,
      activeWorkers: this.activeWorkers,
      isProcessing: this.activeWorkers > 0,
      ...this.stats
    };
  }
}
