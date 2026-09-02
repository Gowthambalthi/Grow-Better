/**
 * GET /api/debug/groww-keys/:slug
 * Dumps all mfServerSideData keys from a Groww page to find folio/investor data
 */
const axios = require('axios');

function registerDebugRoute(app) {
  app.get('/api/debug/groww-keys/:slug', async (req, res) => {
    try {
      const slug = req.params.slug;
      const url = 'https://groww.in/mutual-funds/' + slug;
      const response = await axios.get(url, {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
      var pattern = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
      var match = response.data.match(pattern);
      if (!match) return res.json({ error: 'No __NEXT_DATA__' });
      var nd = JSON.parse(match[1]);
      var ss = nd.props && nd.props.pageProps && nd.props.pageProps.mfServerSideData;
      if (!ss) return res.json({ error: 'No mfServerSideData' });
      
      // Return all primitive keys
      var result = {};
      var keys = Object.keys(ss);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = ss[k];
        if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          result[k] = v;
        } else if (Array.isArray(v)) {
          result[k] = 'Array(' + v.length + ')';
        } else {
          result[k] = 'Object(' + Object.keys(v).join(',') + ')';
        }
      }
      // Deep-search for folio/investor fields
      var found = {};
      function search(obj, path) {
        if (!obj || typeof obj !== 'object') return;
        var okeys = Object.keys(obj);
        for (var j = 0; j < okeys.length; j++) {
          var fk = okeys[j];
          var fv = obj[fk];
          var fp = path ? path + '.' + fk : fk;
          if (/folio|investor|holder|subscriber|account/i.test(fk)) {
            found[fp] = typeof fv === 'object' ? JSON.stringify(fv).substring(0, 200) : fv;
          }
          if (typeof fv === 'object' && fv !== null && !Array.isArray(fv)) {
            search(fv, fp);
          }
        }
      }
      search(ss, '');
      result._folioInvestorFields = found;
      res.json({ success: true, data: result });
    } catch (err) {
      res.json({ error: err.message });
    }
  });
}

module.exports = { registerDebugRoute };
