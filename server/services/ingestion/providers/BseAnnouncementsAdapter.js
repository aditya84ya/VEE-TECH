import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { logTraceEvent, STAGES, maskUrlCredentials } from '../TraceLogger.js';

const TARGET_SCRIP_CODES = new Set(['500209', '532540', '507685']);
const TARGET_REGEX = /\b(Infosys|Infosys\s+ADR|NYSE:\s*INFY|500209|TCS|Tata\s+Consultancy|532540|Wipro|Wipro\s+ADR|507685|Accenture|Finacle)\b/i;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

const BSE_FEED_URL = 'https://www.bseindia.com/data/xml/announcements.xml';

export class BseAnnouncementsAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'bse',
      displayName: 'BSE India Corporate Announcements (Origin Wire)',
      fetchMode: 'RSS',
      intervalMs: options.intervalMs || 15000, // 15s polling for origin filings
      priority: 1
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

  async fetch(opts = {}) {
    const traceId = opts.traceId || `tr_bse_${Date.now()}`;
    const maskedUrl = maskUrlCredentials(BSE_FEED_URL);

    logTraceEvent({
      stage: STAGES.HTTP_REQUEST_START,
      traceId,
      provider: 'bse',
      extra: { url: maskedUrl, rssStage: 'BSE_REQUEST_START' }
    });

    const reqStart = Date.now();
    let res = null;
    try {
      res = await axios.get(BSE_FEED_URL, {
        timeout: 8000,
        httpAgent,
        httpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Referer': 'https://www.bseindia.com/',
          'Accept': 'application/xml, text/xml, */*'
        }
      });
    } catch (err) {
      const reqDuration = Date.now() - reqStart;
      logTraceEvent({
        stage: STAGES.HTTP_ERROR,
        traceId,
        provider: 'bse',
        durationMs: reqDuration,
        status: err.response?.status || null,
        reason: err.message
      });
      throw err;
    }

    const reqDuration = Date.now() - reqStart;
    const rawXml = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
    const $ = cheerio.load(rawXml, { xmlMode: true });
    const items = $('item').toArray();
    const freshItems = [];
    let seenGuidCount = 0;
    let nonTargetCount = 0;

    for (const el of items) {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const scripcode = $(el).find('scripcode').text().trim();
      const description = $(el).find('description').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const guid = link || `${scripcode}_${pubDate}`;

      if (!title || !link) continue;

      if (this._isSeenGuid(guid)) {
        seenGuidCount++;
        continue;
      }

      // Check whether it matches target scripcode or target keywords
      const isTargetScrip = TARGET_SCRIP_CODES.has(scripcode);
      const isTargetKeyword = TARGET_REGEX.test(title) || TARGET_REGEX.test(description);

      if (!isTargetScrip && !isTargetKeyword) {
        nonTargetCount++;
        continue;
      }

      const attachmentName = $(el).find('attachmentname, attachment_name, attachment, AttachmentName').text().trim();
      const pdfUrl = attachmentName
        ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${attachmentName}`
        : (link.toLowerCase().endsWith('.pdf') ? link : null);

      freshItems.push({
        guid,
        title,
        link,
        scripcode,
        description,
        pubDate,
        pdfUrl
      });
    }

    logTraceEvent({
      stage: STAGES.HTTP_RESPONSE,
      traceId,
      provider: 'bse',
      durationMs: reqDuration,
      extra: {
        rssStage: 'BSE_RESPONSE',
        status: res.status,
        bytes: rawXml.length,
        items: items.length,
        fresh: freshItems.length,
        duplicates: seenGuidCount,
        nonTarget: nonTargetCount
      }
    });

    return {
      items: freshItems,
      stats: {
        rawCount: items.length,
        duplicateCount: seenGuidCount,
        staleCount: 0
      }
    };
  }

  normalize(raw) {
    if (!raw || !raw.title || !raw.link) return null;

    let publishedAt = null;
    if (raw.pubDate) {
      // Handles format like "20-Sep-2026 11:43:02" or standard RFC dates
      const d = new Date(raw.pubDate);
      if (!isNaN(d.getTime())) {
        publishedAt = d.toISOString();
      } else {
        // Fallback for custom format "DD-MMM-YYYY HH:mm:ss"
        try {
          const parts = raw.pubDate.split(/[\s-:]+/);
          if (parts.length >= 6) {
            const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
            const m = months[parts[1].toLowerCase()] ?? 0;
            const parsedD = new Date(Date.UTC(+parts[2], m, +parts[0], +parts[3], +parts[4], +parts[5]));
            if (!isNaN(parsedD.getTime())) publishedAt = parsedD.toISOString();
          }
        } catch (_) {}
      }
    }

    const now = new Date().toISOString();
    const providerArticleId = raw.guid || raw.link;

    return {
      providerArticleId,
      provider: 'bse',
      publisher: 'BSE India (Corporate Disclosures)',
      publisherDomain: 'bseindia.com',
      title: `[BSE Filing] ${raw.title}: ${raw.description || 'Regulatory disclosure'}`,
      url: raw.link,
      sourceUrl: raw.link,
      publisherUrl: 'https://www.bseindia.com/corporates/ann.html',
      canonicalUrl: raw.link,
      description: raw.description || raw.title,
      content: `${raw.title} (Scrip: ${raw.scripcode || 'N/A'})\n\nFiling Summary: ${raw.description}\n\nOfficial Exchange Filing PDF: ${raw.pdfUrl || raw.link}`,
      image: null,
      mediaUrl: raw.pdfUrl || (raw.link?.toLowerCase().endsWith('.pdf') ? raw.link : null),
      pdfUrl: raw.pdfUrl || (raw.link?.toLowerCase().endsWith('.pdf') ? raw.link : null),
      language: 'en',
      country: 'IN',
      publishedAt: publishedAt || now,
      providerAvailableAt: publishedAt || now, // Origin source has zero syndication lag
      receivedAt: now,
      ingestedAt: now
    };
  }
}
