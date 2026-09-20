import axios from 'axios';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { logTraceEvent, STAGES, maskUrlCredentials } from '../TraceLogger.js';

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

export class EventRegistryAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'eventregistry',
      displayName: 'Event Registry (Minute Stream)',
      fetchMode: 'MINUTE_STREAM',
      intervalMs: options.intervalMs || 60000,
      priority: 1
    });
    this.apiKey = options.apiKey || (process.env.EVENT_REGISTRY_API_KEY || '').trim();
    this.newestUri = null;
    this._hasReceivedFirstArticle = false;
    if (!this.apiKey) {
      this.metrics.status = 'DISABLED';
      this.metrics.lastError = 'EVENT_REGISTRY_API_KEY not configured in server/.env';
    }
  }

  getCursor() {
    return this.newestUri;
  }

  saveCursor(cursor) {
    this.newestUri = cursor;
  }

  async onStart() {
    if (!this.apiKey) {
      this.metrics.status = 'DISABLED';
      this.metrics.lastError = 'EVENT_REGISTRY_API_KEY not configured in server/.env';
      console.warn('[EventRegistry] ⚠️ EVENT_REGISTRY_API_KEY is not configured in server/.env. Stream disabled.');
      return;
    }
    console.log('[EventRegistry] STREAM_CONNECTED');
  }

  async fetch(opts = {}) {
    const traceId = opts.traceId || `tr_eventregistry_${Date.now()}`;

    if (!this.apiKey) {
      this.metrics.status = 'DISABLED';
      this.metrics.lastError = 'EVENT_REGISTRY_API_KEY not configured in server/.env';
      logTraceEvent({
        stage: STAGES.PROVIDER_FETCH_SKIPPED_NOT_CONFIGURED,
        traceId,
        provider: 'eventregistry',
        reason: 'EVENT_REGISTRY_API_KEY not configured in server/.env'
      });
      return [];
    }

    const endpoint = 'https://eventregistry.org/api/v1/article/getArticles';
    logTraceEvent({
      stage: STAGES.HTTP_REQUEST_START,
      traceId,
      provider: 'eventregistry',
      extra: { endpoint, apiKey: 'REDACTED' }
    });

    const reqStart = Date.now();
    try {
      const params = {
        apiKey: this.apiKey,
        articlesPage: 1,
        articlesCount: 20,
        articlesSortBy: 'date',
        articlesSortByAsc: false,
        keyword: ['Infosys', 'Tata Consultancy Services', 'Wipro', 'Accenture'],
        keywordOper: 'or',
        lang: 'eng'
      };

      const res = await axios.post(endpoint, params, {
        timeout: this.timeoutMs,
        headers: { 'Content-Type': 'application/json' }
      });

      const reqDuration = Date.now() - reqStart;
      const articles = res.data?.articles?.results || [];

      logTraceEvent({
        stage: STAGES.HTTP_RESPONSE,
        traceId,
        provider: 'eventregistry',
        durationMs: reqDuration,
        extra: {
          status: res.status,
          articlesReceived: articles.length
        }
      });

      console.log(`[EventRegistry] ARTICLES_RECEIVED=${articles.length}`);

      if (articles.length > 0) {
        if (!this._hasReceivedFirstArticle) {
          this._hasReceivedFirstArticle = true;
          console.log(`[EventRegistry] FIRST_ARTICLE_RECEIVED: "${articles[0].title?.slice(0, 50)}..."`);
        }
        if (articles[0].uri) {
          this.saveCursor(articles[0].uri);
          console.log(`[EventRegistry] CURSOR_UPDATED ${articles[0].uri}`);
        }
      }

      return {
        items: articles,
        stats: {
          rawCount: articles.length,
          staleCount: 0,
          duplicateCount: 0
        }
      };
    } catch (err) {
      const reqDuration = Date.now() - reqStart;
      logTraceEvent({
        stage: STAGES.HTTP_ERROR,
        traceId,
        provider: 'eventregistry',
        durationMs: reqDuration,
        status: err.response?.status || null,
        reason: err.message
      });
      console.error(`[EventRegistry] ERROR=${err.message}`);
      throw err;
    }
  }

  normalize(raw) {
    if (!raw || !raw.title || !raw.url) return null;

    const publishedAt = raw.dateTime ? new Date(raw.dateTime).toISOString() : (raw.date ? new Date(raw.date).toISOString() : null);
    const now = new Date().toISOString();
    let publisherDomain = null;
    try {
      publisherDomain = new URL(raw.url).hostname.replace(/^www\./, '');
    } catch (_) {}

    return {
      providerArticleId: String(raw.uri || raw.url),
      provider: 'eventregistry',
      publisher: raw.source?.title || publisherDomain || 'Event Registry Wire',
      publisherDomain: publisherDomain || 'eventregistry.org',
      title: cleanHtml(raw.title),
      url: raw.url,
      canonicalUrl: raw.url,
      description: cleanHtml(raw.body?.slice(0, 300) || ''),
      content: cleanHtml(raw.body || raw.title),
      image: raw.image || null,
      language: raw.lang || 'en',
      country: null,
      publishedAt,
      providerAvailableAt: null, // Syndication proxy
      receivedAt: now,
      ingestedAt: now
    };
  }
}
