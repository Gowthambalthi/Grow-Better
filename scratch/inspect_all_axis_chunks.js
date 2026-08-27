const axios = require('axios');

async function findAxisApisAllChunks() {
  console.log('================================================================');
  console.log('AXIS AMC 70 CHUNKS API DEEP SEARCH');
  console.log('================================================================\n');

  try {
    const pageRes = await axios.get('https://www.axismf.com/servicecenter/navterandothers/totalexpenseratio', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const chunkMatches = pageRes.data.match(/src=\x22(\/_next\/static\/chunks\/[^\x22]+)\x22/gi) || [];
    const chunkUrls = Array.from(new Set(chunkMatches.map(m => 'https://www.axismf.com' + m.replace(/^src=\x22|\x22$/g, ''))));
    console.log(`Searching all ${chunkUrls.length} JS chunks...`);

    const apisFound = new Set();

    for (const chunkUrl of chunkUrls) {
      try {
        const cRes = await axios.get(chunkUrl, { timeout: 4000 });
        const text = cRes.data;
        
        const apis = text.match(/[\x22'](\/(?:api|cms|service|downloads|Handlers|pdf|excel)[^\x22']+)[\x22']/gi) || [];
        apis.forEach(a => apisFound.add(a.replace(/^[\x22']|[\x22']$/g, '')));
      } catch (e) {}
    }

    console.log(`Found ${apisFound.size} total API/service endpoints across JS chunks:`);
    Array.from(apisFound).slice(0, 30).forEach(a => console.log('  ->', a));

  } catch (err) {
    console.error('Page Fetch Error:', err.message);
  }

  console.log('\n================================================================');
}

findAxisApisAllChunks();
