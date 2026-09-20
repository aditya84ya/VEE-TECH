import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { logTraceEvent, STAGES, maskUrlCredentials } from '../TraceLogger.js';

const TARGET_REGEX = /(Infosys|Infosys\s+ADR|NYSE:\s*INFY|TCS|Tata\s+Consultancy|Wipro|Wipro\s+ADR|Accenture|Finacle)/i;

const FEEDS = [
  // Direct Regulators & Regulatory Wires (Origin Level)
  { name: 'Reserve Bank of India (RBI Press Releases)', url: 'https://rbi.org.in/pressreleases_rss.xml' },
  { name: 'Securities and Exchange Board of India (SEBI Wires)', url: 'https://www.sebi.gov.in/sebirss.xml' },
  { name: 'Bar & Bench (Indian Legal News)', url: 'https://www.barandbench.com/feed' },
  { name: 'PR Newswire (Corporate Press Releases)', url: 'https://www.prnewswire.com/rss/news-releases-list.rss' },

  // National Institutional Wires
  { name: 'The Hindu National', url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { name: 'The Hindu Business', url: 'https://www.thehindu.com/business/feeder/default.rss' },
  { name: 'The Hindu Business Line', url: 'https://www.thehindubusinessline.com/news/feeder/default.rss' },
  { name: 'The Economic Times Tech', url: 'https://economictimes.indiatimes.com/tech/ites/rssfeeds/13357555.cms' },
  { name: 'The Economic Times Top Stories', url: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms' },
  { name: 'Livemint Companies', url: 'https://www.livemint.com/rss/companies' },
  { name: 'Livemint News', url: 'https://www.livemint.com/rss/news' },
  { name: 'Business Standard Companies', url: 'https://www.business-standard.com/rss/companies-101.rss' },
  { name: 'Business Standard Latest', url: 'https://www.business-standard.com/rss/latest.rss' },
  { name: 'Times of India', url: 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms' },

  // Regional & Hub News
  { name: 'Onmanorama Kerala', url: 'https://www.onmanorama.com/kerala.feeds.onmrss.xml' },
  { name: 'Onmanorama Business', url: 'https://www.onmanorama.com/news/business.feeds.onmrss.xml' },
  { name: 'Assam Tribune (North East)', url: 'https://assamtribune.com/feed' },
  { name: 'Millennium Post (Delhi / Kolkata)', url: 'https://www.millenniumpost.in/feed' },

  // Tech & Market Media
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
  { name: 'NDTV Profit', url: 'https://feeds.feedburner.com/ndtvprofit-latest' },
  { name: 'YourStory', url: 'https://yourstory.com/feed' }
];

const MAX_ITEMS_PER_FEED = 30;
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

export class InstitutionalRssAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'institutional',
      displayName: 'Institutional Publisher Wires (ET, Mint, BS)',
      fetchMode: 'RSS',
      intervalMs: options.intervalMs || 30000,
      priority: 3
    });
    this.seenGuids = new Set();
  }

  _isSeen(guid) {
    if (!guid) return false;
    if (this.seenGuids.has(guid)) return true;
    if (this.seenGuids.size >= 1000) {
      const oldest = this.seenGuids.values().next().value;
      if (oldest) this.seenGuids.delete(oldest);
    }
    this.seenGuids.add(guid);
    return false;
  }

  async fetch(opts = {}) {
    const traceId = opts.traceId || `tr_institutional_${Date.now()}`;
    const PER_FEED_TIMEOUT = 12000;

    logTraceEvent({
      stage: STAGES.HTTP_REQUEST_START,
      traceId,
      provider: 'institutional',
      extra: { feedCount: FEEDS.length, concurrency: 'ALL_PARALLEL' }
    });

    const allItems = [];
    let totalRawItems = 0;
    let staleCount = 0;
    let duplicateCount = 0;
    let successfulFeeds = 0;
    const reqStart = Date.now();

    // Fire ALL feeds simultaneously — true Promise.allSettled concurrency (no batching delay)
    const allResults = await Promise.allSettled(
      FEEDS.map(async (feed) => {
        try {
          const res = await axios.get(feed.url, {
            timeout: PER_FEED_TIMEOUT,
            httpAgent,
            httpsAgent,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
            }
          });
          return { feed, data: res.data, ok: true };
        } catch (err) {
          console.warn(`[InstitutionalRss] ⚠️ ${feed.name} skipped: ${err.message}`);
          return { feed, data: null, ok: false };
        }
      })
    );

    for (const result of allResults) {
      if (result.status === 'rejected') continue;
      const { feed, data, ok } = result.value;
      if (!ok || !data) continue;
      successfulFeeds++;

      try {
        const $ = cheerio.load(data, { xmlMode: true });
        const items = $('item').toArray().slice(0, MAX_ITEMS_PER_FEED);
        totalRawItems += items.length;

        for (const el of items) {
          const title = $(el).find('title').text().trim();
          const link = $(el).find('link').text().trim();
          const guid = $(el).find('guid').text().trim() || link;
          const pubDate = $(el).find('pubDate').text().trim();
          const rawDesc = $(el).find('description').text();

          if (!title || !link) continue;
          if (this._isSeen(guid)) {
            duplicateCount++;
            continue;
          }
          if (!TARGET_REGEX.test(title) && !TARGET_REGEX.test(rawDesc)) continue;

          // Recency guardrail: Reject any item published > 48 hours ago
          if (pubDate) {
            const pubTime = new Date(pubDate).getTime();
            if (!isNaN(pubTime)) {
              const ageHours = (Date.now() - pubTime) / (3600 * 1000);
              if (ageHours > 48) {
                staleCount++;
                const ageDesc = `${(ageHours / 24).toFixed(1)} days`;
                console.log(`[InstitutionalRss] 🚫 DROPPED STALE: "${title.slice(0, 50)}..." (published ${ageDesc} ago exceeds 48h syndication window)`);
                continue;
              }
            }
          }

          allItems.push({ guid, title, link, pubDate, rawDesc, sourceName: feed.name });
        }
      } catch (err) {
        console.warn(`[InstitutionalRss] ⚠️ Error parsing ${feed.name}: ${err.message}`);
      }
    }

    const duration = Date.now() - reqStart;
    logTraceEvent({
      stage: STAGES.HTTP_RESPONSE,
      traceId,
      provider: 'institutional',
      durationMs: duration,
      extra: {
        successfulFeeds,
        items: totalRawItems,
        stale: staleCount,
        duplicates: duplicateCount,
        accepted: allItems.length
      }
    });

    console.log(`[InstitutionalRSS]
HTTP 200
items=${totalRawItems}
stale=${staleCount}
duplicates=${duplicateCount}
accepted=${allItems.length}`);

    return {
      items: allItems,
      stats: {
        rawCount: totalRawItems,
        staleCount,
        duplicateCount
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

    let publisherDomain = 'institutional-rss.com';
    try {
      publisherDomain = new URL(raw.link).hostname;
    } catch {}

    const cleanDesc = raw.rawDesc ? cheerio.load(raw.rawDesc).text().trim() : null;

    return {
      providerArticleId: raw.guid || raw.link,
      provider: 'institutional',
      publisher: raw.sourceName || 'Institutional RSS Wire',
      publisherDomain,
      title: raw.title,
      url: raw.link,
      canonicalUrl: raw.link,
      description: cleanDesc,
      content: cleanDesc || raw.title,
      image: null,
      language: 'en',
      country: 'IN',
      publishedAt,
      providerAvailableAt: null, // Syndication proxy
      receivedAt: now,
      ingestedAt: now
    };
  }
}
