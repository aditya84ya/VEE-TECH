import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import axios from 'axios';
import FormData from 'form-data';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

const testFile = 'C:\\Users\\KARTHIKEYAN\\.gemini\\antigravity-ide\\brain\\88a9b527-975a-47ef-ac0f-f8feeb351316\\.user_uploaded\\media_1789954009901.jpg';

async function testManualUpload() {
  console.log('Testing /api/manual-upload endpoint with the user test file...\n');
  const buffer = fs.readFileSync(testFile);

  const form = new FormData();
  form.append('file', buffer, {
    filename: 'the_hindu_page.jpg',
    contentType: 'image/jpeg'
  });
  form.append('publication_name', 'The Hindu E-Paper');
  form.append('is_historical', 'true');

  try {
    const res = await axios.post('http://localhost:5000/api/manual-upload', form, {
      headers: form.getHeaders(),
      timeout: 60000
    });

    console.log('✅ Response HTTP Status:', res.status);
    console.log('Extracted Data:');
    console.log('- Engine Used:', res.data.article?.ocr_engine);
    console.log('- Engine Reason:', res.data.article?.engine_reason);
    console.log('- Low Resolution:', res.data.article?.is_low_resolution);
    console.log('- Resolution Warning:', res.data.article?.resolution_warning);
    console.log('- OCR Confidence:', res.data.ocr?.confidence);
    console.log('- OCR Quality:', res.data.ocr?.ocr_quality);
    console.log('- Headline:', res.data.article?.title);
    console.log('- Date:', res.data.article?.pub_date);
    console.log('- Author:', res.data.article?.author);
    console.log('- Page:', res.data.article?.page_no);
    console.log('- Info:', res.data.article?.info);
    console.log('- Summary:', res.data.article?.summary);
    console.log('- Full OCR / Content length:', res.data.article?.raw_content?.length);
  } catch (err) {
    console.log('❌ Request failed:', err.response?.status, err.response?.data || err.message);
  }
}

testManualUpload();
