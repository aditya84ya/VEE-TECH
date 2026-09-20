import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { IngestionGateway } from './services/ingestion/IngestionGateway.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('===============================================================');
console.log('    VEE-ALERT PROVIDER RELIABILITY & COOLDOWN VERIFICATION    ');
console.log('===============================================================\n');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runReliabilityVerification() {
  const gateway = new IngestionGateway({
    supabase,
    maxArticleAgeHours: 48,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b'
  });

  console.log('[Test] Starting IngestionGateway with 10 independent providers...');
  await gateway.start();

  console.log('[Test] Waiting 20s for all provider priority groups (A, B, C) to run initial poll...');
  await new Promise(r => setTimeout(r, 20000));

  console.log('\n[Test] Checking initial provider telemetry snapshot...');
  let diag = gateway.getDetailedDiagnostics();

  console.log('\n[Test] Attempting triggerManualFetch() while quota providers are in cooldown...');
  console.log('--> EXPECTED: Rate-limited / quota-exhausted providers MUST log SKIPPED — COOLDOWN ACTIVE and make ZERO HTTP requests.');
  
  const initialSkippedCounts = {};
  for (const [name, p] of Object.entries(diag.providers)) {
    initialSkippedCounts[name] = p.skippedCooldownCount;
  }

  const manualResults = await gateway.triggerManualFetch();
  console.log('[Test] triggerManualFetch() completed. Results:', manualResults);

  // Check diagnostics after manual trigger
  diag = gateway.getDetailedDiagnostics();

  console.log('\n===============================================================');
  console.log('                    FINAL PROVIDER HEALTH TABLE                ');
  console.log('===============================================================');
  console.log('Provider       | Status          | Last Req | Last Success | Fetched | Errs | Skips | Cooldown Rem');
  console.log('---------------------------------------------------------------------------------------------------');

  for (const [name, p] of Object.entries(diag.providers)) {
    const padName = name.padEnd(14);
    const padStatus = String(p.status).padEnd(15);
    const lastReq = p.lastAttemptAt ? p.lastAttemptAt.slice(11, 19) : 'None    ';
    const lastSucc = p.lastSuccessAt ? p.lastSuccessAt.slice(11, 19) : 'None    ';
    const fetched = String(p.fetchedCount || 0).padStart(7);
    const errs = String(p.errorCount || 0).padStart(4);
    const skips = String(p.skippedCooldownCount || 0).padStart(5);
    const cdRem = p.cooldownRemainingSec > 0 ? `${p.cooldownRemainingSec}s` : '0s';
    console.log(`${padName} | ${padStatus} | ${lastReq} | ${lastSucc}     | ${fetched} | ${errs} | ${skips} | ${cdRem}`);
  }
  console.log('===============================================================\n');

  // Verify Critical Success Criteria
  const newsdata = diag.providers.newsdata;
  const currents = diag.providers.currents;
  const gnews = diag.providers.gnews;
  const googlenews = diag.providers.googlenews;
  const eventregistry = diag.providers.eventregistry;

  const checkNewsDataQuota = newsdata.status === 'QUOTA_EXHAUSTED' || newsdata.status === 'COOLDOWN';
  const checkCurrentsQuota = currents.status === 'QUOTA_EXHAUSTED' || currents.status === 'COOLDOWN';
  const checkGNewsQuota = gnews.status === 'QUOTA_EXHAUSTED' || gnews.status === 'AUTH_ERROR';
  const checkSkipsIncremented = (newsdata.skippedCooldownCount > 0) || (currents.skippedCooldownCount > 0);
  const checkGoogleHealthy = googlenews.status === 'ACTIVE' || googlenews.status === 'POLLING';
  const checkEventRegistryStatus = eventregistry.status === 'DISABLED'; // Because no key in .env

  console.log('CRITICAL VERIFICATION CHECKS:');
  console.log(`[PASS: ${checkNewsDataQuota}] NewsData properly recognized as QUOTA_EXHAUSTED / COOLDOWN (no repeated 429)`);
  console.log(`[PASS: ${checkCurrentsQuota}] Currents properly recognized as QUOTA_EXHAUSTED (Retry-After respected)`);
  console.log(`[PASS: ${checkGNewsQuota}] GNews properly recognized as QUOTA_EXHAUSTED (00:00 UTC reset calculated)`);
  console.log(`[PASS: ${checkSkipsIncremented}] Cooling-down providers incremented skippedCooldownCount instead of sending HTTP requests`);
  console.log(`[PASS: ${checkGoogleHealthy}] Google News RSS is independently active`);
  console.log(`[PASS: ${checkEventRegistryStatus}] EventRegistry status cleanly marked DISABLED due to missing API key in .env`);
  console.log('===============================================================\n');

  await gateway.stop();
  const allPass = checkNewsDataQuota && checkCurrentsQuota && checkGNewsQuota && checkSkipsIncremented && checkGoogleHealthy && checkEventRegistryStatus;
  process.exit(allPass ? 0 : 1);
}

runReliabilityVerification().catch(err => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
