import { WebSocket } from 'ws';
import { ProviderAdapter } from '../ProviderAdapter.js';
import { evaluateThreatSeverity } from '../../threatScorer.js';

const TARGET_REGEX = /\b(Infosys|Infosys\s+ADR|NYSE:\s*INFY|TCS|Tata\s+Consultancy|Wipro|Wipro\s+ADR|Accenture|Finacle|SEBI|BSE|NSE)\b/i;

// Bluesky official US-West nodes (bypasses regional BunnyCDN US-East rate limits for Indian IPs)
const JETSTREAM_NODES = [
  'wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.post',
  'wss://jetstream2.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.post'
];

export function formatBlueskySourceUrl(uri, did, rkey) {
  if (did && rkey) {
    return `https://bsky.app/profile/${did}/post/${rkey}`;
  }
  if (!uri || !uri.startsWith('at://')) return 'https://bsky.app';
  const parts = uri.replace('at://', '').split('/');
  const d = parts[0];
  const collection = parts[1];
  const rk = parts[2];
  if (collection === 'app.bsky.feed.post' && d && rk) {
    return `https://bsky.app/profile/${d}/post/${rk}`;
  }
  return 'https://bsky.app';
}

export class BlueskyJetstreamAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({
      providerName: 'bluesky',
      displayName: 'Bluesky Jetstream Firehose (Realtime Stream)',
      fetchMode: 'STREAM',
      intervalMs: 0, // Continuous WebSocket stream
      priority: 0 // Highest priority P0 stream
    });

    this.ws = null;
    this.nodeIndex = 0;
    this.reconnectDelay = 2000;
    this.reconnectTimer = null;
  }

  async onStart() {
    this._connect();
  }

  async onStop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch (_) {}
      this.ws = null;
    }
  }

  /**
   * For streaming firehose, pollNow ensures WebSocket connection is alive
   */
  async pollNow() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[BlueskyJetstream] ⚡ Ensuring WebSocket stream connection is active...');
      this._connect();
    }
    return [];
  }

  _connect() {
    if (!this.isRunning) return;

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const currentUrl = JETSTREAM_NODES[this.nodeIndex % JETSTREAM_NODES.length];
    console.log(`[Bluesky Jetstream] ⚡ Connecting to US-West WebSocket firehose: ${currentUrl}`);
    this.metrics.status = 'CONNECTING';

    try {
      this.ws = new WebSocket(currentUrl, { handshakeTimeout: 10000 });

      this.ws.on('open', () => {
        if (!this.isRunning) {
          this.ws.close();
          return;
        }
        console.log('[BlueskyJetstream] Connected to WebSocket stream');
        console.log(`[Bluesky Jetstream] ✅ Connected to real-time Jetstream firehose (${currentUrl})`);
        this.recordSuccess(0);
        this.metrics.status = 'CONNECTED';
        this.reconnectDelay = 2000;
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          if (event.kind !== 'commit') return;
          if (event.commit?.collection !== 'app.bsky.feed.post') return;

          const record = event.commit?.record;
          if (!record?.text) return;

          const text = String(record.text).trim();
          if (!TARGET_REGEX.test(text)) return;

          // Target entity attribution
          let matchedTarget = 'Enterprise';
          if (/infosys|infy/i.test(text)) matchedTarget = 'Infosys';
          else if (/tcs|tata\s+consultancy/i.test(text)) matchedTarget = 'TCS';
          else if (/wipro/i.test(text)) matchedTarget = 'Wipro';
          else if (/accenture/i.test(text)) matchedTarget = 'Accenture';
          else if (/sebi/i.test(text)) matchedTarget = 'SEBI';
          else if (/bse/i.test(text)) matchedTarget = 'BSE';
          else if (/nse/i.test(text)) matchedTarget = 'NSE';

          const threat = evaluateThreatSeverity(text, text, matchedTarget);
          console.log(`[BlueskyJetstream] 🎯 MATCH [${matchedTarget}] [${threat.severity} ${threat.score}/10]: "${text.slice(0, 90).replace(/\n/g, ' ')}…"`);

          const did = event.did ?? 'unknown';
          const rkey = event.commit?.rkey ?? Date.now();
          const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
          const postUrl = formatBlueskySourceUrl(uri, did, rkey);
          const title = text.length > 90 ? text.slice(0, 90) + '…' : text;

          let imageUrl = null;
          if (record.embed && record.embed.$type === 'app.bsky.embed.images' && Array.isArray(record.embed.images) && record.embed.images.length > 0) {
            const imageRef = record.embed.images[0].image?.ref?.$link || record.embed.images[0].image?.ref?.toString();
            if (imageRef) {
              imageUrl = `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${imageRef}@jpeg`;
            }
          }

          const rawItem = {
            uri,
            did,
            rkey,
            postUrl,
            sourceUrl: postUrl,
            title,
            text,
            imageUrl,
            entity: matchedTarget,
            threat,
            risk_score: threat.score || threat.risk_score || 5.0,
            risk_level: threat.risk_level,
            createdAt: record.createdAt || new Date().toISOString()
          };

          const normalized = this.normalize(rawItem);
          if (normalized) {
            this.recordSuccess(1, 1);
            this.emit('article', normalized);
          }
        } catch (_) {}
      });

      this.ws.on('error', (err) => {
        console.warn('[Bluesky Jetstream] ⚠️ WebSocket notice:', err.message);
        this.recordFailure(err);
      });

      this.ws.on('close', () => {
        if (!this.isRunning) return;
        this.metrics.status = 'DISCONNECTED';
        this.metrics.reconnectCount++;
        this.nodeIndex = (this.nodeIndex + 1) % JETSTREAM_NODES.length;
        const nextUrl = JETSTREAM_NODES[this.nodeIndex];
        console.log(`[Bluesky Jetstream] Connection closed. Reconnecting in ${this.reconnectDelay / 1000}s to ${nextUrl}…`);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
          this._connect();
        }, this.reconnectDelay);
      });
    } catch (err) {
      this.recordFailure(err);
      this.nodeIndex = (this.nodeIndex + 1) % JETSTREAM_NODES.length;
      this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectDelay);
    }
  }

  normalize(raw) {
    if (!raw || !raw.title || !raw.postUrl) return null;

    const publishedAt = raw.createdAt ? new Date(raw.createdAt).toISOString() : new Date().toISOString();
    const now = new Date().toISOString();
    const authorHandle = raw.did?.length > 24 ? `did:...${raw.did.slice(-8)}` : raw.did;

    return {
      providerArticleId: raw.uri || raw.postUrl,
      provider: 'bluesky',
      publisher: `Bluesky Wire (@${authorHandle})`,
      publisherDomain: 'bsky.app',
      title: raw.title,
      url: raw.postUrl,
      canonicalUrl: raw.postUrl,
      sourceUrl: raw.postUrl,
      description: raw.text?.slice(0, 300) || raw.title,
      content: raw.text || raw.title,
      image: raw.imageUrl || null,
      mediaUrl: raw.imageUrl || null,
      language: 'en',
      country: null,
      publishedAt,
      providerAvailableAt: publishedAt,
      receivedAt: now,
      ingestedAt: now,
      entity: raw.entity || null,
      risk_score: raw.risk_score || (raw.threat?.score ?? 5.0),
      risk_level: raw.risk_level || raw.threat?.risk_level || 'Medium'
    };
  }
}
