import axios from 'axios';

/**
 * On-demand deep-dive verification tool using Google Custom Search JSON API.
 * Protected with on-demand invocation (never placed in continuous polling loop)
 * to strictly preserve the 100 queries/day quota.
 *
 * @param {string} query Search terms for corroborating sources
 * @returns {Promise<Array<{ title: string, snippet: string, url: string, source: string }>>}
 */
export async function fetchVerificationContext(query) {
  const API_KEY = (process.env.GOOGLE_CUSTOM_SEARCH_KEY || '').trim();
  const CX_ID = (process.env.GOOGLE_CX_ID || '').trim();

  if (!API_KEY || !CX_ID) {
    console.warn('[Verification] Google Custom Search keys missing (GOOGLE_CUSTOM_SEARCH_KEY / GOOGLE_CX_ID).');
    return [];
  }

  try {
    console.log(`[Verification] Triggering deep-dive web search for: ${query}`);
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: API_KEY,
        cx: CX_ID,
        q: query,
        num: 5 // Fetch top 5 corroborating results
      },
      timeout: 6000,
      headers: {
        'User-Agent': 'VeeAlert-Verification/1.0 (Threat Deep Dive)'
      }
    });

    if (!response.data || !Array.isArray(response.data.items)) {
      return [];
    }

    return response.data.items.map((item) => ({
      title: item.title,
      snippet: item.snippet,
      url: item.link,
      source: item.displayLink || (item.link ? new URL(item.link).hostname : 'web')
    }));
  } catch (error) {
    console.error('[Verification] Custom Search failed or quota exceeded:', error.response?.data?.error?.message || error.message);
    return [];
  }
}
