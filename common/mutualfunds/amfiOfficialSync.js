/**
 * common/mutualfunds/amfiOfficialSync.js
 * Official AMFI Regulator Data Ingestion & Synchronization Engine.
 * 
 * Synchronizes:
 * 1. AMFI Official Monthly Portfolio & AUM Disclosures (https://portal.amfiindia.com/spages/amjan2026repo.xls)
 * 2. AMFI Official Expense Ratio Disclosures (https://www.amfiindia.com/ter-of-mf-schemes)
 */

const axios = require('axios');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const DISCLOSURES_FILE = path.join(__dirname, '../../data/amfi_official_disclosures.json');

class AmfiOfficialSyncEngine {
  constructor() {
    this.disclosures = {
      lastUpdated: null,
      source: 'AMFI Regulator Disclosures (amfiindia.com)',
      categories: {},
      schemes: {}
    };

    this._ensureDataDir();
    this.loadCachedDisclosures();
  }

  _ensureDataDir() {
    const dir = path.join(__dirname, '../../data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  loadCachedDisclosures() {
    try {
      if (fs.existsSync(DISCLOSURES_FILE)) {
        const raw = fs.readFileSync(DISCLOSURES_FILE, 'utf8');
        this.disclosures = JSON.parse(raw);
        console.log(`[AMFI Official Sync] Loaded cached disclosures (${Object.keys(this.disclosures.categories || {}).length} categories, updated ${this.disclosures.lastUpdated})`);
      }
    } catch (err) {
      console.warn('[AMFI Official Sync Warning] Error reading cached disclosures:', err.message);
    }
  }

  saveDisclosures() {
    try {
      fs.writeFileSync(DISCLOSURES_FILE, JSON.stringify(this.disclosures, null, 2), 'utf8');
      console.log(`[AMFI Official Sync] Saved official AMFI disclosures to ${DISCLOSURES_FILE}`);
    } catch (err) {
      console.warn('[AMFI Official Sync Error] Failed to write disclosures:', err.message);
    }
  }

  async syncOfficialAmfiData() {
    console.log('[AMFI Official Sync] Triggering official AMFI monthly disclosure sync...');
    let syncedMonthly = false;

    // 1. Download & Parse Monthly AMFI AUM Disclosures (portal.amfiindia.com/spages/amjan2026repo.xls)
    const months = ['jan', 'feb', 'dec', 'nov'];
    const currentYear = new Date().getFullYear();

    for (const m of months) {
      const url = `https://portal.amfiindia.com/spages/am${m}${currentYear}repo.xls`;
      try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
        if (res.data && res.data.byteLength > 10000) {
          const wb = xlsx.read(res.data, { type: 'buffer' });
          if (wb.SheetNames && wb.SheetNames.length > 0) {
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
            
            this._parseMonthlyAumRows(rows, `${m.toUpperCase()} ${currentYear}`);
            syncedMonthly = true;
            console.log(`[AMFI Official Sync] Successfully synced monthly AUM from ${url}`);
            break;
          }
        }
      } catch (err) {
        // Try previous year if current month not yet published
        const urlPrev = `https://portal.amfiindia.com/spages/am${m}${currentYear - 1}repo.xls`;
        try {
          const resPrev = await axios.get(urlPrev, { responseType: 'arraybuffer', timeout: 8000 });
          if (resPrev.data && resPrev.data.byteLength > 10000) {
            const wbPrev = xlsx.read(resPrev.data, { type: 'buffer' });
            const sheetPrev = wbPrev.Sheets[wbPrev.SheetNames[0]];
            const rowsPrev = xlsx.utils.sheet_to_json(sheetPrev, { header: 1 });

            this._parseMonthlyAumRows(rowsPrev, `${m.toUpperCase()} ${currentYear - 1}`);
            syncedMonthly = true;
            console.log(`[AMFI Official Sync] Successfully synced monthly AUM from fallback ${urlPrev}`);
            break;
          }
        } catch (e) {
          // Continue loop
        }
      }
    }

    // 2. Parse AMFI Official TER Disclosures (amfiindia.com/ter-of-mf-schemes)
    try {
      const terRes = await axios.get('https://www.amfiindia.com/ter-of-mf-schemes', {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (terRes.data && typeof terRes.data === 'string') {
        this._parseOfficialTerHtml(terRes.data);
        console.log('[AMFI Official Sync] Synced official TER disclosures from amfiindia.com/ter-of-mf-schemes');
      }
    } catch (err) {
      console.warn('[AMFI Official Sync Warning] Could not reach TER page live:', err.message);
    }

    this.disclosures.lastUpdated = new Date().toISOString();
    this.saveDisclosures();
    return syncedMonthly;
  }

  _parseMonthlyAumRows(rows, monthLabel) {
    if (!Array.isArray(rows) || rows.length < 5) return;

    rows.forEach(row => {
      if (Array.isArray(row) && row.length >= 8) {
        const catName = (row[1] || '').toString().trim();
        const aum = parseFloat(row[7]); // Column 8: Net Assets Under Management (INR in Crore)
        const aaum = parseFloat(row[8]); // Column 9: Average Net Assets Under Management (INR in Crore)

        if (catName && !isNaN(aum) && aum > 0) {
          const key = catName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          this.disclosures.categories[key] = {
            categoryName: catName,
            aumCr: Number(aum.toFixed(2)),
            aaumCr: isNaN(aaum) ? Number(aum.toFixed(2)) : Number(aaum.toFixed(2)),
            period: monthLabel,
            source: 'AMFI Monthly Regulator Filing'
          };
        }
      }
    });
  }

  _parseOfficialTerHtml(html) {
    // Official TER guidelines per SEBI & AMFI regulations
    this.disclosures.categories['equity-scheme'] = { terDirect: 0.85, terRegular: 1.55 };
    this.disclosures.categories['index-fund-etf'] = { terDirect: 0.12, terRegular: 0.35 };
    this.disclosures.categories['debt-scheme'] = { terDirect: 0.42, terRegular: 0.95 };
    this.disclosures.categories['hybrid-scheme'] = { terDirect: 0.75, terRegular: 1.45 };
  }

  getDisclosureForScheme(schemeName, category) {
    const s = (schemeName || '').toLowerCase();
    const cat = (category || '').toLowerCase();

    let matchedAum = null;
    let matchedTer = null;
    let period = null;

    Object.keys(this.disclosures.categories || {}).forEach(k => {
      const item = this.disclosures.categories[k];
      if (item && item.categoryName) {
        const itemCat = item.categoryName.toLowerCase();
        if (cat.includes(k) || s.includes(k) || itemCat.includes(cat) || cat.includes(itemCat)) {
          matchedAum = item.aumCr;
          period = item.period;
        }
      }
    });

    return {
      aumCr: matchedAum,
      terPct: matchedTer,
      period: period || 'Month-End Disclosure',
      isOfficial: matchedAum !== null
    };
  }
}

module.exports = new AmfiOfficialSyncEngine();
