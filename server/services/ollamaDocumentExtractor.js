import axios from 'axios';

/**
 * Ollama Document Intelligence Extractor (Fallback Engine)
 * 
 * Uses local Ollama model (e.g. Qwen 2.5:7b) with temperature 0 and format: "json"
 * to extract structured metadata: date, author, page_no, info, summary.
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

/**
 * Extracts structured metadata from OCR text using Ollama.
 * 
 * @param {string} rawOcrText - The raw text extracted from OCR
 * @param {number} ocrConfidence - The confidence score (0-100)
 * @returns {Promise<{
 *   date: string | null,
 *   author: string | null,
 *   page_no: string | null,
 *   info: string | null,
 *   summary: string | null,
 *   unreadable?: boolean,
 *   unreadableMessage?: string
 * }>}
 */
export async function extractWithOllama(rawOcrText, ocrConfidence = 0) {
  const text = (rawOcrText || '').trim();

  // Guardrail: If OCR confidence is < 50% or raw text is under 100 characters, do NOT run brief
  if (ocrConfidence < 50 || text.length < 100) {
    console.log(`[OllamaDocumentExtractor] Document marked unreadable (Confidence: ${ocrConfidence}%, Chars: ${text.length}). Skipping brief.`);
    return {
      date: null,
      author: null,
      page_no: null,
      info: null,
      summary: null,
      unreadable: true,
      unreadableMessage: 'Text unreadable: please upload a clearer file'
    };
  }

  const prompt = [
    'You are an expert news document extractor. Extract structured metadata from the following OCR text.',
    'Extract only facts directly stated in the text. If a field is not present or cannot be determined with certainty, set it to null. Never guess or hallucinate.',
    '',
    'Return ONLY a valid JSON object matching this schema:',
    '{',
    '  "date": string | null,',
    '  "author": string | null,',
    '  "page_no": string | null,',
    '  "info": string | null,',
    '  "summary": string | null',
    '}',
    '',
    'Field specifications:',
    '- date: publication date if visible in the text. Format strictly as YYYY-MM-DD. Null if not visible.',
    '- author: journalist, reporter, or news agency byline if visible. Null if not visible.',
    '- page_no: page number or section if visible (e.g. "1", "A3", "Page 12"). Null if not visible.',
    '- info: the factual event described in the text (who, what, where, when). Short, clear paragraph. Null if unreadable.',
    '- summary: a 2-3 sentence executive summary of the content and its significance. Null if unreadable.',
    '',
    'Do not output any markdown fences, conversational commentary, or explanation. Return JSON only.',
    '',
    `OCR Text:`,
    text
  ].join('\n');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: {
        temperature: 0
      }
    }, {
      timeout: 45000,
      signal: controller.signal
    });

    clearTimeout(timeout);

    const rawResponse = response.data?.response;
    if (!rawResponse) {
      throw new Error('Empty response from Ollama generate API');
    }

    const sanitized = String(rawResponse).trim().replace(/^```json\s*/i, '').replace(/```$/i, '');
    const parsed = JSON.parse(sanitized);

    // Strict validation
    let validDate = null;
    if (typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date.trim())) {
      validDate = parsed.date.trim();
    }

    let validPage = null;
    if (typeof parsed.page_no === 'string' && parsed.page_no.trim().length <= 30 && parsed.page_no.trim().length > 0) {
      validPage = parsed.page_no.trim();
    }

    const validAuthor = (typeof parsed.author === 'string' && parsed.author.trim().length > 0)
      ? parsed.author.trim()
      : null;

    const validInfo = (typeof parsed.info === 'string' && parsed.info.trim().length > 0)
      ? parsed.info.trim()
      : null;

    const validSummary = (typeof parsed.summary === 'string' && parsed.summary.trim().length > 0)
      ? parsed.summary.trim()
      : null;

    return {
      date: validDate,
      author: validAuthor,
      page_no: validPage,
      info: validInfo,
      summary: validSummary,
      unreadable: false
    };
  } catch (err) {
    console.warn('[OllamaDocumentExtractor] Extraction error:', err.message);
    return {
      date: null,
      author: null,
      page_no: null,
      info: null,
      summary: null,
      unreadable: false
    };
  }
}
