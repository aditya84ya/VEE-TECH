import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

import { NewsDataAdapter } from './services/ingestion/providers/NewsDataAdapter.js';
import { CurrentsAdapter } from './services/ingestion/providers/CurrentsAdapter.js';
import { GNewsAdapter } from './services/ingestion/providers/GNewsAdapter.js';
import { NewsApiAdapter } from './services/ingestion/providers/NewsApiAdapter.js';
import { GuardianAdapter } from './services/ingestion/providers/GuardianAdapter.js';
import { GoogleRssAdapter } from './services/ingestion/providers/GoogleRssAdapter.js';
import { InstitutionalRssAdapter } from './services/ingestion/providers/InstitutionalRssAdapter.js';
import { EventRegistryAdapter } from './services/ingestion/providers/EventRegistryAdapter.js';
import { GDELTAdapter } from './services/ingestion/providers/GDELTAdapter.js';

const adapters = [
  new NewsDataAdapter(),
  new CurrentsAdapter(),
  new GNewsAdapter(),
  new NewsApiAdapter(),
  new GuardianAdapter(),
  new GoogleRssAdapter(),
  new InstitutionalRssAdapter(),
  new EventRegistryAdapter(),
  new GDELTAdapter()
];

console.log('===============================================================');
console.log('          DIRECT PROVIDER ISOLATION TEST (PHASE 4)             ');
console.log('===============================================================\n');

for (const adapter of adapters) {
  const name = adapter.providerName;
  const configured = Boolean(
    name === 'googlenews' || name === 'institutional' 
      ? true 
      : adapter.apiKey
  );
  
  adapter.isRunning = true; // Mark active
  console.log(`\n---------------------------------------------------------------`);
  console.log(`TESTING: ${name.toUpperCase()} (${adapter.displayName})`);
  console.log(`configured: ${configured}`);

  // 1. Initial execution through _executeFetch()
  console.log(`--> Executing Fetch 1 (first attempt)...`);
  const items1 = await adapter._executeFetch();
  console.log(`Result 1 items count: ${items1.length}`);

  const health1 = adapter.getHealth();
  console.log(`Provider Health after Attempt 1:`);
  console.log(`  state: ${health1.status}`);
  console.log(`  requestAttempts: ${health1.requestAttempts}`);
  console.log(`  successfulHttpRequests: ${health1.successfulHttpRequests}`);
  console.log(`  httpErrors: ${health1.httpErrors}`);
  console.log(`  skippedCooldown: ${health1.skippedCooldown}`);
  console.log(`  skippedQuota: ${health1.skippedQuota}`);
  console.log(`  rawFetched: ${health1.rawFetched}`);
  console.log(`  stale: ${health1.stale}`);
  console.log(`  duplicates: ${health1.duplicates}`);
  console.log(`  accepted: ${health1.accepted}`);
  console.log(`  cooldownRemainingSec: ${health1.cooldownRemainingSec}s`);

  // 2. Immediate second execution attempt to verify gating
  console.log(`--> Executing Fetch 2 (immediate re-poll)...`);
  const items2 = await adapter._executeFetch();
  console.log(`Result 2 items count: ${items2.length}`);

  const health2 = adapter.getHealth();
  console.log(`Provider Health after Attempt 2:`);
  console.log(`  state: ${health2.status}`);
  console.log(`  requestAttempts: ${health2.requestAttempts}`);
  console.log(`  successfulHttpRequests: ${health2.successfulHttpRequests}`);
  console.log(`  httpErrors: ${health2.httpErrors}`);
  console.log(`  skippedCooldown: ${health2.skippedCooldown}`);
  console.log(`  skippedQuota: ${health2.skippedQuota}`);
  console.log(`  rawFetched: ${health2.rawFetched}`);
  console.log(`  accepted: ${health2.accepted}`);
}

console.log('\n===============================================================');
console.log('              DIRECT PROVIDER ISOLATION TEST COMPLETE           ');
console.log('===============================================================\n');
