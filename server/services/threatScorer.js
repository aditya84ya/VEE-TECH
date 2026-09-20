/**
 * Threat Severity & Risk Scorer
 * 
 * Enforces critical keyword dictionary and transparent risk scoring tiers:
 * - CRITICAL: >= 9.0 (Default score: 9.8)
 * - HIGH: 7.0 - 8.9 (Default score: 7.5)
 * - MEDIUM/LOW: <= 6.9 (Default score: 2.5 - 5.0)
 */

export const CRITICAL_KEYWORDS = [
  'sebi emergency',
  'emergency order',
  'trading suspended',
  'trading terminated',
  'arrest',
  'arrests',
  'fraud',
  'enforcement directorate',
  'money laundering',
  'insolvency',
  'bankruptcy',
  'liquidation',
  'asset seizure',
  'assets seized',
  'whistleblower'
];

export const HIGH_KEYWORDS = [
  'rbi',
  'sebi',
  'regulator',
  'probe',
  'investigation',
  'subpoena',
  'penalty',
  'fine',
  'lawsuit',
  'outage',
  'blackout',
  'ransomware',
  'security breach',
  'cyberattack',
  'contract loss',
  'downgrade',
  'audit notice',
  'sec probe',
  'enforcement action'
];

/**
 * Checks whether text contains any high-impact critical distress keyword
 * @param {string} text
 * @returns {string|null} Matched critical keyword or null
 */
export function matchCriticalKeyword(text = '') {
  const lower = String(text || '').toLowerCase();
  for (const kw of CRITICAL_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

/**
 * Checks whether text contains any high-impact crisis keyword
 * @param {string} text
 * @returns {string|null} Matched high keyword or null
 */
export function matchHighKeyword(text = '') {
  const lower = String(text || '').toLowerCase();
  for (const kw of HIGH_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

/**
 * Evaluates threat severity, score, and level for an incoming article
 * @param {string} title 
 * @param {string} content 
 * @param {string} entity 
 * @returns {{ severity: string, risk_level: string, score: number, risk_score: number, matchedKeyword: string|null }}
 */
export function evaluateThreatSeverity(title = '', content = '', entity = '') {
  const fullText = `${title} ${content}`.toLowerCase();

  // Tier 1: CRITICAL (Score: 9.8, Severity: 'CRITICAL')
  const matchedCritical = matchCriticalKeyword(fullText);
  if (matchedCritical) {
    return {
      severity: 'CRITICAL',
      risk_level: 'Critical',
      score: 9.8,
      risk_score: 9.8,
      isCritical: true,
      isHigh: false,
      matchedKeyword: matchedCritical
    };
  }

  // Tier 2: HIGH (Score: 7.5, Severity: 'HIGH')
  const matchedHigh = matchHighKeyword(fullText);
  if (matchedHigh) {
    return {
      severity: 'HIGH',
      risk_level: 'High',
      score: 7.5,
      risk_score: 7.5,
      isCritical: false,
      isHigh: true,
      matchedKeyword: matchedHigh
    };
  }

  // Tier 3: LOW / Routine
  const isRoutine = /chip design|semiconductor|product launch|partnership|sponsorship|expansion|indore|hiring|patent|facility|centre|results|quarterly|automotive/.test(fullText);
  if (isRoutine) {
    return {
      severity: 'LOW',
      risk_level: 'Low',
      score: 2.5,
      risk_score: 2.5,
      isCritical: false,
      isHigh: false,
      matchedKeyword: null
    };
  }

  // Default: MEDIUM (Score: 5.0)
  return {
    severity: 'MEDIUM',
    risk_level: 'Medium',
    score: 5.0,
    risk_score: 5.0,
    isCritical: false,
    isHigh: false,
    matchedKeyword: null
  };
}

export default {
  CRITICAL_KEYWORDS,
  HIGH_KEYWORDS,
  matchCriticalKeyword,
  matchHighKeyword,
  evaluateThreatSeverity
};
