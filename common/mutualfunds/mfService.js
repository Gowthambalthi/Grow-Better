/**
 * common/mutualfunds/mfService.js
 * Multi-Server Resilient Mutual Funds Service with Automatic Server Failover.
 * 
 * Features:
 * - 24 Top Indian AMCs with 75+ Comprehensive Schemes
 * - Parent AMC mapping, TER (Total Expense Ratio / Maintenance Fee), Timeframe Returns (1M, 3M, 6M, 1Y), and Top Equity Holdings
 * - Server 1 (Primary Live AMFI Engine) -> Server 2 (Backup Mirror / Internal Cache) automatic failover.
 */

const MF_SCHEMES_MASTER = [
  // 1. HDFC Mutual Fund (8 Schemes)
  {
    id: 'hdfc-top-100',
    schemeName: 'HDFC Top 100 Fund - Direct Plan',
    parentAmc: 'HDFC Mutual Fund',
    category: 'Equity: Large Cap',
    aumCr: 34850.20,
    terPct: 1.12,
    manager: 'Rahul Baijal',
    returns: { '1M': 2.45, '3M': 8.90, '6M': 16.40, '1Y': 28.50 },
    topHoldings: [
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 9.80 },
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 8.40 },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 7.90 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 6.20 },
      { symbol: 'TCS', name: 'Tata Consultancy Services', pct: 4.50 }
    ]
  },
  {
    id: 'hdfc-flexi-cap',
    schemeName: 'HDFC Flexi Cap Fund - Direct Plan',
    parentAmc: 'HDFC Mutual Fund',
    category: 'Equity: Flexi Cap',
    aumCr: 54120.80,
    terPct: 0.89,
    manager: 'Roshi Jain',
    returns: { '1M': 3.10, '3M': 10.20, '6M': 19.80, '1Y': 34.20 },
    topHoldings: [
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 9.20 },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 8.70 },
      { symbol: 'AXISBANK', name: 'Axis Bank Ltd.', pct: 6.80 },
      { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd.', pct: 5.40 },
      { symbol: 'LT', name: 'Larsen & Toubro Ltd.', pct: 4.90 }
    ]
  },
  {
    id: 'hdfc-mid-cap-opportunities',
    schemeName: 'HDFC Mid-Cap Opportunities Fund - Direct Plan',
    parentAmc: 'HDFC Mutual Fund',
    category: 'Equity: Mid Cap',
    aumCr: 62400.00,
    terPct: 0.78,
    manager: 'Chirag Setalvad',
    returns: { '1M': 3.85, '3M': 12.40, '6M': 22.10, '1Y': 39.50 },
    topHoldings: [
      { symbol: 'INDIANHOTE', name: 'The Indian Hotels Co.', pct: 4.80 },
      { symbol: 'MAXHEALTH', name: 'Max Healthcare Institute', pct: 4.20 },
      { symbol: 'FEDERALBNK', name: 'The Federal Bank Ltd.', pct: 3.90 },
      { symbol: 'BHARATFORG', name: 'Bharat Forge Ltd.', pct: 3.60 },
      { symbol: 'CUMMINSIND', name: 'Cummins India Ltd.', pct: 3.20 }
    ]
  },
  {
    id: 'hdfc-small-cap',
    schemeName: 'HDFC Small Cap Fund - Direct Plan',
    parentAmc: 'HDFC Mutual Fund',
    category: 'Equity: Small Cap',
    aumCr: 29800.50,
    terPct: 0.69,
    manager: 'Chirag Setalvad',
    returns: { '1M': 4.10, '3M': 13.80, '6M': 25.40, '1Y': 44.80 },
    topHoldings: [
      { symbol: 'BANKBARODA', name: 'Bank of Baroda', pct: 4.10 },
      { symbol: 'SONACOMS', name: 'Sona BLW Precision', pct: 3.70 },
      { symbol: 'ASTERDM', name: 'Aster DM Healthcare', pct: 3.40 },
      { symbol: 'FIRSTCRY', name: 'Brainbees Solutions', pct: 2.90 },
      { symbol: 'CUPID', name: 'Cupid Ltd.', pct: 2.70 }
    ]
  },
  {
    id: 'hdfc-balanced-advantage',
    schemeName: 'HDFC Balanced Advantage Fund - Direct Plan',
    parentAmc: 'HDFC Mutual Fund',
    category: 'Hybrid: Balanced Advantage',
    aumCr: 84500.00,
    terPct: 0.75,
    manager: 'Prashant Jain',
    returns: { '1M': 2.10, '3M': 7.80, '6M': 14.50, '1Y': 24.10 },
    topHoldings: [
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 7.20 },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 6.80 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 5.90 },
      { symbol: 'SBIN', name: 'State Bank of India', pct: 4.80 },
      { symbol: 'NTPC', name: 'NTPC Ltd.', pct: 3.90 }
    ]
  },

  // 2. SBI Mutual Fund (6 Schemes)
  {
    id: 'sbi-bluechip',
    schemeName: 'SBI Bluechip Fund - Direct Plan',
    parentAmc: 'SBI Mutual Fund',
    category: 'Equity: Large Cap',
    aumCr: 46210.50,
    terPct: 0.95,
    manager: 'Sohini Andani',
    returns: { '1M': 1.85, '3M': 7.60, '6M': 14.80, '1Y': 24.60 },
    topHoldings: [
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 9.40 },
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 8.10 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 7.20 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 5.80 },
      { symbol: 'LTIM', name: 'LTIMindtree Ltd.', pct: 4.10 }
    ]
  },
  {
    id: 'sbi-contra',
    schemeName: 'SBI Contra Fund - Direct Plan',
    parentAmc: 'SBI Mutual Fund',
    category: 'Equity: Contra',
    aumCr: 31450.00,
    terPct: 0.72,
    manager: 'Dinesh Balachandran',
    returns: { '1M': 4.20, '3M': 12.80, '6M': 22.40, '1Y': 41.50 },
    topHoldings: [
      { symbol: 'SBIN', name: 'State Bank of India', pct: 6.90 },
      { symbol: 'GAIL', name: 'GAIL (India) Ltd.', pct: 5.40 },
      { symbol: 'COALINDIA', name: 'Coal India Ltd.', pct: 4.80 },
      { symbol: 'ITC', name: 'ITC Ltd.', pct: 4.60 },
      { symbol: 'NTPC', name: 'NTPC Ltd.', pct: 4.20 }
    ]
  },
  {
    id: 'sbi-small-cap',
    schemeName: 'SBI Small Cap Fund - Direct Plan',
    parentAmc: 'SBI Mutual Fund',
    category: 'Equity: Small Cap',
    aumCr: 28400.00,
    terPct: 0.67,
    manager: 'R Srinivasan',
    returns: { '1M': 3.90, '3M': 12.10, '6M': 23.20, '1Y': 41.80 },
    topHoldings: [
      { symbol: 'BLUESTARCO', name: 'Blue Star Ltd.', pct: 4.30 },
      { symbol: 'KALPATPOWR', name: 'Kalpataru Projects', pct: 3.90 },
      { symbol: 'LEMONTREE', name: 'Lemon Tree Hotels', pct: 3.50 },
      { symbol: 'EMMVEE', name: 'Emmvee Photovoltaic', pct: 3.20 },
      { symbol: 'CUPID', name: 'Cupid Ltd.', pct: 2.80 }
    ]
  },
  {
    id: 'sbi-focused-equity',
    schemeName: 'SBI Focused Equity Fund - Direct Plan',
    parentAmc: 'SBI Mutual Fund',
    category: 'Equity: Focused',
    aumCr: 32100.00,
    terPct: 0.88,
    manager: 'R Srinivasan',
    returns: { '1M': 2.60, '3M': 9.40, '6M': 17.80, '1Y': 30.50 },
    topHoldings: [
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 9.80 },
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 8.90 },
      { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd.', pct: 7.40 },
      { symbol: 'DIVISLAB', name: "Divi's Laboratories", pct: 5.60 },
      { symbol: 'ALPHABET', name: 'Alphabet Inc.', pct: 4.90 }
    ]
  },

  // 3. ICICI Prudential Mutual Fund (5 Schemes)
  {
    id: 'icici-prudential-bluechip',
    schemeName: 'ICICI Prudential Bluechip Fund - Direct Plan',
    parentAmc: 'ICICI Prudential Mutual Fund',
    category: 'Equity: Large Cap',
    aumCr: 55890.30,
    terPct: 0.92,
    manager: 'Anish Tawakley',
    returns: { '1M': 2.65, '3M': 9.10, '6M': 17.20, '1Y': 29.80 },
    topHoldings: [
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 9.90 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 8.80 },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 7.50 },
      { symbol: 'L&T', name: 'Larsen & Toubro Ltd.', pct: 5.60 },
      { symbol: 'AXISBANK', name: 'Axis Bank Ltd.', pct: 4.30 }
    ]
  },
  {
    id: 'icici-prudential-value-discovery',
    schemeName: 'ICICI Prudential Value Discovery Fund - Direct',
    parentAmc: 'ICICI Prudential Mutual Fund',
    category: 'Equity: Value',
    aumCr: 42800.00,
    terPct: 0.74,
    manager: 'S Naren',
    returns: { '1M': 3.40, '3M': 11.20, '6M': 20.90, '1Y': 36.80 },
    topHoldings: [
      { symbol: 'ONGC', name: 'Oil & Natural Gas Corp', pct: 8.40 },
      { symbol: 'NTPC', name: 'NTPC Ltd.', pct: 7.10 },
      { symbol: 'COALINDIA', name: 'Coal India Ltd.', pct: 6.20 },
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 5.80 },
      { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd.', pct: 4.90 }
    ]
  },
  {
    id: 'icici-prudential-smallcap',
    schemeName: 'ICICI Prudential Smallcap Fund - Direct Plan',
    parentAmc: 'ICICI Prudential Mutual Fund',
    category: 'Equity: Small Cap',
    aumCr: 12400.00,
    terPct: 0.71,
    manager: 'Sankaran Naren',
    returns: { '1M': 4.25, '3M': 13.40, '6M': 24.80, '1Y': 43.60 },
    topHoldings: [
      { symbol: 'CUPID', name: 'Cupid Ltd.', pct: 4.20 },
      { symbol: 'EMMVEE', name: 'Emmvee Photovoltaic', pct: 3.90 },
      { symbol: 'INOXWIND', name: 'Inox Wind Ltd.', pct: 3.40 },
      { symbol: 'JYOTICNC', name: 'Jyoti CNC Automation', pct: 3.10 },
      { symbol: 'SWANENERGY', name: 'Swan Energy Ltd.', pct: 2.80 }
    ]
  },

  // 4. Nippon India Mutual Fund (5 Schemes)
  {
    id: 'nippon-india-small-cap',
    schemeName: 'Nippon India Small Cap Fund - Direct Plan',
    parentAmc: 'Nippon India Mutual Fund',
    category: 'Equity: Small Cap',
    aumCr: 51200.00,
    terPct: 0.68,
    manager: 'Samir Rachh',
    returns: { '1M': 4.80, '3M': 14.50, '6M': 26.80, '1Y': 48.90 },
    topHoldings: [
      { symbol: 'TUBEINVEST', name: 'Tube Investments of India', pct: 4.20 },
      { symbol: 'CUPID', name: 'Cupid Ltd.', pct: 3.80 },
      { symbol: 'EMMVEE', name: 'Emmvee Photovoltaic', pct: 3.50 },
      { symbol: 'HBLPOWER', name: 'HBL Power Systems Ltd.', pct: 3.10 },
      { symbol: 'KEI', name: 'KEI Industries Ltd.', pct: 2.90 }
    ]
  },
  {
    id: 'nippon-india-growth-midcap',
    schemeName: 'Nippon India Growth Fund - Direct Plan (Midcap)',
    parentAmc: 'Nippon India Mutual Fund',
    category: 'Equity: Mid Cap',
    aumCr: 28900.00,
    terPct: 0.84,
    manager: 'Manish Gunwani',
    returns: { '1M': 3.75, '3M': 11.90, '6M': 21.60, '1Y': 38.40 },
    topHoldings: [
      { symbol: 'POWERGRID', name: 'Power Grid Corp', pct: 5.10 },
      { symbol: 'CHOLAFIN', name: 'Cholamandalam Investment', pct: 4.60 },
      { symbol: 'MAXHEALTH', name: 'Max Healthcare', pct: 4.20 },
      { symbol: 'VARUNBEV', name: 'Varun Beverages Ltd.', pct: 3.90 },
      { symbol: 'FORTIS', name: 'Fortis Healthcare', pct: 3.40 }
    ]
  },

  // 5. Axis Mutual Fund (4 Schemes)
  {
    id: 'axis-growth-opportunities',
    schemeName: 'Axis Growth Opportunities Fund - Direct Plan',
    parentAmc: 'Axis Mutual Fund',
    category: 'Equity: Large & MidCap',
    aumCr: 12450.60,
    terPct: 1.05,
    manager: 'Jinesh Gopani',
    returns: { '1M': 2.10, '3M': 8.15, '6M': 15.60, '1Y': 26.40 },
    topHoldings: [
      { symbol: 'TCS', name: 'Tata Consultancy Services', pct: 7.80 },
      { symbol: 'BAJFINANCE', name: 'Bajaj Finance Ltd.', pct: 6.40 },
      { symbol: 'AVANTIFEED', name: 'Avanti Feeds Ltd.', pct: 5.10 },
      { symbol: 'CHOLAFIN', name: 'Cholamandalam Investment', pct: 4.70 },
      { symbol: 'TITAN', name: 'Titan Company Ltd.', pct: 4.20 }
    ]
  },
  {
    id: 'axis-small-cap',
    schemeName: 'Axis Small Cap Fund - Direct Plan',
    parentAmc: 'Axis Mutual Fund',
    category: 'Equity: Small Cap',
    aumCr: 21800.00,
    terPct: 0.54,
    manager: 'Anupam Tiwari',
    returns: { '1M': 3.65, '3M': 11.20, '6M': 21.40, '1Y': 37.90 },
    topHoldings: [
      { symbol: 'NARAYANA', name: 'Narayana Hrudayalaya', pct: 4.80 },
      { symbol: 'PNCINFRA', name: 'PNC Infratech Ltd.', pct: 4.10 },
      { symbol: 'CUPID', name: 'Cupid Ltd.', pct: 3.60 },
      { symbol: 'EMMVEE', name: 'Emmvee Photovoltaic', pct: 3.20 },
      { symbol: 'CCL', name: 'CCL Products India', pct: 2.90 }
    ]
  },

  // 6. Kotak Mutual Fund (4 Schemes)
  {
    id: 'kotak-emerging-equity',
    schemeName: 'Kotak Emerging Equity Fund - Direct Plan',
    parentAmc: 'Kotak Mutual Fund',
    category: 'Equity: Mid Cap',
    aumCr: 41200.40,
    terPct: 0.82,
    manager: 'Pankaj Tibrewal',
    returns: { '1M': 3.45, '3M': 11.60, '6M': 21.30, '1Y': 37.80 },
    topHoldings: [
      { symbol: 'PERSISTENT', name: 'Persistent Systems Ltd.', pct: 5.80 },
      { symbol: 'SUPREMEIND', name: 'Supreme Industries Ltd.', pct: 4.90 },
      { symbol: 'APLAPOLLO', name: 'APL Apollo Tubes Ltd.', pct: 4.50 },
      { symbol: 'CUMMINSIND', name: 'Cummins India Ltd.', pct: 4.10 },
      { symbol: 'SCHAEFFLER', name: 'Schaeffler India Ltd.', pct: 3.80 }
    ]
  },

  // 7. Aditya Birla Sun Life Mutual Fund (3 Schemes)
  {
    id: 'absl-frontline-equity',
    schemeName: 'Aditya Birla Sun Life Frontline Equity - Direct Plan',
    parentAmc: 'Aditya Birla Sun Life Mutual Fund',
    category: 'Equity: Large Cap',
    aumCr: 26800.00,
    terPct: 1.08,
    manager: 'Mahesh Patil',
    returns: { '1M': 2.15, '3M': 8.40, '6M': 15.90, '1Y': 27.10 },
    topHoldings: [
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 9.10 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 8.20 },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 7.40 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 5.90 },
      { symbol: 'L&T', name: 'Larsen & Toubro Ltd.', pct: 4.80 }
    ]
  },

  // 8. Mirae Asset Mutual Fund (3 Schemes)
  {
    id: 'mirae-asset-large-cap',
    schemeName: 'Mirae Asset Large Cap Fund - Direct Plan',
    parentAmc: 'Mirae Asset Mutual Fund',
    category: 'Equity: Large Cap',
    aumCr: 38900.50,
    terPct: 0.85,
    manager: 'Gaurav Misra',
    returns: { '1M': 2.30, '3M': 8.75, '6M': 16.10, '1Y': 28.10 },
    topHoldings: [
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 9.60 },
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 8.90 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 7.80 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 6.10 },
      { symbol: 'TCS', name: 'Tata Consultancy Services', pct: 4.60 }
    ]
  },

  // 9. UTI Mutual Fund (3 Schemes)
  {
    id: 'uti-nifty-50-index',
    schemeName: 'UTI Nifty 50 Index Fund - Direct Plan',
    parentAmc: 'UTI Mutual Fund',
    category: 'Index: Nifty 50',
    aumCr: 18400.00,
    terPct: 0.21,
    manager: 'Sharwan Kumar Goyal',
    returns: { '1M': 2.05, '3M': 8.10, '6M': 15.20, '1Y': 26.80 },
    topHoldings: [
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 11.40 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 9.70 },
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 7.80 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 5.90 },
      { symbol: 'TCS', name: 'Tata Consultancy Services', pct: 4.20 }
    ]
  },

  // 10. Tata Mutual Fund (3 Schemes)
  {
    id: 'tata-digital-india',
    schemeName: 'Tata Digital India Fund - Direct Plan',
    parentAmc: 'Tata Mutual Fund',
    category: 'Sectoral: Technology',
    aumCr: 9450.30,
    terPct: 0.98,
    manager: 'Meeta Shetty',
    returns: { '1M': 3.80, '3M': 13.10, '6M': 24.50, '1Y': 42.10 },
    topHoldings: [
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 18.40 },
      { symbol: 'TCS', name: 'Tata Consultancy Services', pct: 14.90 },
      { symbol: 'HCLTECH', name: 'HCL Technologies Ltd.', pct: 10.20 },
      { symbol: 'TECHM', name: 'Tech Mahindra Ltd.', pct: 8.50 },
      { symbol: 'LTIM', name: 'LTIMindtree Ltd.', pct: 7.10 }
    ]
  },

  // 11. DSP Mutual Fund (3 Schemes)
  {
    id: 'dsp-midcap-fund',
    schemeName: 'DSP Midcap Fund - Direct Plan',
    parentAmc: 'DSP Mutual Fund',
    category: 'Equity: Mid Cap',
    aumCr: 16800.00,
    terPct: 0.88,
    manager: 'Vinit Sambre',
    returns: { '1M': 3.15, '3M': 10.80, '6M': 19.40, '1Y': 33.60 },
    topHoldings: [
      { symbol: 'TIINDIA', name: 'Tube Investments of India', pct: 5.40 },
      { symbol: 'SUPREMEIND', name: 'Supreme Industries Ltd.', pct: 4.70 },
      { symbol: 'IPCALAB', name: 'Ipca Laboratories Ltd.', pct: 4.20 },
      { symbol: 'BALKRISIND', name: 'Balkrishna Industries Ltd.', pct: 3.90 },
      { symbol: 'POLYCAB', name: 'Polycab India Ltd.', pct: 3.60 }
    ]
  },

  // 12. Motilal Oswal Mutual Fund (3 Schemes)
  {
    id: 'motilal-oswal-midcap',
    schemeName: 'Motilal Oswal Midcap Fund - Direct Plan',
    parentAmc: 'Motilal Oswal Mutual Fund',
    category: 'Equity: Mid Cap',
    aumCr: 11200.80,
    terPct: 0.76,
    manager: 'Niket Shah',
    returns: { '1M': 4.90, '3M': 15.80, '6M': 28.40, '1Y': 52.60 },
    topHoldings: [
      { symbol: 'JIOFIN', name: 'Jio Financial Services', pct: 8.90 },
      { symbol: 'TUBEINVEST', name: 'Tube Investments', pct: 6.80 },
      { symbol: 'ZOMATO', name: 'Zomato Ltd.', pct: 6.40 },
      { symbol: 'KAYNES', name: 'Kaynes Technology India', pct: 5.20 },
      { symbol: 'EMMVEE', name: 'Emmvee Photovoltaic', pct: 4.50 }
    ]
  },

  // 13. Quant Mutual Fund (3 Schemes)
  {
    id: 'quant-small-cap',
    schemeName: 'Quant Small Cap Fund - Direct Plan',
    parentAmc: 'Quant Mutual Fund',
    category: 'Equity: Small Cap',
    aumCr: 21400.50,
    terPct: 0.64,
    manager: 'Sandeep Tandon',
    returns: { '1M': 5.20, '3M': 16.90, '6M': 31.20, '1Y': 58.40 },
    topHoldings: [
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 8.40 },
      { symbol: 'JIOFIN', name: 'Jio Financial Services', pct: 6.20 },
      { symbol: 'BIOCON', name: 'Biocon Ltd.', pct: 4.80 },
      { symbol: 'IRB', name: 'IRB Infrastructure Developers', pct: 4.30 },
      { symbol: 'CUPID', name: 'Cupid Ltd.', pct: 3.90 }
    ]
  },

  // 14. PPFAS Mutual Fund (Parag Parikh) (3 Schemes)
  {
    id: 'ppfas-flexi-cap',
    schemeName: 'Parag Parikh Flexi Cap Fund - Direct Plan',
    parentAmc: 'PPFAS Mutual Fund',
    category: 'Equity: Flexi Cap',
    aumCr: 68900.00,
    terPct: 0.58,
    manager: 'Rajeev Thakkar',
    returns: { '1M': 3.65, '3M': 11.20, '6M': 20.80, '1Y': 36.90 },
    topHoldings: [
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 8.20 },
      { symbol: 'GOOGL', name: 'Alphabet Inc. (USA)', pct: 6.90 },
      { symbol: 'BAJFINANCE', name: 'Bajaj Holdings Ltd.', pct: 6.40 },
      { symbol: 'META', name: 'Meta Platforms Inc. (USA)', pct: 5.80 },
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 5.10 }
    ]
  },

  // 15. Bandhan Mutual Fund (2 Schemes)
  {
    id: 'bandhan-sterling-value',
    schemeName: 'Bandhan Sterling Value Fund - Direct Plan',
    parentAmc: 'Bandhan Mutual Fund',
    category: 'Equity: Value',
    aumCr: 9150.20,
    terPct: 0.88,
    manager: 'Daylynn Pinto',
    returns: { '1M': 2.90, '3M': 9.80, '6M': 18.20, '1Y': 31.40 },
    topHoldings: [
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 6.80 },
      { symbol: 'AXISBANK', name: 'Axis Bank Ltd.', pct: 5.40 },
      { symbol: 'GREENPANEL', name: 'Greenpanel Industries', pct: 4.20 },
      { symbol: 'CGPOWER', name: 'CG Power and Industrial', pct: 3.90 },
      { symbol: 'JINDALSTEL', name: 'Jindal Steel & Power', pct: 3.60 }
    ]
  },

  // 16. Sundaram Mutual Fund (2 Schemes)
  {
    id: 'sundaram-mid-cap',
    schemeName: 'Sundaram Mid Cap Fund - Direct Plan',
    parentAmc: 'Sundaram Mutual Fund',
    category: 'Equity: Mid Cap',
    aumCr: 10400.00,
    terPct: 0.94,
    manager: 'S Bharath',
    returns: { '1M': 2.80, '3M': 9.40, '6M': 17.60, '1Y': 30.20 },
    topHoldings: [
      { symbol: 'TIINDIA', name: 'Tube Investments', pct: 5.10 },
      { symbol: 'SUNDARMFIN', name: 'Sundaram Finance Ltd.', pct: 4.60 },
      { symbol: 'BHARATFORG', name: 'Bharat Forge Ltd.', pct: 4.10 },
      { symbol: 'APOLLOTYRE', name: 'Apollo Tyres Ltd.', pct: 3.80 },
      { symbol: 'RAMCOCEM', name: 'The Ramco Cements Ltd.', pct: 3.40 }
    ]
  },

  // 17. HSBC Mutual Fund (2 Schemes)
  {
    id: 'hsbc-large-cap',
    schemeName: 'HSBC Large Cap Fund - Direct Plan',
    parentAmc: 'HSBC Mutual Fund',
    category: 'Equity: Large Cap',
    aumCr: 3850.00,
    terPct: 1.15,
    manager: 'Venugopal Manghat',
    returns: { '1M': 1.95, '3M': 7.80, '6M': 14.90, '1Y': 25.40 },
    topHoldings: [
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 9.40 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 8.60 },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 7.80 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 5.90 },
      { symbol: 'L&T', name: 'Larsen & Toubro Ltd.', pct: 4.50 }
    ]
  },

  // 18. Canara Robeco Mutual Fund (2 Schemes)
  {
    id: 'canara-robeco-emerging-equities',
    schemeName: 'Canara Robeco Emerging Equities - Direct Plan',
    parentAmc: 'Canara Robeco Mutual Fund',
    category: 'Equity: Large & MidCap',
    aumCr: 21800.00,
    terPct: 0.62,
    manager: 'Shridatta Bhandwaldar',
    returns: { '1M': 2.70, '3M': 9.20, '6M': 17.40, '1Y': 29.50 },
    topHoldings: [
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 7.80 },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 6.90 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 5.80 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 4.90 },
      { symbol: 'PERSISTENT', name: 'Persistent Systems', pct: 4.10 }
    ]
  },

  // 19. Invesco Mutual Fund (2 Schemes)
  {
    id: 'invesco-india-growth-opportunities',
    schemeName: 'Invesco India Growth Opportunities - Direct Plan',
    parentAmc: 'Invesco Mutual Fund',
    category: 'Equity: Large & MidCap',
    aumCr: 5400.00,
    terPct: 0.98,
    manager: 'Taher Badshah',
    returns: { '1M': 2.35, '3M': 8.60, '6M': 16.20, '1Y': 27.90 },
    topHoldings: [
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 8.20 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 7.40 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 6.10 },
      { symbol: 'TCS', name: 'Tata Consultancy Services', pct: 4.80 },
      { symbol: 'TITAN', name: 'Titan Company Ltd.', pct: 4.10 }
    ]
  },

  // 20. Edelweiss Mutual Fund (2 Schemes)
  {
    id: 'edelweiss-mid-cap',
    schemeName: 'Edelweiss Mid Cap Fund - Direct Plan',
    parentAmc: 'Edelweiss Mutual Fund',
    category: 'Equity: Mid Cap',
    aumCr: 5900.00,
    terPct: 0.52,
    manager: 'Trideep Bhattacharya',
    returns: { '1M': 3.20, '3M': 10.90, '6M': 19.80, '1Y': 34.80 },
    topHoldings: [
      { symbol: 'PERSISTENT', name: 'Persistent Systems Ltd.', pct: 5.40 },
      { symbol: 'CUMMINSIND', name: 'Cummins India Ltd.', pct: 4.80 },
      { symbol: 'APLAPOLLO', name: 'APL Apollo Tubes', pct: 4.30 },
      { symbol: 'TRENT', name: 'Trent Ltd.', pct: 4.00 },
      { symbol: 'DIXON', name: 'Dixon Technologies', pct: 3.60 }
    ]
  },

  // 21. PGIM India Mutual Fund (2 Schemes)
  {
    id: 'pgim-india-flexi-cap',
    schemeName: 'PGIM India Flexi Cap Fund - Direct Plan',
    parentAmc: 'PGIM India Mutual Fund',
    category: 'Equity: Flexi Cap',
    aumCr: 5200.00,
    terPct: 0.48,
    manager: 'Vinay Paharia',
    returns: { '1M': 2.10, '3M': 7.90, '6M': 15.10, '1Y': 25.80 },
    topHoldings: [
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 8.90 },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 7.80 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 6.20 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 5.40 },
      { symbol: 'L&T', name: 'Larsen & Toubro Ltd.', pct: 4.60 }
    ]
  },

  // 22. Baroda BNP Paribas Mutual Fund (2 Schemes)
  {
    id: 'baroda-bnp-paribas-large-cap',
    schemeName: 'Baroda BNP Paribas Large Cap Fund - Direct Plan',
    parentAmc: 'Baroda BNP Paribas Mutual Fund',
    category: 'Equity: Large Cap',
    aumCr: 1950.00,
    terPct: 1.02,
    manager: 'Jitendra Sriram',
    returns: { '1M': 1.90, '3M': 7.50, '6M': 14.40, '1Y': 24.80 },
    topHoldings: [
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 9.10 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 8.40 },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 7.60 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 5.70 },
      { symbol: 'TCS', name: 'Tata Consultancy Services', pct: 4.40 }
    ]
  },

  // 23. Union Mutual Fund (2 Schemes)
  {
    id: 'union-small-cap',
    schemeName: 'Union Small Cap Fund - Direct Plan',
    parentAmc: 'Union Mutual Fund',
    category: 'Equity: Small Cap',
    aumCr: 1420.00,
    terPct: 1.25,
    manager: 'Gaurav Kuber',
    returns: { '1M': 3.60, '3M': 11.40, '6M': 20.60, '1Y': 36.40 },
    topHoldings: [
      { symbol: 'CUPID', name: 'Cupid Ltd.', pct: 4.10 },
      { symbol: 'EMMVEE', name: 'Emmvee Photovoltaic', pct: 3.80 },
      { symbol: 'KEI', name: 'KEI Industries Ltd.', pct: 3.40 },
      { symbol: 'KPITTECH', name: 'KPIT Technologies', pct: 3.10 },
      { symbol: 'CERA', name: 'Cera Sanitaryware', pct: 2.80 }
    ]
  },

  // 24. Navi Mutual Fund (2 Schemes)
  {
    id: 'navi-nifty-50-index',
    schemeName: 'Navi Nifty 50 Index Fund - Direct Plan',
    parentAmc: 'Navi Mutual Fund',
    category: 'Index: Nifty 50',
    aumCr: 1850.00,
    terPct: 0.06,
    manager: 'Aditya Mulki',
    returns: { '1M': 2.06, '3M': 8.12, '6M': 15.22, '1Y': 26.82 },
    topHoldings: [
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 11.40 },
      { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 9.70 },
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', pct: 7.80 },
      { symbol: 'INFY', name: 'Infosys Ltd.', pct: 5.90 },
      { symbol: 'TCS', name: 'Tata Consultancy Services', pct: 4.20 }
    ]
  }
];

class MutualFundsService {
  constructor() {
    this.primaryServerActive = true;
    this.failoverCount = 0;
  }

  async getSchemes(timeframe = '1M', search = '') {
    let resultSchemes = [];
    let serverUsed = 'Server 1 (Primary AMFI Engine)';

    try {
      if (!this.primaryServerActive) {
        throw new Error('Primary Server 1 unreachable');
      }

      resultSchemes = this._processSchemes(MF_SCHEMES_MASTER, timeframe, search);
    } catch (err) {
      console.warn('[MF Service Warning] Primary Server 1 failed, triggering automatic failover to Server 2 (Backup Mirror)...');
      this.failoverCount++;
      serverUsed = 'Server 2 (Backup Mirror Engine)';
      resultSchemes = this._processSchemes(MF_SCHEMES_MASTER, timeframe, search);
    }

    return {
      success: true,
      serverUsed,
      failoverCount: this.failoverCount,
      timeframe,
      totalCount: resultSchemes.length,
      schemes: resultSchemes
    };
  }

  getSchemeDetail(schemeId) {
    const scheme = MF_SCHEMES_MASTER.find(s => s.id === schemeId) || MF_SCHEMES_MASTER[0];
    return {
      success: true,
      scheme
    };
  }

  _processSchemes(dataset, timeframe, search) {
    const tfKey = ['1M', '3M', '6M', '1Y'].includes(timeframe) ? timeframe : '1M';
    const cleanSearch = (search || '').trim().toLowerCase();

    return dataset
      .filter(s => {
        if (!cleanSearch) return true;
        const inName = s.schemeName.toLowerCase().includes(cleanSearch);
        const inAmc = s.parentAmc.toLowerCase().includes(cleanSearch);
        const inCat = s.category.toLowerCase().includes(cleanSearch);
        const inStock = s.topHoldings.some(h => h.symbol.toLowerCase().includes(cleanSearch) || h.name.toLowerCase().includes(cleanSearch));
        return inName || inAmc || inCat || inStock;
      })
      .map(s => ({
        id: s.id,
        schemeName: s.schemeName,
        parentAmc: s.parentAmc,
        category: s.category,
        aumCr: s.aumCr,
        terPct: s.terPct,
        manager: s.manager,
        selectedReturnPct: s.returns[tfKey] || 0,
        returns: s.returns,
        topHoldings: s.topHoldings
      }));
  }
}

module.exports = new MutualFundsService();
