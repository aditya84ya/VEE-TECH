import https from 'node:https';
import axios from 'axios';
import { ProviderAdapter } from '../ProviderAdapter.js';

const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const QUERY = '(Infosys OR TCS OR "Tata Consultancy Services" OR Wipro OR Accenture OR Finacle) sourcelang:eng';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false // Bypasses strict Node.js TLS cert mismatches for GDELT CDN
});

export class GDELTAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'gdelt',
      displayName: 'GDELT 2.0 Global Event & News Wire',
      fetchMode: 'POLL',
      intervalMs: options.intervalMs || 60000, // Poll every 60s
      priority: 2
    });
    this.seenUrls = new Set();
    this.enabled = options.enabled ?? true;
    this.metrics.status = this.enabled ? 'HEALTHY' : 'DISABLED';
  }

  async onStart() {
    if (!this.enabled) {
      this.metrics.status = 'DISABLED';
      console.log('[GDELTAdapter] ℹ️ Source inactive: GDELT disabled by configuration.');
    } else {
      this.metrics.status = 'HEALTHY';
      console.log('[GDELTAdapter] 🚀 GDELT 2.0 Global Event & News Wire activated with TLS bypass.');
    }
  }

  _isSeen(url) {
    if (!url) return false;
    if (this.seenUrls.has(url)) return true;
    if (this.seenUrls.size >= 1000) {
      const oldest = this.seenUrls.values().next().value;
      if (oldest) this.seenUrls.delete(oldest);
    }
    this.seenUrls.add(url);
    return false;
  }

  async fetch() {
    if (!this.enabled) {
      this.metrics.status = 'DISABLED';
      return [];
    }

    try {
      const params = {
        query: 'Infosys sourcelang:eng',
        mode: 'artlist',
        maxrecords: 20,
        format: 'json',
        sort: 'DateDesc',
        timespan: '24h'
      };

      const res = await axios.get(GDELT_DOC_API, {
        params,
        httpsAgent,
        timeout: 25000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        }
      });

      if (!res.data || typeof res.data !== 'object') {
        return [];
      }

      const articles = res.data.articles || [];
      const newItems = [];

      for (const item of articles) {
        if (!item.url || !item.title) continue;
        if (this._isSeen(item.url)) continue;
        newItems.push(item);
      }

      return newItems;
    } catch (err) {
      if (err.response?.status === 429) {
        console.warn('[GDELTAdapter] ⚠️ GDELT rate limit (429). Gracefully backing off.');
      } else {
        console.warn(`[GDELTAdapter] ⚠️ GDELT fetch notice: ${err.message}`);
      }
      return [];
    }
  }

  normalize(raw) {
    if (!raw || !raw.url || !raw.title) return null;

    let publishedAt = null;
    if (raw.seendate && raw.seendate.length >= 8) {
      try {
        const rawDate = raw.seendate.replace(/[^0-9]/g, '');
        if (rawDate.length >= 14) {
          const y = rawDate.slice(0, 4);
          const m = rawDate.slice(4, 6);
          const d = rawDate.slice(6, 8);
          const h = rawDate.slice(8, 10);
          const min = rawDate.slice(10, 12);
          const s = rawDate.slice(12, 14);
          publishedAt = new Date(`${y}-${m}-${d}T${h}:${min}:${s}Z`).toISOString();
        } else {
          const y = rawDate.slice(0, 4);
          const m = rawDate.slice(4, 6);
          const d = rawDate.slice(6, 8);
          publishedAt = new Date(`${y}-${m}-${d}T00:00:00Z`).toISOString();
        }
      } catch {
        publishedAt = new Date().toISOString();
      }
    }

    const now = new Date().toISOString();
    const domain = raw.domain || raw.sourcecountry || 'Global News Wire';

    return {
      providerArticleId: raw.url,
      provider: 'gdelt',
      publisher: domain,
      publisherDomain: raw.domain || null,
      title: raw.title.trim(),
      url: raw.url,
      canonicalUrl: raw.url,
      description: raw.title.trim(),
      content: raw.title.trim(),
      image: raw.socialimage || null,
      language: 'en',
      country: raw.sourcecountry || 'GLOBAL',
      publishedAt: publishedAt || now,
      providerAvailableAt: publishedAt || now,
      receivedAt: now,
      ingestedAt: now
    };
  }
}
