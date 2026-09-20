import axios from 'axios';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

// 1. Fast heuristic blacklist check for obvious non-news (sports, personal, lifestyle)
const LIFESTYLE_BLACKLIST =
  /\b(marathon|running|race|training|strava|workout|recipe|birthday|vacation|selfie|gym|fitness)\b/i;

// Fallback corporate financial anchor words
const CORPORATE_ANCHORS =
  /\b(shares|stock|ceo|cfo|board|sebi|earnings|fraud|lawsuit|revenue|quarter|market|bse|nse|contract|raid|acquisition|merger|guidance|dividend|layoffs|deal|hiring|resignation)\b/i;

/**
 * Validates whether an incoming post + OCR text is a genuine corporate/financial
 * news event or a false positive (lifestyle, sports, personal photos, memes, anime).
 *
 * @param {string} caption       The title, tweet, or post caption
 * @param {string} ocrText       Any extracted OCR text, body, or content
 * @param {string} targetCompany Target corporate entity (e.g., 'TCS', 'Infosys', 'Wipro', 'Accenture')
 * @param {boolean} hasImage     Whether an image attachment is present on the post
 * @returns {Promise<{isValid: boolean, reason: string, confidenceScore?: number}>}
 */
export async function validatePostContext(caption = '', ocrText = '', targetCompany = 'Infosys', hasImage = false) {
  const cleanCaption = String(caption || '').trim();
  const cleanOcr = String(ocrText || '').trim();
  const combinedText = `Caption: "${cleanCaption}"\nOCR / Content Text: "${cleanOcr}"`;

  // 1. Fast heuristic blacklist check for obvious non-news
  if (LIFESTYLE_BLACKLIST.test(combinedText)) {
    return { isValid: false, reason: 'Triggered lifestyle/sports context blacklist' };
  }

  // 2. Strict Image-to-Caption Relevance & Substance Check
  // If an image is attached, OCR must extract meaningful textual substance.
  // Anime drawings, selfies, graphics, or memes yield near-zero or noisy text (< 35 chars).
  if (hasImage && cleanOcr.length < 35) {
    return {
      isValid: false,
      reason: 'Image lacks corporate textual substance (possible meme/anime attachment)'
    };
  }

  // 3. Keyword-stuffing check:
  // If the caption is just comma/space/hashtag separated company names without a narrative
  const strippedCaption = cleanCaption
    .replace(/\b(infosys|infy|tcs|tata\s+consultancy|wipro|accenture|sebi|bse|nse|finacle)\b/gi, '')
    .replace(/[,#|;:\/\-\s]/g, '')
    .trim();
  if (strippedCaption.length < 10 && cleanOcr.length < 35) {
    return {
      isValid: false,
      reason: 'Keyword-stuffed caption without substantive corporate narrative'
    };
  }

  // 4. Local Ollama LLM Context Verification
  try {
    const prompt = `You are a strict financial news filter for a corporate crisis war room monitoring ${targetCompany}.
Analyze the following social media post and image OCR text. Determine if this is a genuine corporate, financial, regulatory, or business news event regarding ${targetCompany}.

Strict Negative Criteria:
- If the post uses comma-separated company keywords in the caption (e.g. 'TCS, Infosys, Wipro') but attaches an unrelated image (like anime characters, art, memes, or personal photos), or contains no meaningful business development or narrative, classify it as isRelevantCorporateNews: false.
- Ignore personal photos, sports events, running marathons, tourist check-ins, or casual mentions where the company name is used out of context (e.g., city names, acronyms like Truth or Consequences, Theoretical Computer Science, running marathons, selfies).

Content to analyze:
${combinedText}
${hasImage ? `[Image Attached: Yes, OCR Extracted Length: ${cleanOcr.length} chars]` : ''}

Return ONLY a JSON response in this exact format:
{
  "isRelevantCorporateNews": true,
  "confidenceScore": 90,
  "reason": "short explanation"
}`;

    const response = await axios.post(
      `${OLLAMA_BASE_URL}/api/generate`,
      {
        model: OLLAMA_MODEL,
        prompt: prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.1 }
      },
      { timeout: 12000 }
    );

    const raw = response.data?.response;
    if (!raw) {
      throw new Error('Empty response from Ollama');
    }

    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // Require strict validation and minimum 75 confidence score
    if (!result.isRelevantCorporateNews || Number(result.confidenceScore || 0) < 75) {
      return {
        isValid: false,
        reason: result.reason || 'Failed LLM corporate relevance check',
        confidenceScore: result.confidenceScore
      };
    }

    return {
      isValid: true,
      reason: result.reason || 'Verified corporate context',
      confidenceScore: result.confidenceScore
    };
  } catch (err) {
    console.warn(`[ContentValidator] LLM check notice (${err.message}) - evaluating corporate anchors`);
    // Fallback: if LLM fails, require at least one corporate financial anchor word
    const hasAnchor = CORPORATE_ANCHORS.test(combinedText);
    return {
      isValid: hasAnchor,
      reason: hasAnchor ? 'Fallback corporate anchor match' : 'No corporate anchor found'
    };
  }
}
