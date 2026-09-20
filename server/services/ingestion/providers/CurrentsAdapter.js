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

export class CurrentsAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'currents',
      displayName: 'Currents Global News API',
      fetchMode: 'POLL',
      intervalMs: options.intervalMs || 10 * 60 * 1000,
      priority: 2
    });
    this.apiKey = options.apiKey || (process.env.CURRENTS_API_KEY || '').trim();
    this.lastCursor = null;
  }

  getCursor() {
    return this.lastCursor;
  }

  saveCursor(cursor) {
    this.lastCursor = cursor;
  }

  async fetch(opts = {}) {
    const traceId = opts.traceId || `tr_currents_${Date.now()}`;

    if (!this.apiKey) {
      this.metrics.status = 'DISABLED';
      logTraceEvent({
        stage: STAGES.PROVIDER_FETCH_SKIPPED_NOT_CONFIGURED,
        traceId,
        provider: 'currents',
        reason: 'CURRENTS_API_KEY missing'
      });
      return [];
    }

    const query = '("Infosys" OR "TCS" OR "Tata Consultancy Services" OR "Wipro" OR "Accenture")';
    const startDate = this.lastCursor || new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const endpoint = 'https://api.currentsapi.services/v1/search';
    const maskedUrl = `${endpoint}?query=${encodeURIComponent(query)}&apiKey=REDACTED&start_date=${startDate}`;

    logTraceEvent({
      stage: STAGES.HTTP_REQUEST_START,
      traceId,
      provider: 'currents',
      extra: { url: maskedUrl }
    });

    const reqStart = Date.now();
    try {
      const res = await axios.get(endpoint, {
        params: {
          query,
          language: 'en',
          apiKey: this.apiKey,
          start_date: startDate
        },
        headers: {
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
        provider: 'currents',
        durationMs: reqDuration,
        extra: {
          status: res.status,
          contentLength: res.headers['content-length'] || JSON.stringify(res.data || '').length
        }
      });

      const articles = res.data?.news || [];

      if (articles.length > 0) {
        const newestDate = articles
          .map(a => a.published)
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
        provider: 'currents',
        durationMs: reqDuration,
        status: err.response?.status || null,
        reason: err.message
      });
      throw err;
    }
  }

  normalize(raw) {
    if (!raw || !raw.title || !raw.url) return null;

    const publishedAt = raw.published ? new Date(raw.published).toISOString() : null;
    const now = new Date().toISOString();

    return {
      providerArticleId: String(raw.id || raw.url),
      provider: 'currents',
      publisher: raw.author || 'Currents News',
      publisherDomain: raw.author ? `${raw.author.replace(/[^a-z0-9]/gi, '').toLowerCase()}.com` : 'currentsapi.services',
      title: cleanHtml(raw.title),
      url: raw.url,
      canonicalUrl: raw.url,
      description: cleanHtml(raw.description) || null,
      content: cleanHtml(raw.description) || cleanHtml(raw.title),
      image: raw.image !== 'None' ? raw.image : null,
      language: raw.language || 'en',
      country: Array.isArray(raw.country) ? raw.country[0] : raw.country,
      publishedAt,
      providerAvailableAt: null, // Syndication proxy
      receivedAt: now,
      ingestedAt: now
    };
  }
}
