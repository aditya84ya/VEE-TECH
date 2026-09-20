import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { IngestionGateway } from './services/ingestion/IngestionGateway.js';
import { logTraceEvent, STAGES } from './services/ingestion/TraceLogger.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('===============================================================');
console.log('       VEE-ALERT END-TO-END PIPELINE VERIFICATION TRACE        ');
console.log('===============================================================\n');

if (!url || !serviceKey || !anonKey) {
  console.error('❌ Missing Supabase credentials in .env');
  process.exit(1);
}

const inserterClient = createClient(url, serviceKey);
const subscriberClient = createClient(url, anonKey);

async function runEndToEndVerification() {
  const traceId = `tr_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const timings = {};

  // Timestamps for pipeline trace
  const traceLog = [];
  function recordTrace(stage, durationMs = null, extra = {}) {
    const entry = {
      traceId,
      timestamp: new Date().toISOString(),
      stage,
      durationMs,
      ...extra
    };
    traceLog.push(entry);
    console.log(`[TRACE:${stage.padEnd(24)}] ${JSON.stringify(entry)}`);
  }

  // Frontend State Simulation (mirroring WarRoomContext.tsx)
  const frontendState = {
    articles: [],
    newestCursor: null,
    counters: { active: 0, critical: 0, high: 0 },
    realtimeEventsReceived: 0,
    updatesReceived: 0
  };

  // Reconnection recovery simulation (mirroring WarRoomContext performReconnectRecovery)
  async function performReconnectRecovery(cursor) {
    recordTrace('RECOVERY_STARTED', null, { cursor });
    const { data: missingArticles, error } = await subscriberClient
      .from('articles')
      .select('*')
      .gt('ingested_at', cursor)
      .order('ingested_at', { ascending: false });

    if (error) {
      recordTrace('RECOVERY_ERROR', null, { error: error.message });
      return 0;
    }

    const count = missingArticles?.length || 0;
    recordTrace('RECOVERY_FETCHED', null, { count });

    const existingIds = new Set(frontendState.articles.map(a => a.id));
    const newUnique = (missingArticles || []).filter(a => !existingIds.has(a.id));

    if (newUnique.length > 0) {
      if (newUnique[0]?.ingested_at && (!frontendState.newestCursor || newUnique[0].ingested_at > frontendState.newestCursor)) {
        frontendState.newestCursor = newUnique[0].ingested_at;
      }
      frontendState.articles = [...newUnique, ...frontendState.articles];
    }
    recordTrace('RECOVERY_COMPLETED', null, { totalInState: frontendState.articles.length });
    return count;
  }

  // 1. Setup IngestionGateway with DB client
  const gateway = new IngestionGateway({
    supabase: inserterClient,
    maxArticleAgeHours: 12,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
    onArticleCommitted: (art) => {
      timings.gatewayCommittedAt = Date.now();
      recordTrace('GATEWAY_COMMITTED', Date.now() - timings.pipelineStart, { articleId: art.id });
    },
    onArticleUpdated: (art) => {
      timings.gatewayArticleUpdatedAt = Date.now();
      recordTrace('GATEWAY_ARTICLE_UPDATED', null, {
        articleId: art.id,
        risk_level: art.risk_level,
        risk_score: art.risk_score
      });
    }
  });

  const testArticleTitle = `Infosys Expands Enterprise Cloud & AI Sovereignty Suite ${Date.now()}`;
  const testArticleUrl = `https://www.thehindubusinessline.com/info-tech/infosys-ai-cloud-${Date.now()}.html`;
  let targetArticleId = null;

  // 2. Setup Realtime Channel (Frontend Listener)
  const channel = subscriberClient.channel('public:articles')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'articles' }, (payload) => {
      const art = payload.new;
      if (!art || !art.id) return;

      if (art.title === testArticleTitle || art.id === targetArticleId) {
        timings.realtimeInsertReceivedAt = Date.now();
        frontendState.realtimeEventsReceived++;
        targetArticleId = art.id;

        // Frontend state update simulation
        const isPresent = frontendState.articles.some(a => a.id === art.id);
        if (!isPresent) {
          frontendState.articles.unshift(art);
          frontendState.newestCursor = art.ingested_at;
          frontendState.counters.active++;
          timings.frontendRenderAt = Date.now();
        }

        recordTrace(STAGES.FRONTEND_EVENT_RECEIVED, timings.realtimeInsertReceivedAt - timings.dbInsertStart, {
          articleId: art.id,
          event: 'INSERT',
          title: art.title.slice(0, 50)
        });
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'articles' }, (payload) => {
      const updated = payload.new;
      if (!updated || !updated.id) return;

      if (updated.id === targetArticleId) {
        timings.realtimeUpdateReceivedAt = Date.now();
        frontendState.updatesReceived++;

        // In-place merge without duplicate card
        let merged = false;
        frontendState.articles = frontendState.articles.map(item => {
          if (item.id === updated.id) {
            merged = true;
            return { ...item, ...updated };
          }
          return item;
        });

        recordTrace('FRONTEND_CARD_UPDATED', timings.realtimeUpdateReceivedAt - timings.pipelineStart, {
          articleId: updated.id,
          mergedSuccessfully: merged,
          risk_level: updated.risk_level,
          risk_score: updated.risk_score,
          summaryBullets: updated.five_bullet_summary?.length
        });
      }
    });

  console.log('[Test Setup] Subscribing to Supabase Realtime channel (anon key)...');
  await new Promise((resolve) => {
    channel.subscribe((status) => {
      console.log(`[Test Setup] Realtime status: ${status}`);
      if (status === 'SUBSCRIBED') {
        recordTrace(STAGES.FRONTEND_SUBSCRIBED);
        resolve();
      }
    });
  });

  // 3. Launch the test article through the pipeline
  timings.pipelineStart = Date.now();
  recordTrace(STAGES.PROVIDER_FETCH_SUCCESS, null, { provider: 'googlenews' });

  const mockNormalizedArticle = {
    provider: 'googlenews',
    providerArticleId: `gn_${Date.now()}`,
    sourceUrl: `https://news.google.com/rss/articles/CBMiTest${Date.now()}`,
    publisherUrl: 'https://www.thehindubusinessline.com',
    canonicalUrl: testArticleUrl,
    url: testArticleUrl,
    title: testArticleTitle,
    description: 'Infosys introduces next-generation enterprise AI sovereign cloud infrastructure and generative automation frameworks.',
    content: 'Infosys expands its cloud computing capabilities with enterprise focus on sovereignty and AI scalability.',
    publishedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30m ago (fresh within 12h window)
    receivedAt: new Date().toISOString(),
    publisher: 'The Hindu BusinessLine',
    image: 'https://images.thehindubusinessline.com/infosys.jpg',
    traceId
  };

  timings.backendReceivedAt = Date.now();
  timings.dbInsertStart = Date.now();

  console.log('\n[Pipeline Execution] Passing article into IngestionGateway.handleIncomingArticle()...');
  await gateway.handleIncomingArticle(mockNormalizedArticle);
  timings.dbInsertEnd = Date.now();

  // Wait for Realtime INSERT and AI Triage UPDATE
  console.log('\n[Pipeline Execution] Awaiting Supabase Realtime INSERT & AI UPDATE...');
  const maxWaitMs = 25000;
  const startWait = Date.now();

  while (Date.now() - startWait < maxWaitMs) {
    if (frontendState.updatesReceived > 0) {
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 4. Test Reconnect Recovery
  console.log('\n[Recovery Execution] Testing Realtime Disconnect & Recovery Cursor Fetch...');
  // Simulate channel disconnect
  recordTrace(STAGES.REALTIME_ERROR, null, { status: 'CLOSED' });
  await channel.unsubscribe();

  // Ingest another article while disconnected
  const missedArticleTitle = `Infosys Partners with Global Telecom Consortium ${Date.now()}`;
  const missedArticleUrl = `https://www.thehindubusinessline.com/info-tech/infosys-telecom-${Date.now()}.html`;
  const missedNormalized = {
    ...mockNormalizedArticle,
    providerArticleId: `gn_missed_${Date.now()}`,
    sourceUrl: `https://news.google.com/rss/articles/CBMiMissed${Date.now()}`,
    canonicalUrl: missedArticleUrl,
    url: missedArticleUrl,
    title: missedArticleTitle,
    publishedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    receivedAt: new Date().toISOString(),
    traceId: `tr_rec_${Date.now()}`
  };

  console.log('[Recovery Execution] Ingesting article during disconnect window...');
  await gateway.handleIncomingArticle(missedNormalized);

  // Now trigger performReconnectRecovery with last known cursor
  const recoveredCount = await performReconnectRecovery(frontendState.newestCursor);
  console.log(`[Recovery Execution] Recovered count: ${recoveredCount} (Expected >= 1)`);

  // 5. Compute and Display Timing Results
  console.log('\n===============================================================');
  console.log('                 PIPELINE TIMING BREAKDOWN                     ');
  console.log('===============================================================');
  const providerToBackend = timings.backendReceivedAt - timings.pipelineStart;
  const backendToDb = timings.dbInsertEnd - timings.dbInsertStart;
  const dbToRealtime = timings.realtimeInsertReceivedAt ? (timings.realtimeInsertReceivedAt - timings.dbInsertEnd) : 'N/A';
  const realtimeToFrontend = timings.frontendRenderAt && timings.realtimeInsertReceivedAt ? (timings.frontendRenderAt - timings.realtimeInsertReceivedAt) : 0;
  const totalFastPath = timings.realtimeInsertReceivedAt ? (timings.realtimeInsertReceivedAt - timings.pipelineStart) : 'N/A';
  const aiDuration = timings.realtimeUpdateReceivedAt ? (timings.realtimeUpdateReceivedAt - timings.dbInsertEnd) : 'N/A';

  console.log(`1. Provider -> Backend Gateway:     ${providerToBackend} ms`);
  console.log(`2. Backend Ingest -> DB Persist:    ${backendToDb} ms`);
  console.log(`3. DB -> Supabase Realtime Event:   ${dbToRealtime} ms`);
  console.log(`4. Realtime -> Frontend State:      ${realtimeToFrontend} ms`);
  console.log(`---------------------------------------------------------------`);
  console.log(`⚡ TOTAL FAST-PATH LATENCY (T0->UI): ${totalFastPath} ms`);
  console.log(`🧠 AI Triage & UPDATE In-Place:     ${aiDuration} ms`);
  console.log('===============================================================\n');

  // Verify assertions
  console.log('===============================================================');
  console.log('                     VERIFICATION AUDIT                        ');
  console.log('===============================================================');
  const check1 = frontendState.realtimeEventsReceived >= 1;
  const check2 = frontendState.articles.some(a => a.title === testArticleTitle);
  const check3 = frontendState.updatesReceived >= 1;
  const cardInState = frontendState.articles.find(a => a.id === targetArticleId);
  const check4 = cardInState && cardInState.risk_level && cardInState.risk_score && cardInState.five_bullet_summary?.length > 0;
  const check5 = recoveredCount >= 1;
  const check6 = frontendState.articles.filter(a => a.id === targetArticleId).length === 1; // Exactly 1 card, NO duplication

  console.log(`[PASS: ${check1}] Realtime INSERT received without full-table poll`);
  console.log(`[PASS: ${check2}] Card automatically appeared in frontend state`);
  console.log(`[PASS: ${check3}] AI UPDATE received via Realtime`);
  console.log(`[PASS: ${check4}] In-place card enrichment (Risk: ${cardInState?.risk_level}, Score: ${cardInState?.risk_score})`);
  console.log(`[PASS: ${check6}] Zero card duplication (exactly 1 card with ID ${targetArticleId})`);
  console.log(`[PASS: ${check5}] Realtime disconnect recovery fetched delta (missed: ${recoveredCount}) without full reload`);
  console.log('===============================================================\n');

  // Cleanup DB test rows
  try {
    await inserterClient.from('articles').delete().in('title', [testArticleTitle, missedArticleTitle]);
    console.log('[Cleanup] Test articles removed from Supabase DB.');
  } catch (_) {}

  await gateway.stop();
  process.exit(check1 && check2 && check3 && check4 && check5 && check6 ? 0 : 1);
}

runEndToEndVerification().catch((err) => {
  console.error('❌ Verification test failed with error:', err);
  process.exit(1);
});
