/**
 * EpaperOcrAdapter.js
 *
 * Ingests publicly accessible e-paper front pages and image URLs
 * via Tesseract.js OCR, extracts text, applies the same entity/keyword
 * guardrails as all other adapters, and emits normalized articles into
 * the existing triage pipeline.
 *
 * SCOPE GUARDRAIL: Only fetches sources that are PUBLICLY accessible
 * without a login or paywall bypass.  If a candidate URL returns a 4xx/5xx
 * or a login-wall redirect, the adapter flags it and skips -- it does NOT
 * attempt authentication or headless-browser scraping.
 *
 * PDF SUPPORT: Requires pdf-img-convert which depends on the canvas native
 * module. If canvas is not compilable on this platform, PDF pages are skipped
 * gracefully with a warning -- no crash.
 */

import https from 'node:https';
import http from 'node:http';
import { createWorker } from 'tesseract.js';
import axios from 'axios';
import crypto from 'node:crypto';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { logTraceEvent, STAGES } from '../TraceLogger.js';
import { evaluateThreatSeverity } from '../../threatScorer.js';

// Try to load pdf-img-convert; degrade gracefully if canvas is missing
let pdfImgConvert = null;
try {
  const mod = await import('pdf-img-convert');
  pdfImgConvert = mod.default || mod;
  console.log('[EpaperOCR] pdf-img-convert loaded -- PDF ingestion enabled.');
} catch (_) {
  console.warn('[EpaperOCR] pdf-img-convert unavailable (canvas not compiled) -- PDF ingestion disabled.');
}

const TARGET_REGEX =
  /\b(Infosys|Infosys\s+ADR|NYSE:\s*INFY|TCS|Tata\s+Consultancy|Wipro|Wipro\s+ADR|Accenture|Finacle|SEBI|BSE|NSE)\b/i;

const TRACKED_TARGETS = ['Infosys', 'TCS', 'Wipro', 'Accenture', 'Finacle', 'SEBI', 'BSE', 'NSE'];

const MIN_CONFIDENCE = 45;
const MAX_CACHE_AGE_MS = 120 * 60 * 1000; // 2 hours

// Default publicly accessible e-paper image endpoints
const DEFAULT_SOURCES = [
  {
    name: 'Economic Times E-Paper',
    url: 'https://epaper.economictimes.com/GetPage.aspx?edition=TOIM&sessionid=0&pageid=1',
    type: 'image'
  },
  {
    name: 'Mint E-Paper',
    url: 'https://epaper.livemint.com/GetPage.aspx?edition=DLMN&sessionid=0&pageid=1',
    type: 'image'
  },
  {
    name: 'Business Standard E-Paper',
    url: 'https://epaper.business-standard.com/GetPage.aspx?edition=TOIM&sessionid=0&pageid=1',
    type: 'image'
  }
];

const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 4 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

function isValidImageBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 12) return false;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WebP: RIFF ... WEBP
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4D) return true;
  // TIFF
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
      (buf[0] === 0x4D && buf[1] === 0x4D && buf[0] === 0x00 && buf[3] === 0x2A)) return true;
  return false;
}

function contentHash(text) {
  return crypto.createHash('sha1').update(text.slice(0, 512)).digest('hex');
}

function detectMatchedTarget(text) {
  for (const t of TRACKED_TARGETS) {
    if (new RegExp('\\b' + t + '\\b', 'i').test(text)) return t;
  }
  return null;
}

export class EpaperOcrAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'epaper_ocr',
      displayName:  'E-Paper / Image OCR Ingestion',
      fetchMode:    'POLL',
      intervalMs:   options.intervalMs    || 5 * 60 * 1000,
      priority:     3
    });

    this.sources       = options.sources       || DEFAULT_SOURCES;
    this.minConfidence = options.minConfidence  ?? MIN_CONFIDENCE;
    this._cache        = new Map();
    this._worker       = null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onStart() {
    console.log('[EpaperOCR] Initialising Tesseract.js worker (eng)...');
    try {
      this._worker = await createWorker('eng', 1, { logger: () => {} });
      console.log('[EpaperOCR] Tesseract worker ready.');
    } catch (err) {
      console.error('[EpaperOCR] Failed to init Tesseract worker:', err.message);
      this._worker = null;
    }
  }

  async onStop() {
    if (this._worker) {
      try { await this._worker.terminate(); } catch (_) {}
      this._worker = null;
    }
    console.log('[EpaperOCR] Tesseract worker terminated.');
  }

  // ─── Core Polling Fetch ────────────────────────────────────────────────────

  async fetch(opts = {}) {
    const traceId = opts.traceId || ('tr_epaper_' + Date.now());

    if (!this._worker) {
      logTraceEvent({ stage: STAGES.HTTP_REQUEST_START, traceId, provider: 'epaper_ocr',
        extra: { note: 'Tesseract worker not ready - skipping cycle' } });
      return { items: [], stats: { rawCount: 0, duplicateCount: 0, staleCount: 0 } };
    }

    logTraceEvent({ stage: STAGES.HTTP_REQUEST_START, traceId, provider: 'epaper_ocr',
      extra: { sourceCount: this.sources.length } });

    const reqStart    = Date.now();
    const freshItems  = [];
    let totalAttempts = 0;
    let skipCount     = 0;
    let errorCount    = 0;

    for (const source of this.sources) {
      totalAttempts++;
      try {
        const results = await this._processSource(source, traceId);
        if (results && results.length > 0) {
          freshItems.push(...results);
        } else {
          skipCount++;
        }
      } catch (err) {
        errorCount++;
        console.warn('[EpaperOCR] Error processing "' + source.name + '": ' + err.message);
      }
    }

    const durationMs = Date.now() - reqStart;
    logTraceEvent({ stage: STAGES.HTTP_RESPONSE, traceId, provider: 'epaper_ocr',
      durationMs, extra: { totalAttempts, fresh: freshItems.length, skipped: skipCount, errors: errorCount } });

    console.log('[EpaperOCR] sources=' + totalAttempts + ' accepted=' + freshItems.length +
      ' skipped=' + skipCount + ' errors=' + errorCount + ' durationMs=' + durationMs);

    return {
      items: freshItems,
      stats: { rawCount: totalAttempts, duplicateCount: skipCount, staleCount: 0 }
    };
  }

  // ─── Per-Source Processing ──────────────────────────────────────────────────

  /**
   * Downloads and OCRs a single source. Returns an array of raw items
   * (multiple items for PDFs with multiple pages, single-element for images).
   *
   * @param {{name:string, url:string, type:'image'|'pdf'}} source
   * @param {string} traceId
   * @returns {Promise<object[]>}
   */
  async _processSource(source, traceId) {
    const { name, url, type } = source;

    // 1. Download (paywall/access check)
    let buffer;
    let contentType;
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxRedirects: 5,
        httpAgent,
        httpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'image/webp,image/png,image/jpeg,application/pdf,*/*'
        },
        validateStatus: (status) => status >= 200 && status < 300
      });
      buffer = Buffer.from(response.data);
      contentType = (response.headers['content-type'] || '').toLowerCase();
    } catch (err) {
      if (err.response && err.response.status >= 400 && err.response.status < 500) {
        console.warn('[EpaperOCR] SOURCE BLOCKED "' + name + '" (HTTP ' + err.response.status +
          ') - URL requires login/paywall. Skipping without bypass attempt.');
        return [];
      }
      throw err;
    }

    // 2. PDF branch
    if (type === 'pdf' || contentType.includes('pdf')) {
      return this._processPdfBuffer(buffer, url, name);
    }

    // 3. Image branch: validate buffer is a genuine image before OCR
    if (!isValidImageBuffer(buffer)) {
      console.warn('[EpaperOCR] Source "' + name + '" returned non-image payload (contentType: ' + contentType + '). Skipping.');
      return [];
    }

    const result = await this._extractAndEmit(buffer, url, { sourceName: name });
    return result ? [result] : [];
  }

  // ─── PDF Processing ─────────────────────────────────────────────────────────

  async _processPdfBuffer(pdfBuffer, sourceUrl, sourceName) {
    if (!pdfImgConvert) {
      console.warn('[EpaperOCR] PDF processing skipped for "' + sourceName + '" -- pdf-img-convert not available.');
      return [];
    }
    try {
      const pages = await pdfImgConvert.convert(pdfBuffer, { width: 1200 });
      const results = [];
      for (let i = 0; i < Math.min(pages.length, 3); i++) {
        const item = await this._extractAndEmit(pages[i], sourceUrl, {
          sourceName: sourceName + ' (p.' + (i + 1) + ')',
          page: i + 1
        });
        if (item) results.push(item);
      }
      return results;
    } catch (err) {
      console.warn('[EpaperOCR] PDF page conversion error for "' + sourceName + '": ' + err.message);
      return [];
    }
  }

  // ─── Core OCR + Guardrail Pipeline ─────────────────────────────────────────

  /**
   * Core OCR + guardrail pipeline for a single image (Buffer or URL string).
   * Returns a raw item or null.
   *
   * @param {Buffer|string} imageSource  Buffer or URL string accepted by Tesseract
   * @param {string} originalSourceUrl  Original image/PDF URL (used for dedup & source link)
   * @param {{sourceName?:string, page?:number, publishedAt?:string}} meta
   * @returns {Promise<object|null>}
   */
  async _extractAndEmit(imageSource, originalSourceUrl, meta = {}) {
    await this._ensureWorker();
    if (!this._worker) return null;

    // Content-hash deduplication (skip unchanged images)
    if (Buffer.isBuffer(imageSource) && !isValidImageBuffer(imageSource)) {
      console.warn('[EpaperOCR] Invalid image buffer passed to _extractAndEmit. Skipping.');
      return null;
    }
    const cacheKey = originalSourceUrl + (meta.page ? '_p' + meta.page : '');
    const hashInput = Buffer.isBuffer(imageSource) ? imageSource.toString('base64') : imageSource;
    const hash = contentHash(hashInput);
    const cached = this._cache.get(cacheKey);
    if (cached && cached.hash === hash && (Date.now() - cached.processedAt) < MAX_CACHE_AGE_MS) {
      return null; // Unchanged -- skip
    }

    // OCR
    const ocrStart = Date.now();
    let ocrText    = '';
    let confidence = 0;
    try {
      const { data } = await this._worker.recognize(imageSource);
      ocrText    = (data.text || '').trim();
      confidence = data.confidence ?? 0;
    } catch (ocrErr) {
      console.warn('[EpaperOCR] OCR failed: ' + ocrErr.message);
      try { await this._worker.terminate(); } catch (_) {}
      this._worker = null;
      return null;
    }
    const ocrMs = Date.now() - ocrStart;
    console.log('[EpaperOCR] "' + (meta.sourceName || 'source') + '" OCR done - confidence=' + confidence.toFixed(1) +
      '% chars=' + ocrText.length + ' ms=' + ocrMs);

    // Guardrail 1: min text length (must have at least a target entity name length)
    if (!ocrText || ocrText.length < 5) {
      console.log('[EpaperOCR] EXTRACTION FAILED -- Insufficient text (' + ocrText.length + ' chars). Skipping.');
      return null;
    }

    // Low confidence warning (do NOT drop -- still useful if entity matches)
    if (confidence < 60) {
      console.warn('[EpaperOCR] LOW CONFIDENCE (' + confidence.toFixed(1) + '%) -- text may be noisy.');
    }

    // Hard confidence gate
    if (confidence < this.minConfidence) {
      console.warn('[EpaperOCR] Below minimum confidence threshold (' + confidence.toFixed(1) + '% < ' + this.minConfidence + '%) -- discarding.');
      return null;
    }

    // Guardrail 2: entity/keyword relevance
    const matchedTarget = detectMatchedTarget(ocrText);
    if (!matchedTarget) {
      console.log('[EpaperOCR] Dropped: No tracked entities found in extracted text.');
      this._cache.set(cacheKey, { hash, processedAt: Date.now() });
      return null;
    }

    // Cache update
    this._cache.set(cacheKey, { hash, processedAt: Date.now() });

    // Synthetic headline from first substantial line containing words
    const lines = ocrText.split('\n').map(l => l.trim()).filter(l => l.length >= 3);
    const title = lines[0]
      ? (lines[0].length < 15 ? `[OCR Scanned] ${lines.slice(0, 2).join(' ')}` : lines[0].substring(0, 140))
      : ('[E-Paper] Scanned report regarding ' + matchedTarget);

    // Threat severity
    const threat = evaluateThreatSeverity(title, ocrText, matchedTarget);

    // Stable content hash for deduplication in IngestionGateway
    const articleHashInput = originalSourceUrl + (meta.page ? '_p' + meta.page : '') + ocrText.substring(0, 100);
    const articleId = 'epaper_' + crypto.createHash('sha256').update(articleHashInput).digest('hex').substring(0, 24);

    console.log('[EpaperOCR] Emitting article for ' + matchedTarget + ' (Confidence: ' + confidence.toFixed(0) + '% | Threat: ' + threat.severity + ')');

    const webLink = meta.sourceUrl || meta.postUrl || originalSourceUrl;

    return {
      guid:          articleId,
      title,
      link:          webLink,
      sourceUrl:     webLink,
      imageUrl:      originalSourceUrl,
      mediaUrl:      originalSourceUrl,
      pubDate:       meta.publishedAt || new Date().toISOString(),
      ocrText,
      confidence,
      sourceName:    meta.sourceName || 'E-Paper OCR',
      ocrDurationMs: ocrMs,
      matchedTarget,
      threat,
      page:          meta.page || 1,
      isLowConfidence: confidence < 60,
      metadata: {
        original_media_url: originalSourceUrl,
        ocr_confidence: confidence
      }
    };
  }

  async _ensureWorker() {
    if (!this._worker) {
      try {
        this._worker = await createWorker('eng', 1, { logger: () => {} });
      } catch (_) {}
    }
  }

  // ─── Normalize ─────────────────────────────────────────────────────────────

  normalize(raw) {
    if (!raw || !raw.title || !raw.link) return null;
    const now = new Date().toISOString();
    return {
      providerArticleId: raw.guid,
      provider:          'epaper_ocr',
      publisher:         raw.sourceName || 'E-Paper OCR',
      publisherDomain:   'epaper',
      title:             raw.title,
      url:               raw.link,
      sourceUrl:         raw.link,
      publisherUrl:      raw.link,
      canonicalUrl:      raw.link,
      description:       raw.ocrText ? raw.ocrText.slice(0, 500) : raw.title,
      content:           raw.ocrText || raw.title,
      image:             raw.imageUrl || raw.mediaUrl || null,
      mediaUrl:          raw.mediaUrl || raw.imageUrl || null,
      language:          'en',
      country:           'IN',
      publishedAt:          raw.pubDate || now,
      providerAvailableAt:  null,
      receivedAt:           now,
      ingestedAt:           now,
      // OCR metadata -- passed through to the article payload for UI badge
      ocrConfidence:    raw.confidence,
      ocrDurationMs:    raw.ocrDurationMs,
      isLowConfidence:  raw.isLowConfidence,
      matchedTarget:    raw.matchedTarget,
      metadata: {
        original_media_url: raw.mediaUrl || raw.imageUrl || null,
        ocr_confidence: raw.confidence
      }
    };
  }

  // ─── Public API: processMediaUrl (on-demand from Bluesky or API route) ──────

  /**
   * Master entry point for on-demand image or PDF ingestion.
   * Mirrors the architecture in the specification exactly.
   *
   * @param {string} mediaUrl  Publicly accessible image or PDF URL
   * @param {{sourceName?:string, publishedAt?:string, mimeType?:string, page?:number}} meta
   * @returns {Promise<object|null>}  The normalized article or null if dropped
   */
  async processMediaUrl(mediaUrl, meta = {}) {
    await this._ensureWorker();
    if (!this._worker) {
      console.warn('[EpaperOCR] Tesseract worker not ready -- call start() first or wait for onStart()');
      return null;
    }

    try {
      const isPdf = mediaUrl.toLowerCase().endsWith('.pdf') || meta.mimeType === 'application/pdf';

      if (isPdf) {
        if (!pdfImgConvert) {
          console.warn('[EpaperOCR] PDF processing requested but pdf-img-convert not available. Skipping.');
          return null;
        }
        const response = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 25000, httpAgent, httpsAgent });
        const pdfBuffer = Buffer.from(response.data);
        const results = await this._processPdfBuffer(pdfBuffer, mediaUrl, meta.sourceName || 'PDF OCR');
        if (results.length === 0) return null;
        // Emit all pages and return the first
        for (const raw of results) {
          const normalizedItem = this.normalize(raw);
          if (normalizedItem) this.emit('article', normalizedItem);
        }
        return this.normalize(results[0]);
      } else {
        // Image: download arraybuffer safely via axios first
        let imgBuffer;
        try {
          const response = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            timeout: 20000,
            maxRedirects: 5,
            httpAgent,
            httpsAgent,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              Accept: 'image/webp,image/png,image/jpeg,*/*'
            },
            validateStatus: (status) => status >= 200 && status < 300
          });
          imgBuffer = Buffer.from(response.data);
        } catch (downloadErr) {
          if (downloadErr.response && downloadErr.response.status >= 400 && downloadErr.response.status < 500) {
            console.warn('[EpaperOCR] Media URL blocked or paywalled (HTTP ' + downloadErr.response.status + ') for "' + mediaUrl + '" - skipping.');
            return null;
          }
          console.error('[EpaperOCR] Failed to download media URL "' + mediaUrl + '": ' + downloadErr.message);
          return null;
        }

        if (!isValidImageBuffer(imgBuffer)) {
          console.warn('[EpaperOCR] Downloaded media is not a recognized image format for "' + mediaUrl + '". Skipping.');
          return null;
        }

        const raw = await this._extractAndEmit(imgBuffer, mediaUrl, meta);
        if (!raw) return null;
        const normalizedItem = this.normalize(raw);
        if (normalizedItem) this.emit('article', normalizedItem);
        return normalizedItem;
      }
    } catch (err) {
      console.error('[EpaperOCR] processMediaUrl error for "' + mediaUrl + '": ' + err.message);
      return null;
    }
  }

  /**
   * Backward-compat alias used by older ad-hoc callers.
   */
  async ingestImageUrl(imageUrl, sourceName = 'Ad-hoc Image OCR') {
    return this.processMediaUrl(imageUrl, { sourceName });
  }
}
