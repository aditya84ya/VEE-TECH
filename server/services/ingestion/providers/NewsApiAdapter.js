import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { logTraceEvent, STAGES, maskUrlCredentials } from '../TraceLogger.js';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

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

export class NewsApiAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'newsapi',
      displayName: 'NewsAPI (Global Aggregator)',
      fetchMode: 'POLL',
      intervalMs: options.intervalMs || 15 * 60 * 1000,
      priority: 2
    });
    this.apiKey = options.apiKey || (process.env.NEWSAPI_KEY || '').trim();
    this.lastCursor = null;
  }

  getCursor() {
    return this.lastCursor;
  }

  saveCursor(cursor) {
    this.lastCursor = cursor;
  }

  async fetch(opts = {}) {
    const traceId = opts.traceId || `tr_newsapi_${Date.now()}`;

    if (!this.apiKey) {
      this.metrics.status = 'DISABLED';
      logTraceEvent({
        stage: STAGES.PROVIDER_FETCH_SKIPPED_NOT_CONFIGURED,
        traceId,
        provider: 'newsapi',
        reason: 'NEWSAPI_KEY missing'
      });
      return [];
    }

    const query = '(Infosys OR "Tata Consultancy Services" OR Wipro OR Accenture)';
    const fromParam = this.lastCursor || new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const endpoint = 'https://newsapi.org/v2/everything';
    const maskedUrl = `${endpoint}?q=${encodeURIComponent(query)}&from=${fromParam}&sortBy=publishedAt&apiKey=REDACTED`;

    logTraceEvent({
      stage: STAGES.HTTP_REQUEST_START,
      traceId,
      provider: 'newsapi',
      extra: { url: maskedUrl }
    });

    const reqStart = Date.now();
    try {
      const res = await axios.get(endpoint, {
        params: {
          q: query,
          sortBy: 'publishedAt',
          language: 'en',
          pageSize: 20,
          from: fromParam
        },
        headers: {
          'X-Api-Key': this.apiKey,
          'User-Agent': 'VeeAlert/2.0 (Realtime News Architecture)'
        },
        httpAgent,
        httpsAgent,
        timeout: this.timeoutMs
      });
      const reqDuration = Date.now() - reqStart;

      logTraceEvent({
        stage: STAGES.HTTP_RESPONSE,
        traceId,
        provider: 'newsapi',
        durationMs: reqDuration,
        extra: {
          status: res.status,
          contentLength: res.headers['content-length'] || JSON.stringify(res.data || '').length
        }
      });

      const articles = res.data?.articles || [];

      if (articles.length > 0) {
        const newestDate = articles
          .map(a => a.publishedAt)
          .filter(Boolean)
          .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

        if (newestDate) {
          this.saveCursor(newestDate);
        }
      }

      return {
        items: articles,
        stats: { rawCount: articles.length, staleCount: 0, duplicateCount: 0 }
      };
    } catch (err) {
      const reqDuration = Date.now() - reqStart;
      logTraceEvent({
        stage: STAGES.HTTP_ERROR,
        traceId,
        provider: 'newsapi',
        durationMs: reqDuration,
        status: err.response?.status || null,
        reason: err.message
      });
      throw err;
    }
  }

  normalize(raw) {
    if (!raw || !raw.title || !raw.url) return null;

    const publishedAt = raw.publishedAt ? new Date(raw.publishedAt).toISOString() : null;
    const now = new Date().toISOString();

    return {
      providerArticleId: String(raw.url),
      provider: 'newsapi',
      publisher: raw.source?.name || 'NewsAPI Aggregator',
      publisherDomain: raw.source?.name ? `${raw.source.name.replace(/[^a-z0-9]/gi, '').toLowerCase()}.com` : 'newsapi.org',
      title: cleanHtml(raw.title),
      url: raw.url,
      canonicalUrl: raw.url,
      description: cleanHtml(raw.description) || null,
      content: cleanHtml(raw.content) || cleanHtml(raw.description) || cleanHtml(raw.title),
      image: raw.urlToImage || null,
      language: 'en',
      country: null,
      publishedAt,
      providerAvailableAt: null, // Syndication proxy
      receivedAt: now,
      ingestedAt: now
    };
  }
}
