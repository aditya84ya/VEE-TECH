import https from 'node:https';
import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import { getPublisherMetrics, validateEntityContext } from './mediaMetrics.js';

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';

export class SearchService {
  /**
   * Execute high-speed concurrent search across Google News RSS, GDELT 2.0,
   * and institutional publishers with query expansion.
   *
   * @param {string} query - Target search query
   * @param {object} options
   * @param {number} [options.maxResults=50]
   * @returns {Promise<{ totalResults: number, latencyMs: number, results: Array<object>, diagnostics: object }>}
   */
  static async searchAll(query = 'Infosys', options = {}) {
    const startTime = Date.now();
    const cleanQuery = (query || 'Infosys').trim();
    const maxResults = options.maxResults || 50;

    const diagnostics = {
      googlenews: 0,
      gdelt: 0
    };

    // Parallel fetch tasks: Google News RSS + GDELT 2.0
    const googleNewsPromise = this._searchGoogleNewsRss(cleanQuery, maxResults);
    const gdeltPromise = this._searchGdelt(cleanQuery, maxResults);

    const settled = await Promise.allSettled([googleNewsPromise, gdeltPromise]);

    const rawResults = [];
    const seenUrls = new Set();

    if (settled[0].status === 'fulfilled') {
      const items = settled[0].value || [];
      diagnostics.googlenews = items.length;
      rawResults.push(...items);
    } else {
      console.warn(`[SearchService] ⚠️ Google News search error: ${settled[0].reason?.message}`);
    }

    if (settled[1].status === 'fulfilled') {
      const items = settled[1].value || [];
      diagnostics.gdelt = items.length;
      rawResults.push(...items);
    } else {
      console.warn(`[SearchService] ⚠️ GDELT search error: ${settled[1].reason?.message}`);
    }

    // Deduplicate & enrich
    const finalResults = [];
    for (const item of rawResults) {
      if (!item.url || seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);

      // Noise disambiguation filter
      if (!validateEntityContext(`${item.title} ${item.snippet}`, cleanQuery)) {
        continue;
      }

      // Calculate media metrics
      const metrics = getPublisherMetrics(item.publisher, 'NEUTRAL');
      item.estimated_reach = metrics.reach;
      item.ave_val = metrics.ave;
      item.publisher_tier = metrics.tier;

      finalResults.push(item);
      if (finalResults.length >= maxResults) break;
    }

    const latencyMs = Date.now() - startTime;

    return {
      query: cleanQuery,
      totalResults: finalResults.length,
      latencyMs,
      diagnostics,
      results: finalResults
    };
  }

  static async _searchGoogleNewsRss(query, limit = 30) {
    try {
      const url = `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
      const res = await axios.get(url, {
        timeout: 6000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
        }
      });

      const $ = cheerio.load(res.data, { xmlMode: true });
      const items = $('item').toArray().slice(0, limit);
      const results = [];

      for (const el of items) {
        const title = $(el).find('title').text().trim();
        const link = $(el).find('link').text().trim();
        const pubDate = $(el).find('pubDate').text().trim();
        const source = $(el).find('source').text().trim() || 'Google News';

        if (!title || !link) continue;

        let publishedAt = new Date().toISOString();
        if (pubDate) {
          const d = new Date(pubDate);
          if (!isNaN(d.getTime())) publishedAt = d.toISOString();
        }

        results.push({
          id: crypto.createHash('sha256').update(link).digest('hex').slice(0, 16),
          title,
          url: link,
          snippet: title,
          publisher: source,
          source_provider: 'googlenews_search',
          published_at: publishedAt
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  static async _searchGdelt(query, limit = 30) {
    try {
      const params = {
        query: `${query} sourcelang:eng`,
        mode: 'artlist',
        maxrecords: Math.min(limit, 50),
        format: 'json',
        sort: 'DateDesc',
        timespan: '48h'
      };

      const res = await axios.get(GDELT_DOC_API, {
        params,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        timeout: 25000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        }
      });

      if (!res.data || !Array.isArray(res.data.articles)) {
        return [];
      }

      const results = [];
      for (const item of res.data.articles) {
        if (!item.url || !item.title) continue;

        let publishedAt = new Date().toISOString();
        if (item.seendate && item.seendate.length >= 8) {
          const raw = item.seendate.replace(/[^0-9]/g, '');
          if (raw.length >= 8) {
            const y = raw.slice(0, 4);
            const m = raw.slice(4, 6);
            const d = raw.slice(6, 8);
            publishedAt = new Date(`${y}-${m}-${d}T00:00:00Z`).toISOString();
          }
        }

        results.push({
          id: crypto.createHash('sha256').update(item.url).digest('hex').slice(0, 16),
          title: item.title.trim(),
          url: item.url,
          snippet: item.title.trim(),
          publisher: item.domain || item.sourcecountry || 'Global Wire',
          source_provider: 'gdelt',
          image_url: item.socialimage || null,
          published_at: publishedAt
        });
      }

      return results;
    } catch {
      return [];
    }
  }
}
