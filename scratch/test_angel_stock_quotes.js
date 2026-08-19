const angelAuth = require('../angelone/auth');
const axios = require('axios');
const env = require('../config/env');

async function testAngelStockQuotes() {
  console.log('Logging in to Angel One...');
  const authRes = await angelAuth.login();
  const session = authRes.session;
  const angelUrl = 'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/';
  const apiKey = env.angel.apiKey();
  const aHeaders = {
    'Authorization': 'Bearer ' + session.jwtToken,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': 'fe80::1',
    'X-PrivateKey': apiKey
  };

  try {
    const res = await axios.post(angelUrl, {
      mode: 'FULL',
      exchangeTokens: {
        NSE: ['2885', '14418', '90490'] // RELIANCE, CUPID, EMMVEE
      }
    }, { headers: aHeaders });

    console.log('STOCK QUOTE RESPONSE:', JSON.stringify(res.data, null, 2));
  } catch(e) {
    console.log('ERR:', e.response?.data || e.message);
  }
}

testAngelStockQuotes();
