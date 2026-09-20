import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { logTraceEvent, STAGES, maskUrlCredentials } from '../TraceLogger.js';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

export class NewsDataAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'newsdata',
      displayName: 'NewsData.io Real-Time Wire',
      fetchMode: 'POLL',
      intervalMs: options.intervalMs || 60000,
      priority: 1
    });
    this.apiKey = options.apiKey || (process.env.NEWSDATA_API_KEY || '').trim();
    this.lastCursor = null;
    this.wsClient = null;
  }

  getCursor() {
    return this.lastCursor;
  }

  saveCursor(cursor) {
    this.lastCursor = cursor;
  }

  async fetch(opts = {}) {
    const traceId = opts.traceId || `tr_newsdata_${Date.now()}`;

    if (!this.apiKey) {
      this.metrics.status = 'DISABLED';
      logTraceEvent({
        stage: STAGES.PROVIDER_FETCH_SKIPPED_NOT_CONFIGURED,
        traceId,
        provider: 'newsdata',
        reason: 'NEWSDATA_API_KEY missing'
      });
      return [];
    }

    const query = encodeURIComponent('(Infosys OR TCS OR Wipro OR Accenture)');
    const url = `https://newsdata.io/api/1/latest?apikey=${this.apiKey}&q=${query}&language=en`;
    const maskedUrl = maskUrlCredentials(url);

    logTraceEvent({
      stage: STAGES.HTTP_REQUEST_START,
      traceId,
      provider: 'newsdata',
      extra: { url: maskedUrl }
    });

    const reqStart = Date.now();
    try {
      const res = await axios.get(url, {
        timeout: this.timeoutMs,
        httpAgent,
        httpsAgent,
        headers: { 'Accept': 'application/json' }
      });
      const reqDuration = Date.now() - reqStart;

      logTraceEvent({
        stage: STAGES.HTTP_RESPONSE,
        traceId,
        provider: 'newsdata',
        durationMs: reqDuration,
        extra: {
          status: res.status,
          contentLength: res.headers['content-length'] || JSON.stringify(res.data || '').length
        }
      });

      const results = res.data?.results || [];

      if (results.length > 0) {
        const newestDate = results
          .map(r => r.pubDate)
          .filter(Boolean)
          .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

        if (newestDate) {
          this.saveCursor(newestDate);
        }
      }

      return {
        items: results,
        stats: { rawCount: results.length, staleCount: 0, duplicateCount: 0 }
      };
    } catch (err) {
      const reqDuration = Date.now() - reqStart;
      logTraceEvent({
        stage: STAGES.HTTP_ERROR,
        traceId,
        provider: 'newsdata',
        durationMs: reqDuration,
        status: err.response?.status || null,
        reason: err.message
      });
      throw err;
    }
  }

  normalize(raw) {
    if (!raw || !raw.title || !raw.link) return null;

    let publishedAt = null;
    if (raw.pubDate) {
      const d = new Date(raw.pubDate);
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    const now = new Date().toISOString();

    return {
      providerArticleId: String(raw.article_id || raw.link),
      provider: 'newsdata',
      publisher: raw.source_id || 'NewsData.io',
      publisherDomain: raw.source_id ? `${raw.source_id}.com` : 'newsdata.io',
      title: raw.title,
      url: raw.link,
      canonicalUrl: raw.link,
      description: raw.description || null,
      content: raw.content || raw.description || raw.title,
      image: raw.image_url || null,
      language: raw.language || 'en',
      country: Array.isArray(raw.country) ? raw.country[0] : raw.country,
      publishedAt,
      providerAvailableAt: null, // Syndication proxy: upstream does not emit separate availability timestamp
      receivedAt: now,
      ingestedAt: now
    };
  }
}
