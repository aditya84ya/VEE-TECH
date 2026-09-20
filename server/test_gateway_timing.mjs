import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

import { GuardianAdapter } from './services/ingestion/providers/GuardianAdapter.js';

console.log('GUARDIAN_API_KEY in process.env:', process.env.GUARDIAN_API_KEY);

const guardian = new GuardianAdapter();
console.log('guardian.apiKey:', guardian.apiKey);
console.log('guardian.isRunning:', guardian.isRunning);

await guardian.start();
console.log('After start, isRunning:', guardian.isRunning);

console.log('Calling guardian.fetch() directly...');
const t0 = Date.now();
try {
  const items = await guardian.fetch();
  console.log(`guardian.fetch() returned ${items.length} items in ${Date.now() - t0}ms`);
} catch (err) {
  console.log(`guardian.fetch() error in ${Date.now() - t0}ms:`, err.message);
}

console.log('Calling guardian.pollNow()...');
const t1 = Date.now();
try {
  const items = await guardian.pollNow();
  console.log(`guardian.pollNow() returned ${items.length} items in ${Date.now() - t1}ms`);
} catch (err) {
  console.log(`guardian.pollNow() error in ${Date.now() - t1}ms:`, err.message);
}

await guardian.stop();
