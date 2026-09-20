import { createHash, randomUUID } from 'node:crypto';

function calculateStringSimilarity(str1, str2) {
  const s1 = (str1 || '').toLowerCase().trim();
  const s2 = (str2 || '').toLowerCase().trim();
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const words1 = s1.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  const words2 = s2.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  const set1 = new Set(words1);
  const set2 = new Set(words2);

  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  if (union.size === 0) return 0.0;
  return Number((intersection.size / union.size).toFixed(3));
}

/**
 * Multi-Layer Deduplication & Story Clustering Engine
 *
 * Implements 5 distinct deduplication layers to reject true duplicates,
 * cluster multi-publisher coverage of the same real-world story,
 * and calculate Source Corroboration metrics.
 */
export class Deduplicator {
  constructor(options = {}) {
    this.maxMemoryItems = options.maxMemoryItems || 5000;
    this.ttlMs = options.ttlMs || (2 * 60 * 60 * 1000); // 2 hours rolling TTL (warroom-wire pattern)

    // Deduplication caches
    this.seenIds = new Set();
    this.seenCanonicalUrls = new Set();
    this.seenNormalizedUrls = new Set();
    this.seenTitleSourceFingerprints = new Map(); // fingerprint -> { articleId, timestamp, title, publisher }

    // Story Clustering caches (clusterId -> cluster metadata)
    this.storyClusters = new Map();
    this.duplicateAuditTrail = []; // Stores the last 500 duplicate decisions for auditing
  }

  /**
   * Hydrates memory caches from database records on startup
   */
  hydrateFromRecords(records = []) {
    for (const r of records) {
      if (r.id) this.seenIds.add(String(r.id));
      if (r.url) {
        const norm = this.normalizeUrl(r.url);
        if (norm) this.seenNormalizedUrls.add(norm);
        const canon = this.canonicalUrl(r.url);
        if (canon) this.seenCanonicalUrls.add(canon);
      }
      if (r.title) {
        const fp = this.computeTitleSourceFingerprint(r.title, r.source_name || r.publisher);
        this.seenTitleSourceFingerprints.set(fp, { articleId: r.id, timestamp: Date.now(), title: r.title, publisher: r.source_name });
      }
    }
    console.log(`[Deduplicator] ✅ Hydrated deduplication caches: ${this.seenIds.size} IDs, ${this.seenNormalizedUrls.size} URLs, ${this.seenTitleSourceFingerprints.size} fingerprints.`);
  }

  /**
   * Normalizes URLs by removing tracking query parameters (utm_*, ref, etc.)
   */
  normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    try {
      const parsed = new URL(rawUrl.trim());
      const stripParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'oc', 'fbclid', '_cb'];
      stripParams.forEach(p => parsed.searchParams.delete(p));
      return parsed.origin + parsed.pathname + (parsed.search ? parsed.search : '');
    } catch {
      return rawUrl.trim().toLowerCase();
    }
  }

  /**
   * Canonical URL: domain + path (without search query or hash)
   */
  canonicalUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    try {
      const parsed = new URL(rawUrl.trim());
      return (parsed.hostname.replace(/^www\./, '') + parsed.pathname.replace(/\/$/, '')).toLowerCase();
    } catch {
      return rawUrl.trim().toLowerCase();
    }
  }

  /**
   * Computes a strong Title + Publisher fingerprint.
   * Strips non-alphanumeric noise, lowercases, and creates SHA-256 hash.
   */
  computeTitleSourceFingerprint(title, publisher) {
    const cleanTitle = String(title || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const cleanPub = String(publisher || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .trim();

    return createHash('sha256')
      .update(`${cleanTitle}::${cleanPub}`)
      .digest('hex');
  }

  /**
   * Evaluates an incoming article through the 5 deduplication layers
   * and links it to a Story Cluster if it represents multi-publisher coverage.
   *
   * @param {object} article Normalized article
   * @returns {{
   *   isDuplicate: boolean,
   *   dedupDecision: 'ALLOWED' | 'DROPPED',
   *   dedupLayer: string | null,
   *   dedupReason: string,
   *   duplicateOf: string | null,
   *   duplicateStatus: 'UNIQUE' | 'EXACT_DUPLICATE' | 'POSSIBLE_DUPLICATE',
   *   storyClusterId: string,
   *   sourceCount: number,
   *   uniquePublisherCount: number,
   *   uniqueProviderCount: number
   * }}
   */
  evaluate(article) {
    const {
      articleId,
      id,
      providerArticleId,
      url,
      canonicalUrl,
      sourceUrl,
      publisherUrl,
      title,
      publisher,
      source_name,
      provider,
      api_source
    } = article;

    const effectiveId = providerArticleId || articleId || id;
    const pubName = publisher || source_name || 'Verified News Wire';
    const providerName = provider || api_source || 'Wire';

    // LAYER 1: Provider Article ID Match (stable provider identifier)
    if (providerArticleId && this.seenIds.has(String(providerArticleId))) {
      const decision = {
        isDuplicate: true,
        dedupDecision: 'DROPPED',
        dedupLayer: 'Layer 1: Provider Article ID',
        dedupReason: `Provider Article ID ${providerArticleId} already recorded`,
        duplicateOf: String(providerArticleId),
        duplicateStatus: 'EXACT_DUPLICATE',
        duplicateDetectedAt: new Date().toISOString()
      };
      this._recordDuplicateAudit(article, decision);
      return decision;
    } else if (effectiveId && this.seenIds.has(String(effectiveId))) {
      const decision = {
        isDuplicate: true,
        dedupDecision: 'DROPPED',
        dedupLayer: 'Layer 1: Exact ID',
        dedupReason: `Article ID ${effectiveId} already recorded`,
        duplicateOf: String(effectiveId),
        duplicateStatus: 'EXACT_DUPLICATE',
        duplicateDetectedAt: new Date().toISOString()
      };
      this._recordDuplicateAudit(article, decision);
      return decision;
    }

    // LAYER 2: Publisher Canonical URL Match
    const effectiveCanonUrl = canonicalUrl ? this.canonicalUrl(canonicalUrl) : (url ? this.canonicalUrl(url) : null);
    if (effectiveCanonUrl && this.seenCanonicalUrls.has(effectiveCanonUrl)) {
      const decision = {
        isDuplicate: true,
        dedupDecision: 'DROPPED',
        dedupLayer: 'Layer 2: Publisher Canonical URL',
        dedupReason: `Publisher Canonical URL ${effectiveCanonUrl} already recorded`,
        duplicateOf: effectiveCanonUrl,
        duplicateStatus: 'EXACT_DUPLICATE',
        duplicateDetectedAt: new Date().toISOString()
      };
      this._recordDuplicateAudit(article, decision);
      return decision;
    }

    // LAYER 3: Normalized URL Match
    const effectiveNormUrl = url ? this.normalizeUrl(url) : (sourceUrl ? this.normalizeUrl(sourceUrl) : null);
    if (effectiveNormUrl && this.seenNormalizedUrls.has(effectiveNormUrl)) {
      const decision = {
        isDuplicate: true,
        dedupDecision: 'DROPPED',
        dedupLayer: 'Layer 3: Normalized URL',
        dedupReason: `Normalized URL match ${effectiveNormUrl}`,
        duplicateOf: effectiveNormUrl,
        duplicateStatus: 'EXACT_DUPLICATE',
        duplicateDetectedAt: new Date().toISOString()
      };
      this._recordDuplicateAudit(article, decision);
      return decision;
    }

    // LAYER 4: Strong Title + Publisher Fingerprint with 2-hour TTL eviction (warroom-wire pattern)
    if (title && pubName) {
      const fingerprint = this.computeTitleSourceFingerprint(title, pubName);
      if (this.seenTitleSourceFingerprints.has(fingerprint)) {
        const existing = this.seenTitleSourceFingerprints.get(fingerprint);
        // Only drop if within 2-hour TTL window
        if (Date.now() - (existing.timestamp || 0) < this.ttlMs) {
          const decision = {
            isDuplicate: true,
            dedupDecision: 'DROPPED',
            dedupLayer: 'Layer 4: Title + Publisher Fingerprint',
            dedupReason: `Same title already published by ${pubName}`,
            duplicateOf: existing.articleId,
            duplicateStatus: 'EXACT_DUPLICATE',
            duplicateDetectedAt: new Date().toISOString()
          };
          this._recordDuplicateAudit(article, decision);
          return decision;
        } else {
          // Stale entry past 2h TTL: evict so updated story can be processed
          this.seenTitleSourceFingerprints.delete(fingerprint);
        }
      }
    }

    // LAYER 5: STORY CLUSTERING & SOURCE CORROBORATION
    // Different publishers covering the same event are NOT deleted. They are linked through storyClusterId!
    const cluster = this._assignStoryCluster(title, effectiveId, pubName, providerName);

    // Register unique article into deduplication caches
    this.record(article);

    return {
      isDuplicate: false,
      dedupDecision: 'ALLOWED',
      dedupLayer: null,
      dedupReason: 'Passed all deduplication layers',
      duplicateOf: null,
      duplicateStatus: 'UNIQUE',
      storyClusterId: cluster.id,
      sourceCount: cluster.publishers.size,
      uniquePublisherCount: cluster.publishers.size,
      uniqueProviderCount: cluster.providers.size
    };
  }

  /**
   * Assigns or creates a story cluster for multi-publisher corroboration
   */
  _assignStoryCluster(title = '', articleId, publisher = '', provider = '') {
    const now = Date.now();
    const TWO_DAYS_MS = 48 * 60 * 60 * 1000;

    // Clean old clusters
    for (const [cId, cData] of this.storyClusters.entries()) {
      if (now - cData.createdAt > TWO_DAYS_MS) {
        this.storyClusters.delete(cId);
      }
    }

    // Search for matching existing story cluster
    for (const cluster of this.storyClusters.values()) {
      const sim = calculateStringSimilarity(title, cluster.title);
      if (sim >= 0.55) {
        cluster.articles.push(articleId);
        cluster.publishers.add(publisher);
        cluster.providers.add(provider);
        return cluster;
      }
    }

    // Create new story cluster
    const newClusterId = `cluster_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newCluster = {
      id: newClusterId,
      title,
      createdAt: now,
      articles: [articleId],
      publishers: new Set([publisher]),
      providers: new Set([provider])
    };
    this.storyClusters.set(newClusterId, newCluster);
    return newCluster;
  }

  /**
   * Records a unique article into deduplication caches
   */
  record(article) {
    const { articleId, id, providerArticleId, url, canonicalUrl, sourceUrl, title, publisher, source_name } = article;
    const effectiveId = providerArticleId || articleId || id;
    const pubName = publisher || source_name;

    if (effectiveId) this.seenIds.add(String(effectiveId));
    if (providerArticleId && providerArticleId !== effectiveId) this.seenIds.add(String(providerArticleId));
    if (articleId && articleId !== effectiveId) this.seenIds.add(String(articleId));
    if (id && id !== effectiveId) this.seenIds.add(String(id));

    const effectiveCanonUrl = canonicalUrl ? this.canonicalUrl(canonicalUrl) : (url ? this.canonicalUrl(url) : null);
    if (effectiveCanonUrl) this.seenCanonicalUrls.add(effectiveCanonUrl);

    const effectiveNormUrl = url ? this.normalizeUrl(url) : (sourceUrl ? this.normalizeUrl(sourceUrl) : null);
    if (effectiveNormUrl) this.seenNormalizedUrls.add(effectiveNormUrl);

    if (title && pubName) {
      const fp = this.computeTitleSourceFingerprint(title, pubName);
      this.seenTitleSourceFingerprints.set(fp, { articleId: effectiveId, timestamp: Date.now(), title, publisher: pubName });
    }

    // Memory ceiling management
    if (this.seenIds.size > this.maxMemoryItems) {
      const oldestId = this.seenIds.values().next().value;
      if (oldestId) this.seenIds.delete(oldestId);
    }
  }

  _recordDuplicateAudit(article, decision) {
    this.duplicateAuditTrail.push({
      articleId: article.articleId || article.id,
      title: article.title,
      publisher: article.publisher || article.source_name,
      url: article.url,
      ...decision
    });
    if (this.duplicateAuditTrail.length > 500) {
      this.duplicateAuditTrail.shift();
    }
  }

  getDuplicateAuditTrail() {
    return [...this.duplicateAuditTrail];
  }
}
