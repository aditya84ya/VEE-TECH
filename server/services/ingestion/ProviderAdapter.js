import EventEmitter from 'node:events';
import { logTraceEvent, STAGES } from './TraceLogger.js';

export function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const str = String(headerValue).trim();

  // 1. Integer seconds (e.g. "70" or "900")
  const seconds = parseInt(str, 10);
  if (!isNaN(seconds) && /^\d+$/.test(str)) {
    // If epoch timestamp (> 1.7e9):
    if (seconds > 1700000000) {
      const nowSec = Math.floor(Date.now() / 1000);
      return Math.max(seconds - nowSec, 5);
    }
    return Math.max(seconds, 5);
  }

  // 2. HTTP-Date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
  const parsedDate = new Date(str);
  if (!isNaN(parsedDate.getTime())) {
    const diffSec = Math.ceil((parsedDate.getTime() - Date.now()) / 1000);
    return Math.max(diffSec, 5);
  }

  return null;
}

export function getMsUntilUtcMidnight() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 1));
  return nextMidnight.getTime() - now.getTime();
}

/**
 * Base ProviderAdapter class
 *
 * Implements authoritative provider boundary gating, strict skip vs success discrimination,
 * retry-after calculation, and complete diagnostic telemetry.
 */
export class ProviderAdapter extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.providerName Unique identifier (e.g. 'guardian', 'newsdata')
   * @param {string} config.displayName Human-readable name
   * @param {'STREAM' | 'MINUTE_STREAM' | 'POLL' | 'RSS'} config.fetchMode Ingestion pattern
   * @param {number} [config.intervalMs=30000] Polling interval in ms (for POLL/RSS)
   * @param {number} [config.timeoutMs=10000] Request timeout in ms
   * @param {number} [config.priority=2] P0 (Stream), P1 (Minute-stream), P2 (REST), P3 (RSS)
   */
  constructor(config) {
    super();
    this.providerName = config.providerName;
    this.displayName = config.displayName || config.providerName;
    this.fetchMode = config.fetchMode || 'POLL';
    this.intervalMs = config.intervalMs || 30000;
    this.timeoutMs = config.timeoutMs || 10000;
    this.priority = config.priority ?? 2;

    this.isRunning = false;
    this.timer = null;
    this.isFetching = false;
    this.cooldownUntil = 0;

    // Full Health & Diagnostic Telemetry (Phases 11 & 12)
    this.metrics = {
      provider: this.providerName,
      status: 'INITIALIZING', // ACTIVE, COOLDOWN, QUOTA_EXHAUSTED, AUTH_ERROR, UNREACHABLE, DISABLED
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastArticleAt: null,
      lastHttpStatus: null,
      lastError: null,
      lastErrorMessage: null,
      cooldownUntil: null,

      // Core Request & HTTP Counters
      requestAttempts: 0,
      successfulHttpRequests: 0,
      httpErrors: 0,

      // Skip Counters (Must never be reported as fetch success)
      skippedCooldown: 0,
      skippedQuota: 0,
      skippedDisabled: 0,
      skippedNotConfigured: 0,
      skippedCooldownCount: 0, // Legacy compatibility

      // Article Flow Counters
      rawFetched: 0,
      normalized: 0,
      stale: 0,
      duplicates: 0,
      accepted: 0,

      // Compatibility Metrics
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      rateLimitedCount: 0,
      fetchedCount: 0,
      acceptedCount: 0,
      duplicateCount: 0,
      staleCount: 0,
      lastLatencyMs: null,
      averageLatencyMs: 0,
      p95LatencyMs: 0,
      requests: 0,
      reconnectCount: 0,
      eventsPerMinute: 0
    };

    this._latencyHistory = [];
    this._recentEvents = [];

    // Periodic eventsPerMinute calculation
    this._metricsInterval = setInterval(() => {
      const oneMinAgo = Date.now() - 60000;
      this._recentEvents = this._recentEvents.filter(t => t > oneMinAgo);
      this.metrics.eventsPerMinute = this._recentEvents.length;
    }, 15000);
    if (this._metricsInterval?.unref) {
      this._metricsInterval.unref();
    }
  }

  /**
   * Authoritative gate check before ANY fetch attempt
   */
  canFetch() {
    if (!this.isRunning) return { allowed: false, reason: 'NOT_RUNNING' };
    if (this.isFetching) return { allowed: false, reason: 'ALREADY_FETCHING' };
    if (this.metrics.status === 'DISABLED') return { allowed: false, reason: 'DISABLED' };
    if (this.apiKey !== undefined && !this.apiKey && this.fetchMode !== 'RSS') {
      return { allowed: false, reason: 'NOT_CONFIGURED' };
    }
    if (this.metrics.status === 'QUOTA_EXHAUSTED' && Date.now() < this.cooldownUntil) {
      const remainingMs = this.cooldownUntil - Date.now();
      return { allowed: false, reason: 'QUOTA_EXHAUSTED', remainingMs, cooldownUntil: this.cooldownUntil };
    }
    if (Date.now() < this.cooldownUntil) {
      const remainingMs = this.cooldownUntil - Date.now();
      return { allowed: false, reason: 'COOLDOWN_ACTIVE', remainingMs, cooldownUntil: this.cooldownUntil };
    }
    return { allowed: true };
  }

  /**
   * Start provider ingestion
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.metrics.status = this.fetchMode === 'STREAM' ? 'CONNECTING' : 'POLLING';
    console.log(`[ProviderAdapter:${this.providerName}] 🚀 Starting adapter (${this.fetchMode}, priority P${this.priority})`);

    logTraceEvent({
      stage: STAGES.ADAPTER_START,
      provider: this.providerName,
      extra: { fetchMode: this.fetchMode, priority: this.priority }
    });

    try {
      await this.onStart();
    } catch (err) {
      this.recordFailure(err);
    }

    if (this.fetchMode === 'POLL' || this.fetchMode === 'RSS' || this.fetchMode === 'MINUTE_STREAM') {
      this._scheduleNextPoll(100); // Trigger initial fetch quickly
    }
  }

  /**
   * Stop provider ingestion
   */
  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this._metricsInterval) {
      clearInterval(this._metricsInterval);
    }
    await this.onStop();
    this.metrics.status = 'DISABLED';
    console.log(`[ProviderAdapter:${this.providerName}] 🛑 Stopped adapter`);
  }

  /**
   * Single authoritative execution of fetch with strict boundary gating
   */
  async _executeFetch() {
    const traceId = `tr_fetch_${this.providerName}_${Date.now()}`;
    const start = Date.now();

    logTraceEvent({
      stage: STAGES.EXECUTE_FETCH_ENTER,
      traceId,
      provider: this.providerName
    });

    const gate = this.canFetch();

    logTraceEvent({
      stage: STAGES.CAN_FETCH,
      traceId,
      provider: this.providerName,
      status: gate.allowed ? 'ALLOWED' : 'DENIED',
      reason: gate.reason || null,
      extra: gate.remainingMs ? { remainingMs: gate.remainingMs, cooldownUntil: gate.cooldownUntil } : {}
    });

    // Handle skip states explicitly: NEVER report skipped provider as fetch success!
    if (!gate.allowed) {
      if (gate.reason === 'QUOTA_EXHAUSTED') {
        this.metrics.skippedQuota = (this.metrics.skippedQuota || 0) + 1;
        this.metrics.skippedCooldownCount++;
        logTraceEvent({
          stage: STAGES.PROVIDER_FETCH_SKIPPED_QUOTA,
          traceId,
          provider: this.providerName,
          status: 'SKIPPED_QUOTA_EXHAUSTED',
          reason: gate.reason,
          extra: { remainingMs: gate.remainingMs, cooldownUntil: gate.cooldownUntil }
        });
        console.log(`[ProviderAdapter:${this.providerName}]\nSKIPPED_QUOTA_EXHAUSTED\nremainingMs=${gate.remainingMs}`);
      } else if (gate.reason === 'COOLDOWN_ACTIVE') {
        this.metrics.skippedCooldown = (this.metrics.skippedCooldown || 0) + 1;
        this.metrics.skippedCooldownCount++;
        logTraceEvent({
          stage: STAGES.PROVIDER_FETCH_SKIPPED_COOLDOWN,
          traceId,
          provider: this.providerName,
          status: 'SKIPPED_COOLDOWN',
          reason: gate.reason,
          extra: { remainingMs: gate.remainingMs, cooldownUntil: gate.cooldownUntil }
        });
        console.log(`[ProviderAdapter:${this.providerName}]\nSKIPPED — COOLDOWN ACTIVE\nremainingMs=${gate.remainingMs}\ncooldownUntil=${new Date(gate.cooldownUntil).toISOString()}`);
      } else if (gate.reason === 'DISABLED') {
        this.metrics.skippedDisabled = (this.metrics.skippedDisabled || 0) + 1;
        logTraceEvent({
          stage: STAGES.PROVIDER_FETCH_SKIPPED_DISABLED,
          traceId,
          provider: this.providerName,
          status: 'SKIPPED_DISABLED',
          reason: gate.reason
        });
      } else if (gate.reason === 'NOT_CONFIGURED') {
        this.metrics.skippedNotConfigured = (this.metrics.skippedNotConfigured || 0) + 1;
        logTraceEvent({
          stage: STAGES.PROVIDER_FETCH_SKIPPED_NOT_CONFIGURED,
          traceId,
          provider: this.providerName,
          status: 'SKIPPED_NOT_CONFIGURED',
          reason: gate.reason
        });
      }

      logTraceEvent({
        stage: STAGES.EXECUTE_FETCH_EXIT,
        traceId,
        provider: this.providerName,
        status: 'SKIPPED',
        reason: gate.reason,
        durationMs: 0
      });
      return [];
    }

    // Gated allowed: strictly a real fetch attempt
    this.isFetching = true;
    this.metrics.requests++;
    this.metrics.requestCount++;
    this.metrics.requestAttempts = (this.metrics.requestAttempts || 0) + 1;
    this.metrics.lastAttemptAt = new Date().toISOString();

    logTraceEvent({
      stage: STAGES.EXECUTE_FETCH_ALLOWED,
      traceId,
      provider: this.providerName
    });

    logTraceEvent({
      stage: STAGES.PROVIDER_FETCH_START,
      traceId,
      provider: this.providerName
    });

    logTraceEvent({
      stage: STAGES.CHILD_FETCH_ENTER,
      traceId,
      provider: this.providerName
    });

    try {
      const fetchResult = await this.fetch({ traceId });
      const rawItems = Array.isArray(fetchResult) ? fetchResult : (fetchResult?.items || []);
      const stats = (!Array.isArray(fetchResult) && fetchResult?.stats) ? fetchResult.stats : {};
      const duration = Date.now() - start;

      logTraceEvent({
        stage: STAGES.CHILD_FETCH_EXIT,
        traceId,
        provider: this.providerName,
        durationMs: duration,
        extra: { returnedCount: rawItems.length }
      });

      this.metrics.successfulHttpRequests = (this.metrics.successfulHttpRequests || 0) + 1;
      const rawCount = stats.rawCount ?? rawItems.length;
      const staleCount = stats.staleCount ?? 0;
      const dupCount = stats.duplicateCount ?? 0;

      this.metrics.rawFetched = (this.metrics.rawFetched || 0) + rawCount;
      this.metrics.stale = (this.metrics.stale || 0) + staleCount;
      this.metrics.staleCount = (this.metrics.staleCount || 0) + staleCount;
      this.metrics.duplicates = (this.metrics.duplicates || 0) + dupCount;
      this.metrics.duplicateCount = (this.metrics.duplicateCount || 0) + dupCount;

      this.recordSuccess(duration, rawItems.length);

      let acceptedCount = 0;
      let normalizedCount = 0;

      if (rawItems.length > 0) {
        for (const item of rawItems) {
          const normalized = this.normalize(item);
          if (normalized) {
            normalizedCount++;
            this._recentEvents.push(Date.now());
            this.emit('article', normalized);
            acceptedCount++;
          }
        }
      }

      this.metrics.normalized = (this.metrics.normalized || 0) + normalizedCount;
      this.metrics.accepted = (this.metrics.accepted || 0) + acceptedCount;
      this.metrics.acceptedCount = (this.metrics.acceptedCount || 0) + acceptedCount;

      logTraceEvent({
        stage: STAGES.PROVIDER_FETCH_SUCCESS,
        traceId,
        provider: this.providerName,
        durationMs: duration,
        extra: {
          rawFetched: rawCount,
          normalized: normalizedCount,
          stale: staleCount,
          duplicates: dupCount,
          accepted: acceptedCount
        }
      });

      logTraceEvent({
        stage: STAGES.PROVIDER_FETCH_RESULT,
        traceId,
        provider: this.providerName,
        status: 'SUCCESS',
        durationMs: duration,
        extra: {
          rawFetched: rawCount,
          accepted: acceptedCount
        }
      });

      logTraceEvent({
        stage: STAGES.EXECUTE_FETCH_EXIT,
        traceId,
        provider: this.providerName,
        status: 'SUCCESS',
        durationMs: duration
      });

      return rawItems;
    } catch (err) {
      const duration = Date.now() - start;
      this.metrics.httpErrors = (this.metrics.httpErrors || 0) + 1;

      logTraceEvent({
        stage: STAGES.CHILD_FETCH_EXIT,
        traceId,
        provider: this.providerName,
        durationMs: duration,
        status: 'ERROR',
        reason: err.message
      });

      logTraceEvent({
        stage: STAGES.PROVIDER_FETCH_ERROR,
        traceId,
        provider: this.providerName,
        durationMs: duration,
        reason: err.message,
        extra: { httpStatus: err.response?.status || null }
      });

      logTraceEvent({
        stage: STAGES.PROVIDER_FETCH_RESULT,
        traceId,
        provider: this.providerName,
        status: 'ERROR',
        durationMs: duration,
        reason: err.message
      });

      this.recordFailure(err);

      logTraceEvent({
        stage: STAGES.EXECUTE_FETCH_EXIT,
        traceId,
        provider: this.providerName,
        status: 'ERROR',
        durationMs: duration,
        reason: err.message
      });

      return [];
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Trigger on-demand manual fetch (e.g. for /api/fetch-live)
   */
  async pollNow() {
    return this._executeFetch();
  }

  /**
   * Internal loop scheduler for polling / minute-stream adapters
   */
  _scheduleNextPoll(delayMs = this.intervalMs) {
    if (!this.isRunning) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // If currently cooling down, sleep for the remaining duration instead of waking up prematurely
    let effectiveDelay = delayMs;
    if (Date.now() < this.cooldownUntil) {
      effectiveDelay = Math.max(1000, this.cooldownUntil - Date.now());
    }

    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.isRunning) return;

      await this._executeFetch();

      // Schedule next poll: if cooldown is active, sleep until it expires
      if (Date.now() < this.cooldownUntil) {
        this._scheduleNextPoll(Math.max(1000, this.cooldownUntil - Date.now()));
      } else {
        this._scheduleNextPoll(this.intervalMs);
      }
    }, effectiveDelay);
  }

  /**
   * Records a successful fetch or stream event
   */
  recordSuccess(latencyMs, count = 1) {
    this.metrics.successCount++;
    this.metrics.lastSuccessAt = new Date().toISOString();
    this.metrics.status = Date.now() < this.cooldownUntil ? 'COOLDOWN' : 'ACTIVE';
    this.metrics.lastHttpStatus = 200;
    this.metrics.lastError = null;
    this.metrics.lastErrorMessage = null;
    this.metrics.fetchedCount += (count || 0);

    if (count > 0) {
      this.metrics.lastArticleAt = new Date().toISOString();
    }

    if (latencyMs != null && latencyMs >= 0) {
      this.metrics.lastLatencyMs = latencyMs;
      this._latencyHistory.push(latencyMs);
      if (this._latencyHistory.length > 50) this._latencyHistory.shift();

      const sum = this._latencyHistory.reduce((a, b) => a + b, 0);
      this.metrics.averageLatencyMs = Math.round(sum / this._latencyHistory.length);

      const sorted = [...this._latencyHistory].sort((a, b) => a - b);
      const p95Idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
      this.metrics.p95LatencyMs = sorted[p95Idx] || latencyMs;
    }
  }

  /**
   * Records an error and triggers rate-limit backoff with strict Retry-After & daily quota handling
   */
  recordFailure(error) {
    this.metrics.errorCount++;
    const nowIso = new Date().toISOString();
    this.metrics.lastFailureAt = nowIso;
    this.metrics.lastError = error.message;
    this.metrics.lastErrorMessage = error.response?.data?.message ||
      error.response?.data?.error ||
      error.response?.data?.errors?.[0] ||
      error.response?.data?.results?.message ||
      error.message;

    const status = error.response?.status || null;
    this.metrics.lastHttpStatus = status;

    const rawErrorText = `${this.metrics.lastError} ${this.metrics.lastErrorMessage} ${JSON.stringify(error.response?.data || {})}`.toLowerCase();
    const isDailyQuota = /credit|quota|exceeded|request limit|limit for today|plan/i.test(rawErrorText);
    const retryAfterHeader = error.response?.headers?.['retry-after'];
    const retryAfterSec = parseRetryAfter(retryAfterHeader);

    if (status === 429) {
      this.metrics.rateLimitedCount++;
      this.metrics.rateLimitCount = this.metrics.rateLimitedCount;

      let calculatedCooldownMs = 120 * 1000; // default 2m
      if (isDailyQuota) {
        // Daily quota limit exceeded (e.g. Currents daily limit, NewsData monthly/daily credits)
        this.metrics.status = 'QUOTA_EXHAUSTED';
        const msUntilReset = getMsUntilUtcMidnight();
        // If Retry-After exists and is larger than midnight or substantial, use it
        calculatedCooldownMs = retryAfterSec ? Math.max(retryAfterSec * 1000, 300000) : msUntilReset;
      } else if (retryAfterSec) {
        // Upstream specified exact seconds or HTTP-Date
        this.metrics.status = 'COOLDOWN';
        calculatedCooldownMs = retryAfterSec * 1000;
      } else {
        this.metrics.status = 'COOLDOWN';
        calculatedCooldownMs = 120 * 1000;
      }

      const targetCooldown = Date.now() + calculatedCooldownMs;
      this.cooldownUntil = Math.max(this.cooldownUntil || 0, targetCooldown);
      this.metrics.cooldownUntil = new Date(this.cooldownUntil).toISOString();

      console.warn(`[ProviderAdapter:${this.providerName}]
HTTP_STATUS: ${status}
RETRY_AFTER: ${retryAfterHeader || 'none'} (${retryAfterSec ? retryAfterSec + 's' : 'unspecified'})
COOLDOWN_UNTIL: ${this.metrics.cooldownUntil}
STATUS: ${this.metrics.status}
SKIP_COUNT: ${this.metrics.skippedCooldownCount}`);
    } else if (status === 401) {
      this.metrics.status = 'AUTH_ERROR';
      this.cooldownUntil = Math.max(this.cooldownUntil || 0, Date.now() + 300 * 1000);
      this.metrics.cooldownUntil = new Date(this.cooldownUntil).toISOString();
      console.warn(`[ProviderAdapter:${this.providerName}] ⚠️ 401 Auth Error. Cooling down for 5min.`);
    } else if (status === 403) {
      if (isDailyQuota) {
        // GNews: 403 with "You have reached your request limit for today, the next reset will be tomorrow at 00:00 UTC."
        this.metrics.status = 'QUOTA_EXHAUSTED';
        const msUntilReset = getMsUntilUtcMidnight();
        this.cooldownUntil = Math.max(this.cooldownUntil || 0, Date.now() + msUntilReset);
        this.metrics.cooldownUntil = new Date(this.cooldownUntil).toISOString();
        console.warn(`[ProviderAdapter:${this.providerName}]
HTTP_STATUS: 403
RETRY_AFTER: none (Next reset 00:00 UTC)
COOLDOWN_UNTIL: ${this.metrics.cooldownUntil}
STATUS: QUOTA_EXHAUSTED
SKIP_COUNT: ${this.metrics.skippedCooldownCount}`);
      } else {
        this.metrics.status = 'AUTH_ERROR';
        this.cooldownUntil = Math.max(this.cooldownUntil || 0, Date.now() + 300 * 1000);
        this.metrics.cooldownUntil = new Date(this.cooldownUntil).toISOString();
        console.warn(`[ProviderAdapter:${this.providerName}] ⚠️ 403 Auth Error. Cooling down for 5min.`);
      }
    } else if (
      error.code === 'ECONNREFUSED' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNABORTED' ||
      /TLS|certificate|ETIMEDOUT|timeout/i.test(error.message)
    ) {
      this.metrics.status = 'UNREACHABLE';
      this.cooldownUntil = Math.max(this.cooldownUntil || 0, Date.now() + 60 * 1000);
      this.metrics.cooldownUntil = new Date(this.cooldownUntil).toISOString();
      console.warn(`[ProviderAdapter:${this.providerName}] ⚠️ UNREACHABLE: ${error.message}. Cooling down for 60s.`);
    } else {
      this.metrics.status = 'DEGRADED';
      console.warn(`[ProviderAdapter:${this.providerName}] ⚠️ DEGRADED: ${error.message}`);
    }
  }

  /**
   * Records a rate limit event, updates metrics, and sets a cooldown
   * @param {Error|number|null} [error] Error object or custom cooldown in ms
   * @param {number} [cooldownMs=120000] Default cooldown duration in ms
   */
  recordRateLimit(error = null, cooldownMs = 120000) {
    this.metrics.rateLimitedCount = (this.metrics.rateLimitedCount || 0) + 1;
    this.metrics.rateLimitCount = this.metrics.rateLimitedCount;
    this.metrics.status = 'RATE_LIMITED';
    const effectiveCooldown = typeof error === 'number' ? error : cooldownMs;
    this.cooldownUntil = Math.max(this.cooldownUntil || 0, Date.now() + effectiveCooldown);
    this.metrics.cooldownUntil = new Date(this.cooldownUntil).toISOString();

    if (error && typeof error === 'object' && error.message) {
      this.recordFailure(error);
    } else {
      console.warn(`[ProviderAdapter:${this.providerName}] ⚠️ Rate limited. Cooling down until ${this.metrics.cooldownUntil}`);
    }
  }

  /**
   * Health snapshot for telemetry APIs (Phases 11 & 12)
   */
  getHealth() {
    const isCoolingDown = Date.now() < this.cooldownUntil;
    const computedStatus = isCoolingDown
      ? (this.metrics.status === 'QUOTA_EXHAUSTED' || this.metrics.status === 'AUTH_ERROR' ? this.metrics.status : 'COOLDOWN')
      : (this.metrics.status === 'COOLDOWN' ? 'ACTIVE' : this.metrics.status);

    return {
      provider: this.providerName,
      providerName: this.providerName,
      displayName: this.displayName,
      fetchMode: this.fetchMode,
      priority: this.priority,
      intervalMs: this.intervalMs,
      ...this.metrics,
      requestAttempts: this.metrics.requestAttempts || this.metrics.requests || 0,
      successfulHttpRequests: this.metrics.successfulHttpRequests || this.metrics.successCount || 0,
      httpErrors: this.metrics.httpErrors || this.metrics.errorCount || 0,
      skippedCooldown: this.metrics.skippedCooldown || this.metrics.skippedCooldownCount || 0,
      skippedQuota: this.metrics.skippedQuota || 0,
      skippedDisabled: this.metrics.skippedDisabled || 0,
      rawFetched: this.metrics.rawFetched || this.metrics.fetchedCount || 0,
      normalized: this.metrics.normalized || 0,
      stale: this.metrics.stale || this.metrics.staleCount || 0,
      duplicates: this.metrics.duplicates || this.metrics.duplicateCount || 0,
      accepted: this.metrics.accepted || this.metrics.acceptedCount || 0,
      status: computedStatus,
      state: computedStatus,
      cooldownUntil: this.cooldownUntil ? new Date(this.cooldownUntil).toISOString() : null,
      cooldownRemainingSec: Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000))
    };
  }

  // Hook methods to be overridden by subclasses
  async onStart() {}
  async onStop() {}
  async fetch(_opts = {}) { return []; }
  normalize(_raw) { return null; }
  getCursor() { return null; }
  saveCursor(_cursor) {}
  async reconnect() {}
}
