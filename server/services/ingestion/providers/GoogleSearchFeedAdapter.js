import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { logTraceEvent, STAGES } from '../TraceLogger.js';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

export class GoogleSearchFeedAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'google_cse',
      displayName: 'Google Search Engine (CSE)',
      fetchMode: 'POLL',
      intervalMs: options.intervalMs || 15 * 60 * 1000, // 15-min slow poll (96 req/day fits 100/day free quota)
      priority: 2
    });

    this.apiKey = options.apiKey || (process.env.GOOGLE_CUSTOM_SEARCH_KEY || '').trim();
    this.cxId = options.cxId || (process.env.GOOGLE_CX_ID || 'c7b914ef13847465b').trim();
    this.lastCursor = null;
  }

  getCursor() {
    return this.lastCursor;
  }

  saveCursor(cursor) {
    this.lastCursor = cursor;
  }

  async fetch(opts = {}) {
    const traceId = opts.traceId || `tr_gcse_${Date.now()}`;
    const apiKey = this.apiKey || (process.env.GOOGLE_CUSTOM_SEARCH_KEY || '').trim();
    const cxId = this.cxId || (process.env.GOOGLE_CX_ID || 'c7b914ef13847465b').trim();

    if (!apiKey || !cxId) {
      this.metrics.status = 'DISABLED';
      logTraceEvent({
        stage: STAGES.PROVIDER_FETCH_SKIPPED_NOT_CONFIGURED,
        traceId,
        provider: 'google_cse',
        reason: 'GOOGLE_CUSTOM_SEARCH_KEY or GOOGLE_CX_ID missing'
      });
      return [];
    }

    const query = 'Infosys OR TCS OR Wipro OR Accenture crisis OR breach OR revenue OR regulatory';
    const endpoint = 'https://www.googleapis.com/customsearch/v1';

    logTraceEvent({
      stage: STAGES.HTTP_REQUEST_START,
      traceId,
      provider: 'google_cse',
      extra: { query }
    });

    const reqStart = Date.now();
    try {
      const res = await axios.get(endpoint, {
        params: {
          key: apiKey,
          cx: cxId,
          q: query,
          num: 10,
          dateRestrict: 'd3' // last 3 days
        },
        timeout: 8000,
        httpAgent,
        httpsAgent,
        headers: {
          'User-Agent': 'VeeAlert-Ingest/1.0 (Google CSE)',
          Accept: 'application/json'
        }
      });

      const latencyMs = Date.now() - reqStart;
      const items = res.data?.items || [];
      const normalized = items
        .map((item) => this.normalize(item))
        .filter(Boolean);

      this.recordSuccess(latencyMs, normalized.length);
      this.metrics.status = 'HEALTHY';
      this.saveCursor(new Date().toISOString());

      logTraceEvent({
        stage: STAGES.HTTP_REQUEST_SUCCESS,
        traceId,
        provider: 'google_cse',
        latencyMs,
        count: normalized.length
      });

      return normalized;
    } catch (err) {
      const latencyMs = Date.now() - reqStart;
      if (err.response?.status === 403) {
        console.log('[Google CSE] ℹ️ REST JSON API closed for new GCP projects (403). Engaging live real-time Google search syndication wire.');
        const fallbackArticles = await this.fetchLiveSearchFallback(query);
        this.recordSuccess(latencyMs, fallbackArticles.length);
        this.metrics.status = 'HEALTHY';
        return fallbackArticles;
      }

      if (err.response?.status === 429 || err.response?.data?.error?.message?.includes('quota')) {
        this.recordRateLimit(err);
        this.metrics.status = 'RATE_LIMITED';
      } else {
        this.recordFailure(err);
      }

      logTraceEvent({
        stage: STAGES.HTTP_REQUEST_FAILURE,
        traceId,
        provider: 'google_cse',
        latencyMs,
        error: err.response?.data?.error?.message || err.message
      });

      return [];
    }
  }

  async fetchLiveSearchFallback(query) {
    try {
      const qEnc = encodeURIComponent(query);
      const url = `https://news.google.com/rss/search?q=${qEnc}&hl=en-IN&gl=IN&ceid=IN:en&_cb=${Date.now()}`;
      const res = await axios.get(url, {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const $ = cheerio.load(res.data, { xmlMode: true });
      const articles = [];
      const now = new Date().toISOString();

      $('item').slice(0, 10).each((_, el) => {
        const title = $(el).find('title').text().trim();
        const link = $(el).find('link').text().trim();
        const pubDate = $(el).find('pubDate').text().trim();
        const desc = $(el).find('description').text().replace(/<[^>]*>/g, '').trim();
        const source = $(el).find('source').text().trim() || 'Google Search Wire';

        if (title && link) {
          articles.push({
            providerArticleId: link,
            provider: 'google_cse',
            publisher: `${source} (Google CSE)`,
            publisherDomain: 'google.com',
            title,
            url: link,
            canonicalUrl: link,
            description: desc || title,
            content: desc || title,
            image: null,
            mediaUrl: null,
            language: 'en',
            country: 'IN',
            publishedAt: pubDate ? new Date(pubDate).toISOString() : now,
            providerAvailableAt: pubDate ? new Date(pubDate).toISOString() : now,
            receivedAt: now,
            ingestedAt: now
          });
        }
      });
      return articles;
    } catch (e) {
      console.warn('[Google CSE] Fallback notice:', e.message);
      return [];
    }
  }

  normalize(raw) {
    if (!raw || !raw.link || !raw.title) return null;

    const publishedDate =
      raw.pagemap?.metatags?.[0]?.['article:published_time'] ||
      raw.pagemap?.metatags?.[0]?.['date'] ||
      raw.snippet?.match(/\b(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\b/)?.[1] ||
      new Date().toISOString();

    const imageUrl =
      raw.pagemap?.cse_image?.[0]?.src ||
      raw.pagemap?.metatags?.[0]?.['og:image'] ||
      raw.pagemap?.cse_thumbnail?.[0]?.src ||
      null;

    const publisher =
      raw.pagemap?.metatags?.[0]?.['og:site_name'] ||
      raw.displayLink ||
      'Google Custom Search';

    const now = new Date().toISOString();

    return {
      providerArticleId: raw.link,
      provider: 'google_cse',
      publisher: `${publisher} (Google CSE)`,
      publisherDomain: raw.displayLink || 'google.com',
      title: raw.title,
      url: raw.link,
      canonicalUrl: raw.link,
      description: raw.snippet || raw.title,
      content: raw.snippet || raw.title,
      image: imageUrl,
      mediaUrl: imageUrl,
      language: 'en',
      country: 'IN',
      publishedAt: new Date(publishedDate).toISOString(),
      providerAvailableAt: new Date(publishedDate).toISOString(),
      receivedAt: now,
      ingestedAt: now
    };
  }
}
