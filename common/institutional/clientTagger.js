/**
 * common/institutional/clientTagger.js
 * Client Categorization & Lookup Tagging Engine for NSE Bulk & Block Deals
 */

const AMC_KEYWORDS = [
  'MUTUAL FUND', ' MF', 'MF ', 'ASSET MANAGEMENT', 'AMC', 'TRUSTEE',
  'NIPPON INDIA', 'SBI MUTUAL', 'HDFC MUTUAL', 'ICICI PRUDENTIAL MUTUAL',
  'KOTAK MAHINDRA MUTUAL', 'QUANT MUTUAL', 'UTI MUTUAL', 'AXIS MUTUAL',
  'DSP MUTUAL', 'TATA MUTUAL', 'MIRAE ASSET', 'SUNDARAM MUTUAL',
  'BANDHAN MUTUAL', 'EDELWEISS MUTUAL', 'MOTILAL OSWAL MUTUAL',
  'CANARA ROBECO', 'INVESCO MUTUAL', 'FRANKLIN TEMPLETON', 'BARODA BNP',
  'HSBC MUTUAL', 'LIC MUTUAL', 'UNION MUTUAL', 'MAHINDRA MANULIFE',
  'PGIM INDIA', 'TAURUS MUTUAL', 'ITI MUTUAL', 'BOI MUTUAL', 'WHITEOAK CAPITAL'
];

const INSURANCE_KEYWORDS = [
  'LIFE INSURANCE', 'GENERAL INSURANCE', 'LIC OF INDIA', 'L.I.C.',
  'ICICI PRUDENTIAL LIFE', 'HDFC LIFE', 'SBI LIFE', 'MAX LIFE',
  'BAJAJ ALLIANZ', 'TATA AIA', 'KOTAK MAHINDRA LIFE', 'STAR HEALTH',
  'RELIANCE NIPPON LIFE', 'UNITED INDIA INSURANCE', 'NEW INDIA ASSURANCE',
  'NATIONAL INSURANCE', 'ORIENTAL INSURANCE'
];

const FPI_KEYWORDS = [
  'FPI', 'FOREIGN PORTFOLIO', 'FII', 'GOVERNMENT PENSION FUND',
  'NORGES BANK', 'MORGAN STANLEY', 'GOLDMAN SACHS', 'SOCIETE GENERALE',
  'CITIGROUP', 'MERRILL LYNCH', 'BNP PARIBAS', 'NOMURA', 'CREDIT SUISSE',
  'JPMORGAN', 'BLACKROCK', 'VANGUARD', 'UBS', 'BARCLAYS', 'MACQUARIE',
  'COPTHALL', 'BASSWOOD', 'GOVT OF SINGAPORE', 'GIC PRIVATE', 'MONETARY AUTHORITY OF SINGAPORE',
  'FIDELITY', 'ABERDEEN', 'SCHRODER', 'TEMPLETON'
];

/**
 * Classifies a raw client name string into a client_type category
 * @param {string} clientName Raw client name from NSE bulk/block report
 * @param {string} stockSymbol Stock trading symbol
 * @param {Array<string>} [promotersList] Optional promoter/promoter group name list for stockSymbol
 * @returns {'mutual_fund'|'fpi'|'insurance'|'promoter'|'hni'|'unknown'}
 */
function tagClientType(clientName, stockSymbol = '', promotersList = []) {
  if (!clientName || typeof clientName !== 'string') return 'unknown';

  const cleanName = clientName.trim().toUpperCase();

  // 1. Check if client name matches stock's promoter list
  if (Array.isArray(promotersList) && promotersList.length > 0) {
    for (const p of promotersList) {
      if (p && cleanName.includes(p.toUpperCase())) {
        return 'promoter';
      }
    }
  }

  // 2. Check Mutual Funds
  for (const kw of AMC_KEYWORDS) {
    if (cleanName.includes(kw)) {
      return 'mutual_fund';
    }
  }

  // 3. Check Insurance Companies
  for (const kw of INSURANCE_KEYWORDS) {
    if (cleanName.includes(kw)) {
      return 'insurance';
    }
  }

  // 4. Check FPIs & Foreign Institutions
  for (const kw of FPI_KEYWORDS) {
    if (cleanName.includes(kw)) {
      return 'fpi';
    }
  }

  // 5. Default categorization fallback
  if (cleanName.includes('PROMOTER') || cleanName.includes('PROMOTER GROUP')) {
    return 'promoter';
  }

  return 'unknown';
}

module.exports = {
  tagClientType,
  AMC_KEYWORDS,
  INSURANCE_KEYWORDS,
  FPI_KEYWORDS
};
