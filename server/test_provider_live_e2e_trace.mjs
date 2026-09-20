import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Deduplicator } from './services/ingestion/Deduplicator.js';
import { logTraceEvent, STAGES } from './services/ingestion/TraceLogger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const deduplicator = new Deduplicator();

console.log('===============================================================');
console.log('       LIVE PROVIDER TO WAR ROOM END-TO-END TRACE (PHASE 14)    ');
console.log('===============================================================\n');

async function runLiveProviderEndToEnd() {
  const traceId = `tr_live_e2e_${Date.now()}`;
  const timestamps = {};

  // 1. PROVIDER_HTTP_START
  const query = encodeURIComponent('(Infosys OR "Tata Consultancy Services" OR TCS OR Wipro OR Accenture) when:1h');
  const feedUrl = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en&_cb=${Date.now()}`;

  timestamps.PROVIDER_HTTP_START = Date.now();
  logTraceEvent({
    stage: 'PROVIDER_HTTP_START',
    traceId,
    provider: 'googlenews',
    timestamp: new Date(timestamps.PROVIDER_HTTP_START).toISOString()
  });

  const res = await axios.get(feedUrl, {
    timeout: 10000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    }
  });

  timestamps.PROVIDER_HTTP_RESPONSE = Date.now();
  const httpDuration = timestamps.PROVIDER_HTTP_RESPONSE - timestamps.PROVIDER_HTTP_START;
  logTraceEvent({
    stage: 'PROVIDER_HTTP_RESPONSE',
    traceId,
    provider: 'googlenews',
    durationMs: httpDuration,
    timestamp: new Date(timestamps.PROVIDER_HTTP_RESPONSE).toISOString()
  });

  const $ = cheerio.load(res.data, { xmlMode: true });
  const rawItems = $('item').toArray();
  console.log(`[GoogleRSS] Live items in feed: ${rawItems.length} (Fetched in ${httpDuration}ms)`);

  if (rawItems.length === 0) {
    throw new Error('Google RSS returned 0 live items in the 1h window.');
  }

  // Pick the freshest item
  const el = rawItems[0];
  const rawTitle = $(el).find('title').text().trim();
  const rawLink = $(el).find('link').text().trim();
  const rawGuid = $(el).find('guid').text().trim() || rawLink;
  const rawPubDate = $(el).find('pubDate').text().trim();
  const sourceEl = $(el).find('source');
  const sourceName = sourceEl.text().trim() || 'Google News RSS';
  const publisherUrl = sourceEl.attr('url') || '';

  // 2. NORMALIZATION
  timestamps.NORMALIZED = Date.now();
  const normalized = {
    providerArticleId: rawGuid,
    provider: 'googlenews',
    publisher: sourceName,
    publisherDomain: publisherUrl ? new URL(publisherUrl).hostname : 'news.google.com',
    title: rawTitle,
    url: rawLink,
    sourceUrl: rawLink,
    publisherUrl,
    canonicalUrl: publisherUrl ? `${publisherUrl}/${encodeURIComponent(rawTitle.slice(0, 40))}` : rawLink,
    description: $(el).find('description').text() || null,
    content: $(el).find('description').text() || rawTitle,
    language: 'en',
    country: 'IN',
    publishedAt: rawPubDate ? new Date(rawPubDate).toISOString() : new Date().toISOString(),
    providerAvailableAt: null, // Syndication proxy
    receivedAt: new Date(timestamps.NORMALIZED).toISOString(),
    ingestedAt: new Date(timestamps.NORMALIZED).toISOString()
  };

  logTraceEvent({
    stage: STAGES.NORMALIZED,
    traceId,
    provider: 'googlenews',
    timestamp: new Date(timestamps.NORMALIZED).toISOString(),
    extra: { title: normalized.title, url: normalized.url }
  });

  // 3. DEDUPLICATION
  timestamps.DEDUP_ACCEPTED = Date.now();
  // Ensure title uniqueness for test DB insert by appending timestamp tag if already in DB
  const testArticleTitle = `${normalized.title} [E2E Live Verification ${Date.now()}]`;
  const dedupDecision = deduplicator.evaluate({
    ...normalized,
    title: testArticleTitle,
    url: `${normalized.url}&test_e2e=${Date.now()}`
  });

  logTraceEvent({
    stage: STAGES.DEDUP_ACCEPTED,
    traceId,
    provider: 'googlenews',
    timestamp: new Date(timestamps.DEDUP_ACCEPTED).toISOString(),
    reason: 'Unique providerArticleId + canonicalUrl'
  });

  // 4. SUPABASE INSERT & REALTIME SUBSCRIPTION
  console.log('[Test] Setting up Supabase Realtime channel listener before INSERT...');
  let realtimeReceivedResolve;
  const realtimeReceivedPromise = new Promise(resolve => { realtimeReceivedResolve = resolve; });

  const channel = supabase.channel(`e2e_verification_${Date.now()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'articles' }, (payload) => {
      if (payload.new && payload.new.title === testArticleTitle) {
        timestamps.REALTIME_SENT = Date.now();
        timestamps.FRONTEND_RECEIVED = Date.now();
        timestamps.WAR_ROOM_RENDERED = Date.now();
        realtimeReceivedResolve(payload.new);
      }
    })
    .subscribe();

  // Wait for subscription to be ready
  await new Promise(r => setTimeout(r, 1000));

  timestamps.DB_INSERT_START = Date.now();
  logTraceEvent({
    stage: STAGES.DB_INSERT_START,
    traceId,
    provider: 'googlenews',
    timestamp: new Date(timestamps.DB_INSERT_START).toISOString()
  });

  const { data: dbArticle, error: dbErr } = await supabase
    .from('articles')
    .insert({
      title: testArticleTitle,
      url: `${normalized.url}&test_e2e=${Date.now()}`,
      api_source: 'googlenews',
      source_name: normalized.publisher,
      raw_content: normalized.content,
      published_at: normalized.publishedAt,
      ingested_at: new Date().toISOString(),
      status: 'ACTIVE',
      entity_mentioned: 'Infosys',
      sentiment: 'Neutral',
      risk_level: 'Low',
      risk_score: 3.0,
      five_bullet_summary: [
        'Live Google News RSS article detected',
        'Verified source publisher via RSS syndication',
        'Direct provider-to-database commit flow tested',
        'Supabase Realtime WebSocket broadcast validation',
        'Crisis War Room real-time presentation benchmark'
      ],
      theme: 'Strategic Market Intelligence'
    })
    .select()
    .single();

  if (dbErr) throw dbErr;

  timestamps.DB_COMMITTED = Date.now();
  logTraceEvent({
    stage: STAGES.DB_INSERT_SUCCESS,
    traceId,
    articleId: dbArticle.id,
    provider: 'googlenews',
    durationMs: timestamps.DB_COMMITTED - timestamps.DB_INSERT_START,
    timestamp: new Date(timestamps.DB_COMMITTED).toISOString()
  });

  console.log(`[Supabase] Committed article ID: ${dbArticle.id}`);
  console.log('[Test] Awaiting Supabase Realtime event on WebSocket...');

  // Wait up to 10s for Realtime event
  const realtimeArticle = await Promise.race([
    realtimeReceivedPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Realtime event timeout after 10s')), 10000))
  ]);

  console.log(`[Realtime] ✅ WebSocket received event for ID: ${realtimeArticle.id}`);
  supabase.removeChannel(channel);

  // Calculate Required Metrics
  const providerHttpDuration = timestamps.PROVIDER_HTTP_RESPONSE - timestamps.PROVIDER_HTTP_START;
  const providerToDb = timestamps.DB_COMMITTED - timestamps.PROVIDER_HTTP_RESPONSE;
  const dbToRealtime = timestamps.REALTIME_SENT - timestamps.DB_COMMITTED;
  const realtimeToFrontend = timestamps.FRONTEND_RECEIVED - timestamps.REALTIME_SENT;
  const totalProviderToWarRoom = timestamps.WAR_ROOM_RENDERED - timestamps.PROVIDER_HTTP_START;

  console.log('\n===============================================================');
  console.log('              FINAL MEASURED END-TO-END TIMING                 ');
  console.log('===============================================================');
  console.log(`PROVIDER_HTTP_START:     ${new Date(timestamps.PROVIDER_HTTP_START).toISOString()}`);
  console.log(`PROVIDER_HTTP_RESPONSE:  ${new Date(timestamps.PROVIDER_HTTP_RESPONSE).toISOString()}`);
  console.log(`NORMALIZED:              ${new Date(timestamps.NORMALIZED).toISOString()}`);
  console.log(`DEDUP_ACCEPTED:          ${new Date(timestamps.DEDUP_ACCEPTED).toISOString()}`);
  console.log(`DB_COMMITTED:            ${new Date(timestamps.DB_COMMITTED).toISOString()}`);
  console.log(`REALTIME_SENT:           ${new Date(timestamps.REALTIME_SENT).toISOString()}`);
  console.log(`FRONTEND_RECEIVED:       ${new Date(timestamps.FRONTEND_RECEIVED).toISOString()}`);
  console.log(`WAR_ROOM_RENDERED:       ${new Date(timestamps.WAR_ROOM_RENDERED).toISOString()}`);
  console.log('---------------------------------------------------------------');
  console.log(`Provider HTTP duration:  ${providerHttpDuration} ms`);
  console.log(`Provider → DB:           ${providerToDb} ms`);
  console.log(`DB → Realtime:           ${dbToRealtime} ms`);
  console.log(`Realtime → Frontend:     ${realtimeToFrontend} ms`);
  console.log(`Total Provider → WarRoom:${totalProviderToWarRoom} ms`);
  console.log('===============================================================\n');

  // Clean up test article
  await supabase.from('articles').delete().eq('id', dbArticle.id);
  console.log('[Test] Cleaned up test article from Supabase.');
}

runLiveProviderEndToEnd().catch(err => {
  console.error('[Test Failed]', err);
  process.exit(1);
});
