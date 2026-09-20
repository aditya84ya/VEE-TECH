import axios from 'axios';
import * as pdfParseModule from 'pdf-parse';
import { createWorker } from 'tesseract.js';

let ocrWorker = null;

async function getOcrWorker() {
  if (!ocrWorker) {
    try {
      ocrWorker = await createWorker('eng');
    } catch (e) {
      console.warn('[AutonomousMediaService] ⚠️ Could not initialize Tesseract worker:', e.message);
      return null;
    }
  }
  return ocrWorker;
}

async function extractPdfText(buffer) {
  try {
    if (pdfParseModule.PDFParse) {
      const parser = new pdfParseModule.PDFParse({ data: buffer });
      const parsed = await parser.getText();
      const text = (parsed?.text || '').trim();
      try {
        await parser.destroy();
      } catch (_) {}
      return text;
    }
    const pdfFn = pdfParseModule.default || pdfParseModule;
    if (typeof pdfFn === 'function') {
      const parsed = await pdfFn(buffer, { max: 3 });
      return (parsed.text || '').trim();
    }
    return '';
  } catch (err) {
    throw err;
  }
}

/**
 * Autonomous Media Interception & Extraction Service
 * Intercepts PDFs and Images from BSE announcements, Sitemaps, Bluesky, etc.
 * Enriches raw_content with extracted text before AI triage.
 *
 * @param {object} articlePayload
 * @returns {Promise<object>} Enriched article payload
 */
export async function processAutonomousMedia(articlePayload) {
  const mediaUrl = articlePayload.mediaUrl || articlePayload.pdfUrl || articlePayload.imageUrl || articlePayload.image;

  if (!mediaUrl || typeof mediaUrl !== 'string' || !mediaUrl.startsWith('http')) {
    return articlePayload;
  }

  try {
    // 1. Fetch the image/PDF into memory (max 4 seconds to strictly protect <120s SLA)
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 4000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    const buffer = Buffer.from(response.data);
    const contentType = (response.headers['content-type'] || '').toLowerCase();
    const isPdf = mediaUrl.toLowerCase().endsWith('.pdf') || contentType.includes('pdf');
    let extractedText = '';

    if (isPdf) {
      // PDF text extraction via pdf-parse
      try {
        extractedText = await extractPdfText(buffer);
      } catch (pdfErr) {
        console.warn(`[AutonomousMedia] ⚠️ PDF parse notice for "${articlePayload.title?.slice(0, 40)}":`, pdfErr.message);
      }
    } else if (contentType.includes('image') || /\.(jpg|jpeg|png|webp)/i.test(mediaUrl)) {
      // Image OCR via Tesseract.js
      try {
        const worker = await getOcrWorker();
        if (worker) {
          const ret = await Promise.race([
            worker.recognize(buffer),
            new Promise((_, reject) => setTimeout(() => reject(new Error('OCR Timeout (>3.5s)')), 3500))
          ]);
          extractedText = (ret?.data?.text || '').trim();
        }
      } catch (ocrErr) {
        console.warn(`[AutonomousMedia] ⚠️ Image OCR notice for "${articlePayload.title?.slice(0, 40)}":`, ocrErr.message);
      }
    }

    // 2. Append the extracted text to the article content for Ollama reasoning
    if (extractedText && extractedText.length > 20) {
      const cleanExtract = extractedText.replace(/\s+/g, ' ').slice(0, 2500);
      articlePayload.raw_content = `${articlePayload.raw_content || articlePayload.title}\n\n[AUTONOMOUS_MEDIA_OCR_EXTRACT]:\n${cleanExtract}`;
      articlePayload.hasMediaExtraction = true;
      console.log(`[AutonomousMedia] 📄 Extracted ${cleanExtract.length} chars from media (${isPdf ? 'PDF' : 'IMAGE'}) for "${articlePayload.title?.slice(0, 40)}..."`);
    }
  } catch (error) {
    // Fail silently and let the text-only article proceed cleanly to Ollama
    console.warn(`[AutonomousMedia] ⏭ Skipped media for "${articlePayload.title?.slice(0, 40)}": ${error.message}`);
  }

  return articlePayload;
}
