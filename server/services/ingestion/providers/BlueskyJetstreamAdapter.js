import { WebSocket } from 'ws';
import { ProviderAdapter } from '../ProviderAdapter.js';

const TARGET_REGEX = /\b(Infosys|Infosys\s+ADR|NYSE:\s*INFY|TCS|Tata\s+Consultancy|Wipro|Wipro\s+ADR|Accenture|Finacle)\b/i;
const JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post';

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

  _connect() {
    if (!this.isRunning) return;

    console.log(`[Bluesky Jetstream] ⚡ Connecting to WebSocket firehose: ${JETSTREAM_URL}`);
    this.metrics.status = 'CONNECTING';

    try {
      this.ws = new WebSocket(JETSTREAM_URL, { handshakeTimeout: 8000 });

      this.ws.on('open', () => {
        if (!this.isRunning) {
          this.ws.close();
          return;
        }
        console.log('[Bluesky Jetstream] ✅ Connected to real-time Jetstream firehose');
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

          const did = event.did ?? 'unknown';
          const rkey = event.commit?.rkey ?? Date.now();
          const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
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
            postUrl,
            title,
            text,
            did,
            imageUrl,
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
        console.log(`[Bluesky Jetstream] Connection closed. Reconnecting in ${this.reconnectDelay / 1000}s…`);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
          this._connect();
        }, this.reconnectDelay);
      });
    } catch (err) {
      this.recordFailure(err);
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
      description: raw.text?.slice(0, 300) || raw.title,
      content: raw.text || raw.title,
      image: raw.imageUrl || null,
      mediaUrl: raw.imageUrl || null,
      language: 'en',
      country: null,
      publishedAt,
      providerAvailableAt: publishedAt,
      receivedAt: now,
      ingestedAt: now
    };
  }
}
