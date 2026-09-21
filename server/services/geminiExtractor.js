import axios from 'axios';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is freshly loaded if updated
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config();

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts structured metadata from an image or PDF buffer using Gemini.
 * Uses gemini-3.6-flash as default, with automatic fallback models.
 * 
 * @param {Buffer} buffer - Ephemeral file buffer in memory
 * @param {string} mimeType - e.g. 'image/jpeg', 'image/png', 'application/pdf'
 * @returns {Promise<{
 *   result: object | null,
 *   errorReason: string | null
 * }>}
 */
export async function extractWithGemini(buffer, mimeType = 'image/jpeg') {
  // Re-check env dynamically to support runtime .env additions
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  const rawKey = process.env.GEMINI_API_KEY;
  const apiKey = rawKey ? rawKey.trim() : '';
  const configuredModel = (process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim();

  // Primary model and fallback model cascade if 404/deprecated
  const candidateModels = [configuredModel, 'gemini-3.6-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const uniqueModels = [...new Set(candidateModels)];

  console.log(`[GeminiExtractor] Runtime Key Check: present=${Boolean(apiKey)}, length=${apiKey ? apiKey.length : 0}`);

  if (!apiKey) {
    const reason = 'No GEMINI_API_KEY configured in server/.env';
    console.warn(`[GeminiExtractor] ${reason}. Bypassing to local Sharp + Tesseract + Ollama pipeline.`);
    return { result: null, errorReason: reason };
  }

  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { result: null, errorReason: 'Empty buffer' };
  }

  // Normalize mimeType
  let normalizedMime = mimeType;
  if (!normalizedMime || normalizedMime === 'application/octet-stream') {
    if (buffer.subarray(0, 4).toString() === '%PDF') {
      normalizedMime = 'application/pdf';
    } else if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      normalizedMime = 'image/jpeg';
    } else {
      normalizedMime = 'image/png';
    }
  }

  const promptText = [
    'You are an expert newspaper and document intelligence analyst.',
    'Carefully inspect the uploaded document/image/PDF and extract the structured metadata for the primary lead news story or most prominent report.',
    'STRICT FACTUALITY RULE: Extract only facts directly stated in the text. If a field is not present or cannot be determined with certainty, set it to null. Never guess or hallucinate.',
    '',
    'Field definitions:',
    '- headline: Main headline/title of the primary lead article or report (e.g. "India\'s emissions below global average, says Modi"), or null if unreadable.',
    '- date: Publication date if visible in the document (check header, dateline, or masthead). Convert strictly to YYYY-MM-DD format (e.g. 2020-09-20). If only month/day/year visible, convert to YYYY-MM-DD. Null if not visible.',
    '- author: Journalist, reporter, or news agency byline if visible (e.g. "Jacob Koshy"), otherwise null.',
    '- page_no: Page number or section identifier if visible (e.g. "1", "Front Page"), otherwise null.',
    '- info: The factual event described in the primary text (who, what, where, when). Short, clear paragraph. Null if unreadable.',
    '- summary: A 2-3 sentence executive summary of the content and its strategic significance. Null if unreadable.',
    '- full_text: The transcribed text of the article/document preserving paragraphs. Null if unreadable.',
    '- legible: Boolean. Set to true if headline and article text can be read (even if from a mobile capture or newspaper clipping). Only set to false if the image is completely illegible, corrupted, or blank.'
  ].join('\n');

  const requestPayload = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: normalizedMime,
              data: buffer.toString('base64')
            }
          },
          {
            text: promptText
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          headline: { type: 'STRING', nullable: true },
          date: { type: 'STRING', nullable: true },
          author: { type: 'STRING', nullable: true },
          page_no: { type: 'STRING', nullable: true },
          info: { type: 'STRING', nullable: true },
          summary: { type: 'STRING', nullable: true },
          full_text: { type: 'STRING', nullable: true },
          legible: { type: 'BOOLEAN' }
        },
        required: ['headline', 'date', 'author', 'page_no', 'info', 'summary', 'full_text', 'legible']
      }
    }
  };

  let lastErrorReason = null;

  for (const currentModel of uniqueModels) {
    const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`;
    let attempt = 0;

    while (attempt <= MAX_RETRIES) {
      attempt++;
      console.log(`[GeminiExtractor] Attempt ${attempt}/${MAX_RETRIES + 1} using model "${currentModel}" (${(buffer.length / 1024).toFixed(1)} KB ${normalizedMime})...`);

      try {
        const response = await axios.post(endpointUrl, requestPayload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000
        });

        const status = response.status;
        console.log(`[GeminiExtractor] HTTP Status: ${status} (Model: ${currentModel})`);

        const candidate = response.data?.candidates?.[0];
        const textOutput = candidate?.content?.parts?.[0]?.text;

        if (!textOutput) {
          lastErrorReason = `Gemini returned empty candidate output (HTTP ${status})`;
          console.warn(`[GeminiExtractor] ${lastErrorReason}`);
          break; // Try next model
        }

        const parsed = JSON.parse(textOutput);

        // Validate date format YYYY-MM-DD
        let validDate = null;
        if (typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date.trim())) {
          validDate = parsed.date.trim();
        }

        // Validate page_no length
        let validPage = null;
        if (typeof parsed.page_no === 'string' && parsed.page_no.trim().length <= 30) {
          validPage = parsed.page_no.trim();
        }

        const validInfo = (typeof parsed.info === 'string' && parsed.info.trim().length > 0) ? parsed.info.trim() : null;
        const validSummary = (typeof parsed.summary === 'string' && parsed.summary.trim().length > 0) ? parsed.summary.trim() : null;
        const validHeadline = (typeof parsed.headline === 'string' && parsed.headline.trim().length > 0) ? parsed.headline.trim() : null;
        const validAuthor = (typeof parsed.author === 'string' && parsed.author.trim().length > 0) ? parsed.author.trim() : null;
        const validFullText = (typeof parsed.full_text === 'string' && parsed.full_text.trim().length > 0) ? parsed.full_text.trim() : null;
        const isLegible = Boolean(parsed.legible);

        return {
          result: {
            headline: validHeadline,
            date: validDate,
            author: validAuthor,
            page_no: validPage,
            info: validInfo,
            summary: validSummary,
            full_text: validFullText,
            legible: isLegible,
            engine: 'gemini',
            model: currentModel
          },
          errorReason: null
        };
      } catch (err) {
        const status = err.response?.status;
        const errorMsg = err.response?.data?.error?.message || err.message;
        lastErrorReason = `Gemini error (HTTP ${status || 'Network'}): ${errorMsg}`;

        // Explicitly log the HTTP status and error message (never the API key)
        console.warn(`[GeminiExtractor] Call failed on model "${currentModel}" - Status: ${status || 'Network Error'} | Message: ${errorMsg}`);

        // If 404 (model deprecated or not found), do not retry this model; cascade to next model
        if (status === 404) {
          console.log(`[GeminiExtractor] Model "${currentModel}" is unavailable (404). Cascading to fallback model...`);
          break;
        }

        // Retry on rate limit (429) or server error (5xx)
        const isRetryable = status === 429 || (status >= 500 && status < 600) || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
        if (isRetryable && attempt <= MAX_RETRIES) {
          const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          console.log(`[GeminiExtractor] Retrying ${currentModel} in ${backoffMs}ms...`);
          await sleep(backoffMs);
        } else {
          break; // Non-retryable or retries exhausted for this model
        }
      }
    }
  }

  console.warn(`[GeminiExtractor] All Gemini model attempts failed: ${lastErrorReason}. Falling back to Sharp + Tesseract + Ollama.`);
  return { result: null, errorReason: lastErrorReason };
}
