import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { logTraceEvent, STAGES, maskUrlCredentials } from '../TraceLogger.js';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

export class GuardianAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'guardian',
      displayName: 'The Guardian Content API',
      fetchMode: 'POLL',
      intervalMs: options.intervalMs || 30000, // 30s — Guardian allows 500 req/day (5 req/day ceiling), headroom permits tighter polling
      priority: 2
    });
    this.apiKey = options.apiKey || (process.env.GUARDIAN_API_KEY || '').trim();
    this.lastCursor = null;
  }

  getCursor() {
    return this.lastCursor;
  }

  saveCursor(cursor) {
    this.lastCursor = cursor;
  }

  async fetch(opts = {}) {
    const traceId = opts.traceId || `tr_guardian_${Date.now()}`;

    if (!this.apiKey) {
      this.metrics.status = 'DISABLED';
      logTraceEvent({
        stage: STAGES.PROVIDER_FETCH_SKIPPED_NOT_CONFIGURED,
        traceId,
        provider: 'guardian',
        reason: 'GUARDIAN_API_KEY missing'
      });
      return [];
    }

    const query = encodeURIComponent('(Infosys OR "Tata Consultancy Services" OR TCS OR Wipro OR Accenture)');
    // Restrict strictly to 12-hour recency window
    const maxAgeMs = 12 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - maxAgeMs;
    const fallbackFrom = new Date(cutoffTime).toISOString().split('T')[0];
    const fromDate = (this.lastCursor && new Date(this.lastCursor).getTime() > cutoffTime)
      ? new Date(this.lastCursor).toISOString().split('T')[0]
      : fallbackFrom;
    const url = `https://content.guardianapis.com/search?q=${query}&show-fields=headline,byline,trailText,bodyText,thumbnail&order-by=newest&page-size=15&from-date=${encodeURIComponent(fromDate)}&api-key=${this.apiKey}`;
    const maskedUrl = maskUrlCredentials(url);

    logTraceEvent({
      stage: STAGES.HTTP_REQUEST_START,
      traceId,
      provider: 'guardian',
      extra: { url: maskedUrl }
    });

    const maxRetries = 3;
    let res = null;
    const reqStart = Date.now();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        res = await axios.get(url, {
          timeout: this.timeoutMs,
          httpAgent,
          httpsAgent,
          headers: { 'Accept': 'application/json' }
        });
        break;
      } catch (err) {
        const isConnReset = err.code === 'ECONNRESET' ||
                            err.message?.includes('ECONNRESET') ||
                            (err.code === 'ETIMEDOUT' && err.message?.includes('socket'));

        if (isConnReset && attempt < maxRetries) {
          const backoffMs = attempt * 1000;
          console.warn(`[GuardianAdapter] ⚠️ Connection reset (${err.code || err.message}). Retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }

        const reqDuration = Date.now() - reqStart;
        logTraceEvent({
          stage: STAGES.HTTP_ERROR,
          traceId,
          provider: 'guardian',
          durationMs: reqDuration,
          status: err.response?.status || null,
          reason: err.message
        });
        throw err;
      }
    }

    const reqDuration = Date.now() - reqStart;
    logTraceEvent({
      stage: STAGES.HTTP_RESPONSE,
      traceId,
      provider: 'guardian',
      durationMs: reqDuration,
      extra: {
        status: res.status,
        contentLength: res.headers['content-length'] || JSON.stringify(res.data || '').length
      }
    });

    const rawResults = res.data?.response?.results || [];
    let staleCount = 0;

    // Filter results through 12-hour recency guardrail
    const results = rawResults.filter(r => {
      if (!r.webPublicationDate) return true;
      const pubTime = new Date(r.webPublicationDate).getTime();
      if (isNaN(pubTime)) return true;
      const ageHours = (Date.now() - pubTime) / (3600 * 1000);
      if (ageHours > 12) {
        staleCount++;
        const ageDesc = ageHours >= 48 ? `${(ageHours / 24).toFixed(1)} days` : `${ageHours.toFixed(1)} hours`;
        console.log(`[GuardianAdapter] 🚫 DROPPED STALE: "${(r.webTitle || '').slice(0, 50)}..." (published ${ageDesc} ago exceeds 12h window)`);
        return false;
      }
      return true;
    });

    if (results.length > 0) {
      // Update cursor to newest publication date
      const newestDate = results
        .map(r => r.webPublicationDate)
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

      if (newestDate) {
        this.saveCursor(newestDate);
      }
    }

    return {
      items: results,
      stats: {
        rawCount: rawResults.length,
        staleCount,
        duplicateCount: 0
      }
    };
  }

  normalize(raw) {
    if (!raw || !raw.webTitle || !raw.webUrl) return null;

    const fields = raw.fields || {};
    const publishedAt = raw.webPublicationDate ? new Date(raw.webPublicationDate).toISOString() : null;
    const now = new Date().toISOString();

    return {
      providerArticleId: String(raw.id || raw.webUrl),
      provider: 'guardian',
      publisher: 'The Guardian',
      publisherDomain: 'theguardian.com',
      title: fields.headline || raw.webTitle,
      url: raw.webUrl,
      canonicalUrl: raw.webUrl,
      description: fields.trailText || null,
      content: fields.bodyText || fields.trailText || raw.webTitle,
      image: fields.thumbnail || null,
      language: 'en',
      country: 'GB',
      publishedAt,
      providerAvailableAt: null, // Polled API without separate syndication availability timestamp
      receivedAt: now,
      ingestedAt: now
    };
  }
}
