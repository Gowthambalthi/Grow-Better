const axios = require('axios');

async function searchAngelInstruments() {
  console.log('Downloading Angel One instrument master...');
  try {
    const res = await axios.get('https://margincalculator.angelbroking.com/OpenAPI_Standard_MasterJSON_TokenData.json', { timeout: 15000 });
    const instruments = res.data || [];
    console.log('Total instruments:', instruments.length);

    const giftMatches = instruments.filter(i => 
      (i.symbol && i.symbol.toUpperCase().includes('GIFT')) || 
      (i.name && i.name.toUpperCase().includes('GIFT')) ||
      (i.symbol && i.symbol.toUpperCase().includes('SGX'))
    );

    console.log('GIFT / SGX Matches in Angel One Master:', giftMatches.slice(0, 15));
  } catch(e) {
    console.log('Angel Master download err:', e.message);
  }
}

searchAngelInstruments();
