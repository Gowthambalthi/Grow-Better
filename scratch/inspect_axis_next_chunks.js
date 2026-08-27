const axios = require('axios');

async function findAxisTerApiFromChunks() {
  console.log('================================================================');
  console.log('AXIS AMC NEXT.JS BUNDLE DEEP DISCOVERY REPORT');
  console.log('================================================================\n');

  try {
    const pageRes = await axios.get('https://www.axismf.com/servicecenter/navterandothers/totalexpenseratio', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const chunkMatches = pageRes.data.match(/src=\x22(\/_next\/static\/chunks\/[^\x22]+)\x22/gi) || [];
    const chunkUrls = Array.from(new Set(chunkMatches.map(m => 'https://www.axismf.com' + m.replace(/^src=\x22|\x22$/g, ''))));
    console.log(`Analyzing ${chunkUrls.length} Next.js JS chunks...`);

    for (const chunkUrl of chunkUrls.slice(0, 15)) {
      try {
        const cRes = await axios.get(chunkUrl, { timeout: 5000 });
        const text = cRes.data;
        
        // Search for API endpoints, fetch calls, or TER urls in JS chunk
        if (text.includes('ter') || text.includes('TotalExpenseRatio') || text.includes('expense')) {
          const apiMatches = text.match(/https?:\/\/[^\s\x22']*(?:ter|expense|statutory)[^\s\x22']*/gi) || [];
          const relMatches = text.match(/[\x22'](\/(?:api|cms|service|downloads)[^\x22']+)[\x22']/gi) || [];
          
          if (apiMatches.length > 0 || relMatches.length > 0) {
            console.log(`Chunk ${chunkUrl.split('/').pop()}:`);
            if (apiMatches.length > 0) console.log('  -> Absolute APIs:', Array.from(new Set(apiMatches)).slice(0, 5));
            if (relMatches.length > 0) console.log('  -> Relative APIs:', Array.from(new Set(relMatches)).slice(0, 5));
          }
        }
      } catch (e) {
        // Skip chunk error
      }
    }

  } catch (err) {
    console.error('Page Fetch Error:', err.message);
  }

  console.log('\n================================================================');
}

findAxisTerApiFromChunks();
