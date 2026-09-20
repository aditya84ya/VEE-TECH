import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { logTraceEvent, STAGES, maskUrlCredentials } from '../TraceLogger.js';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

const TARGET_REGEX = /(Infosys|Infosys\s+ADR|NYSE:\s*INFY|TCS|Tata\s+Consultancy|Wipro|Wipro\s+ADR|Accenture|Finacle)/i;
const MAX_ARTICLES_PER_FEED = 15;

export class GoogleRssAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'googlenews',
      displayName: 'Google News RSS (Verified Wire)',
      fetchMode: 'RSS',
      intervalMs: options.intervalMs || 12000, // 12s — Google RSS has no documented quota; tighter polling captures breaking news faster
      priority: 3
    });
    this.seenGuids = new Set();
    this.maxGuids = 1000;
  }

  _isSeenGuid(guid) {
    if (!guid) return false;
    if (this.seenGuids.has(guid)) return true;
    if (this.seenGuids.size >= this.maxGuids) {
      const oldest = this.seenGuids.values().next().value;
      if (oldest) this.seenGuids.delete(oldest);
    }
    this.seenGuids.add(guid);
    return false;
  }

  buildUrls() {
    const cb = Date.now();
    const qNational = encodeURIComponent(
      '(Infosys OR "Infosys ADR" OR "NYSE: INFY" OR TCS OR "Tata Consultancy Services" OR Wipro OR "Wipro ADR" OR Accenture OR Finacle)'
    );
    const qRegional = encodeURIComponent(
      '(Infosys OR TCS OR Wipro OR Accenture) (Kerala OR Kochi OR Trivandrum OR Bengaluru OR Mumbai OR Delhi)'
    );
    return [
      { name: 'Google News National Wire', url: `https://news.google.com/rss/search?q=${qNational}&hl=en-IN&gl=IN&ceid=IN:en&_cb=${cb}` },
      { name: 'Google News Regional Hubs', url: `https://news.google.com/rss/search?q=${qRegional}&hl=en-IN&gl=IN&ceid=IN:en&_cb=${cb + 1}` }
    ];
  }

  async fetch(opts = {}) {
    const traceId = opts.traceId || `tr_googlenews_${Date.now()}`;
    const feedConfigs = this.buildUrls();

    logTraceEvent({
      stage: STAGES.HTTP_REQUEST_START,
      traceId,
      provider: 'googlenews',
      extra: { queryCount: feedConfigs.length, rssStage: 'RSS_REQUEST_START' }
    });

    const reqStart = Date.now();
    const results = await Promise.allSettled(
      feedConfigs.map(cfg =>
        axios.get(cfg.url, {
          timeout: 8000,
          httpAgent,
          httpsAgent,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
          }
        })
      )
    );

    const reqDuration = Date.now() - reqStart;
    const freshItems = [];
    let seenGuidCount = 0;
    let nonTargetCount = 0;
    let totalItems = 0;
    let totalBytes = 0;
    let successfulFeeds = 0;

    for (const res of results) {
      if (res.status !== 'fulfilled' || !res.value?.data) continue;
      successfulFeeds++;
      const rawXml = typeof res.value.data === 'string' ? res.value.data : JSON.stringify(res.value.data || '');
      totalBytes += rawXml.length;
      const $ = cheerio.load(rawXml, { xmlMode: true });
      const items = $('item').toArray().slice(0, MAX_ARTICLES_PER_FEED);
      totalItems += items.length;

      for (const el of items) {
        const title = $(el).find('title').text().trim();
        const link = $(el).find('link').text().trim();
        const guid = $(el).find('guid').text().trim() || link;
        const pubDate = $(el).find('pubDate').text().trim();
        const rawDesc = $(el).find('description').text();
        const sourceEl = $(el).find('source');
        const sourceName = sourceEl.text().trim() || 'Google News';
        const publisherUrl = sourceEl.attr('url') || '';

        if (!title || !link) continue;
        if (this._isSeenGuid(guid)) {
          seenGuidCount++;
          continue;
        }
        if (!TARGET_REGEX.test(title) && !TARGET_REGEX.test(rawDesc)) {
          nonTargetCount++;
          continue;
        }

        let imageUrl = null;
        if (rawDesc) {
          try {
            const $desc = cheerio.load(rawDesc);
            imageUrl = $desc('img').attr('src') || null;
          } catch {}
        }

        freshItems.push({
          guid,
          title,
          link,
          pubDate,
          rawDesc,
          sourceName,
          publisherUrl,
          imageUrl
        });
      }
    }

    logTraceEvent({
      stage: STAGES.HTTP_RESPONSE,
      traceId,
      provider: 'googlenews',
      durationMs: reqDuration,
      extra: {
        rssStage: 'RSS_RESPONSE',
        successfulFeeds,
        bytes: totalBytes,
        items: totalItems,
        fresh: freshItems.length,
        duplicates: seenGuidCount,
        nonTarget: nonTargetCount
      }
    });

    console.log(`[GoogleRSS:TwinFeeds]
successfulFeeds=${successfulFeeds}/${feedConfigs.length}
items=${totalItems}
duplicates=${seenGuidCount}
accepted=${freshItems.length}`);

    return {
      items: freshItems,
      stats: {
        rawCount: totalItems,
        duplicateCount: seenGuidCount,
        staleCount: 0
      }
    };
  }

  normalize(raw) {
    if (!raw || !raw.title || !raw.link) return null;

    let publishedAt = null;
    if (raw.pubDate) {
      const d = new Date(raw.pubDate);
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    const now = new Date().toISOString();

    const providerArticleId = raw.guid || raw.link;
    const sourceUrl = raw.link; // Google News RSS wrapper URL
    const publisherUrl = raw.publisherUrl || ''; // Actual publisher domain/url when available

    // Canonical publisher URL: preserve actual Google News RSS link which handles redirection cleanly
    const canonicalUrl = raw.link;

    return {
      providerArticleId,
      provider: 'googlenews',
      publisher: raw.sourceName || 'Google News RSS',
      publisherDomain: publisherUrl ? new URL(publisherUrl).hostname : 'news.google.com',
      title: raw.title,
      url: sourceUrl,
      sourceUrl,
      publisherUrl,
      canonicalUrl,
      description: raw.rawDesc ? cheerio.load(raw.rawDesc).text().trim() : null,
      content: raw.rawDesc ? cheerio.load(raw.rawDesc).text().trim() : raw.title,
      image: raw.imageUrl || null,
      language: 'en',
      country: 'IN',
      publishedAt,
      providerAvailableAt: null, // Syndication proxy
      receivedAt: now,
      ingestedAt: now
    };
  }
}
