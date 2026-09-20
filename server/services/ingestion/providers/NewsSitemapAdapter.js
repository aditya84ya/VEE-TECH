import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { logTraceEvent, STAGES } from '../TraceLogger.js';

const TARGET_REGEX = /\b(Infosys|Infosys\s+ADR|NYSE:\s*INFY|TCS|Tata\s+Consultancy|Wipro|Wipro\s+ADR|Accenture|Finacle)\b/i;

const SITEMAPS = [
  {
    name: 'The Indian Express (Google News Sitemap)',
    url: 'https://indianexpress.com/news-sitemap.xml',
    publisher: 'The Indian Express',
    publisherDomain: 'indianexpress.com'
  },
  {
    name: 'Telangana Today (Google News Sitemap)',
    url: 'https://telanganatoday.com/news-sitemap.xml',
    publisher: 'Telangana Today',
    publisherDomain: 'telanganatoday.com'
  },
  {
    name: 'Mid-Day Mumbai (Google News Sitemap)',
    url: 'https://www.mid-day.com/news-sitemap.xml',
    publisher: 'Mid-Day',
    publisherDomain: 'mid-day.com'
  },
  {
    name: 'Free Press Journal (Google News Sitemap)',
    url: 'https://www.freepressjournal.in/news-sitemap.xml',
    publisher: 'Free Press Journal',
    publisherDomain: 'freepressjournal.in'
  }
];

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

export class NewsSitemapAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'newssitemaps',
      displayName: 'Direct Publisher Google News Sitemaps',
      fetchMode: 'POLL',
      intervalMs: options.intervalMs || 45000, // 45s conditional poll with If-Modified-Since
      priority: 2
    });
    this.seenUrls = new Set();
    this.lastModifiedMap = new Map(); // url -> lastModified header string
  }

  _isSeen(url) {
    if (!url) return false;
    if (this.seenUrls.has(url)) return true;
    if (this.seenUrls.size > 2000) {
      const oldest = this.seenUrls.values().next().value;
      if (oldest) this.seenUrls.delete(oldest);
    }
    this.seenUrls.add(url);
    return false;
  }

  async fetch(opts = {}) {
    const traceId = opts.traceId || `tr_sitemap_${Date.now()}`;

    logTraceEvent({
      stage: STAGES.HTTP_REQUEST_START,
      traceId,
      provider: 'newssitemaps',
      extra: { sitemapCount: SITEMAPS.length, concurrency: 'ALL_PARALLEL' }
    });

    const reqStart = Date.now();
    const fetchPromises = SITEMAPS.map(async (cfg) => {
      const lastMod = this.lastModifiedMap.get(cfg.url);
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/xml, text/xml, */*'
      };
      if (lastMod) {
        headers['If-Modified-Since'] = lastMod;
      }

      try {
        const res = await axios.get(cfg.url, {
          timeout: 8000,
          httpAgent,
          httpsAgent,
          headers,
          validateStatus: (status) => (status >= 200 && status < 300) || status === 304
        });

        if (res.status === 304) {
          return { cfg, status: 304, notModified: true, items: [] };
        }

        if (res.headers['last-modified']) {
          this.lastModifiedMap.set(cfg.url, res.headers['last-modified']);
        }

        const rawXml = typeof res.data === 'string' ? res.data : '';
        const $ = cheerio.load(rawXml, { xmlMode: true });
        const parsed = [];

        $('url').each((_, el) => {
          const loc = $(el).find('loc').text().trim();
          const title = $(el).find('news\\:title, title').text().trim();
          const pubDate = $(el).find('news\\:publication_date, publication_date').text().trim();

          if (!loc || !title) return;
          if (this._isSeen(loc)) return;
          if (!TARGET_REGEX.test(title)) return;

          const imageLoc = $(el).find('image\\:loc, loc[type="image"]').text().trim();

          parsed.push({
            guid: loc,
            url: loc,
            title,
            pubDate,
            imageLoc: imageLoc || null,
            publisher: cfg.publisher,
            publisherDomain: cfg.publisherDomain
          });
        });

        return { cfg, status: res.status, notModified: false, items: parsed };
      } catch (err) {
        return { cfg, status: err.response?.status || 500, error: err.message, items: [] };
      }
    });

    const results = await Promise.allSettled(fetchPromises);
    const reqDuration = Date.now() - reqStart;
    const freshItems = [];
    let successfulFeeds = 0;

    for (const r of results) {
      if (r.status === 'fulfilled') {
        successfulFeeds++;
        if (Array.isArray(r.value.items)) {
          freshItems.push(...r.value.items);
        }
      }
    }

    logTraceEvent({
      stage: STAGES.HTTP_RESPONSE,
      traceId,
      provider: 'newssitemaps',
      durationMs: reqDuration,
      extra: {
        successfulFeeds,
        fresh: freshItems.length
      }
    });

    return {
      items: freshItems,
      stats: {
        rawCount: freshItems.length,
        duplicateCount: 0,
        staleCount: 0
      }
    };
  }

  normalize(raw) {
    if (!raw || !raw.title || !raw.url) return null;

    let publishedAt = null;
    if (raw.pubDate) {
      const d = new Date(raw.pubDate);
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    const now = new Date().toISOString();

    return {
      providerArticleId: raw.guid || raw.url,
      provider: 'newssitemaps',
      publisher: raw.publisher || 'Direct News Sitemap',
      publisherDomain: raw.publisherDomain || 'news.google.com',
      title: raw.title,
      url: raw.url,
      sourceUrl: raw.url,
      publisherUrl: raw.url,
      canonicalUrl: raw.url,
      description: raw.title,
      content: `${raw.title}\n\nPublished in ${raw.publisher}. Direct News Sitemap ingestion.`,
      image: raw.imageLoc || null,
      mediaUrl: raw.imageLoc || null,
      language: 'en',
      country: 'IN',
      publishedAt: publishedAt || now,
      providerAvailableAt: publishedAt || now,
      receivedAt: now,
      ingestedAt: now
    };
  }
}
