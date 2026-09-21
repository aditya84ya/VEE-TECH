import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

const rawKey = process.env.GEMINI_API_KEY;
const trimmedKey = rawKey ? rawKey.trim() : '';

console.log('=== ITEM 2: RUNTIME GEMINI KEY CHECK ===');
console.log(`Gemini key present: ${Boolean(trimmedKey)}`);
console.log(`Gemini key length: ${trimmedKey ? trimmedKey.length : 0}`);

// Query available models
try {
  const listRes = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${trimmedKey}`);
  const models = (listRes.data.models || []).map(m => m.name.replace('models/', ''));
  console.log('Available models for this key:', models);
} catch (listErr) {
  console.log('Failed to list models:', listErr.response?.status, listErr.response?.data?.error?.message);
}

// Test models with the image
const testFile = 'C:\\Users\\KARTHIKEYAN\\.gemini\\antigravity-ide\\brain\\88a9b527-975a-47ef-ac0f-f8feeb351316\\.user_uploaded\\media_1789954009901.jpg';
const buffer = fs.readFileSync(testFile);

const candidateModels = ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.0-flash-exp'];

for (const m of candidateModels) {
  console.log(`\nTesting model "${m}"...`);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${trimmedKey}`;
  try {
    const res = await axios.post(endpoint, {
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') } },
          { text: 'Extract headline and date in JSON.' }
        ]
      }]
    }, { timeout: 20000 });
    console.log(`✅ Model "${m}" SUCCESS! Status: ${res.status}`);
    console.log(res.data?.candidates?.[0]?.content?.parts?.[0]?.text);
    break;
  } catch (err) {
    console.log(`❌ Model "${m}" FAILED! Status: ${err.response?.status}`);
    console.log(`Message: ${err.response?.data?.error?.message}`);
  }
}
