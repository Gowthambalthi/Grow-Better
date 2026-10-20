// Mutual Funds Platform Controller & Resilient Server Failover Engine
    (function() {
      var currentMfTimeframe = '1M';
      var currentMfSearch = '';
      var mfCache = [];

            // AMC data loaded dynamically from API
      var AMCS_24 = [];
      var amcDataLoaded = false;

      function renderAmcCards() {
        var container = document.getElementById('amcCardsContainer');
        if (!container) return;
        
        // If we have cached AMC data from the API, use it
        if (AMCS_24.length > 0 && amcDataLoaded) {
          container.innerHTML = AMCS_24.map(function(amc) {
            var activeStyle = currentMfSearch.toLowerCase() === amc.name.toLowerCase() ? 'border-color:var(--accent);background:var(--bg-raised);' : '';
            return '<div class="amc-pill-card" data-amc="' + amc.name + '" style="min-width:170px;padding:10px 14px;background:var(--bg-panel);border:1px solid var(--line);border-radius:10px;cursor:pointer;flex-shrink:0;transition:transform 0.15s, border-color 0.15s;' + activeStyle + '">' +
                     '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">' +
                       '<span style="font-size:12.5px;font-weight:800;color:var(--text-primary);">' + amc.name + '</span>' +
                     '</div>' +
                     '<div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;">' +
                       '<span style="color:var(--text-muted);font-weight:600;">' + amc.schemeCount + ' schemes</span>' +
                       '<span style="color:#00B386;font-weight:800;">' + amc.schemesWithReturn + ' with returns</span>' +
                     '</div>' +
                   '</div>';
          }).join('');
          // Re-attach click handlers
          container.querySelectorAll('.amc-pill-card').forEach(function(card) {
            card.addEventListener('click', function() {
              var amc = card.dataset.amc;
              currentMfSearch = amc;
              fetchMfSchemes(currentMfTimeframe, amc);
            });
          });
          return;
        }
        
        // Otherwise show loading
        container.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;">Loading AMCs...</div>';
      }
      
      // Build AMC cards from real API data after schemes load
      function buildAmcCardsFromSchemes(schemes) {
        var amcMap = {};
        schemes.forEach(function(s) {
          var amc = s.parentAmc || s.amc || 'Unknown';
          if (!amcMap[amc]) amcMap[amc] = { name: amc, schemeCount: 0, schemesWithReturn: 0, totalReturn1m: 0, returnCount: 0 };
          amcMap[amc].schemeCount++;
          if (s.returns && s.returns['1M'] != null) {
            amcMap[amc].schemesWithReturn++;
            amcMap[amc].totalReturn1m += s.returns['1M'];
            amcMap[amc].returnCount++;
          }
        });
        AMCS_24 = Object.values(amcMap).map(function(a) {
          a.avgReturn1m = a.returnCount > 0 ? (a.totalReturn1m / a.returnCount).toFixed(2) : null;
          return a;
        }).sort(function(a, b) { return b.schemeCount - a.schemeCount; });
        amcDataLoaded = true;
        renderAmcCards();
      }

      async function fetchMfSchemes(timeframe, search) {
        try {
          var tf = timeframe || currentMfTimeframe;
          var q = search !== undefined ? search : currentMfSearch;
          var grid = document.getElementById('mfSchemesGrid');
          var serverTag = document.getElementById('mfServerTag');
          var subTitle = document.getElementById('mfSubtitleCount');
          console.log('[MF] fetchMfSchemes called, tf=' + tf + ' q=' + q);

          function fetchWithTimeout(url, ms) {
            var controller = new AbortController();
            var timer = setTimeout(function() { controller.abort(); }, ms);
            return fetch(url, { signal: controller.signal })
              .then(function(r) { clearTimeout(timer); return r.ok ? r.json() : null; })
              .catch(function() { clearTimeout(timer); return null; });
          }

          // SINGLE SOURCE: Multi-AMC API (initial fast page load = first 500; full 14k fetched lazily on Show-all/search)
          var allAmcData = await fetchWithTimeout('/api/mutual-funds/all?limit=500', 45000);
          console.log('[MF] multi-amc:', allAmcData ? allAmcData.totalSchemes : 'null');
          // Real full-universe card counts from the server (badges stay correct even at 14k schemes)
          window._mfCardCounts = (allAmcData && allAmcData.cardCounts) ? allAmcData.cardCounts : null;

          var allSchemes = [];
          var amcSet = new Set();
          // Ensure amcSet is always defined
          if (typeof amcSet === 'undefined' || amcSet === null) amcSet = new Set();

          // Process multi-AMC real data (PRIMARY)
          if (allAmcData && allAmcData.success && Array.isArray(allAmcData.schemes)) {
            // Shared mapper: API scheme -> frontend scheme (used for the initial load AND the lazy full-universe fetch)
            window._mapMfScheme = function(s) {
              amcSet.add(s.amc || 'Unknown');
              return {
                id: s.id,
                schemeCode: s.schemeCode,
                schemeName: s.schemeName,
                cleanTitle: cleanSchemeTitle(s.schemeName),
                parentAmc: s.amc || 'Unknown',
                category: s.category || 'Equity',
                subCategory: '',
                group: '',
                isDebt: false,
                currentNav: s.nav || null,
                aumCr: s.aum,
                terPct: s.expenseRatio || null,
                selectedReturnPct: (s.returns && s.returns[tf]) !== undefined ? s.returns[tf] : (s.return1Y || 0),
                returns: s.returns || { '1Y': s.return1Y },
                topHoldings: (s.topHoldings || []).map(function(h) {
                  return { symbol: h.securityName, name: h.securityName, pct: h.weight, sector: h.sector, isin: h.isin };
                }),
                variantCount: s.variantCount || 1,
                variants: [],
                investorCount: s.investorCount,
                aumChange1M: s.aumChange1M || null,
                aumChange3M: s.aumChange3M || null,
                aumChange6M: s.aumChange6M || null,
                aumChange1Y: s.aumChange1Y || null,
                investorChange1M: s.investorChange1M || null,
                investorChange3M: s.investorChange3M || null,
                investorChange6M: s.investorChange6M || null,
                investorChange1Y: s.investorChange1Y || null,
                confidenceScore: s.confidenceScore || 50,
                metrics: s.metrics || null,
                latestPortfolioDate: s.latestPortfolioDate,
                availablePortfolioMonths: s.availablePortfolioMonths,
                isOfficialHdfc: true,
                isOfficialData: true,
                searchBlob: (s.schemeName + ' ' + (s.amc || '') + ' ' + (s.category || '')).toLowerCase()
              };
            };
            allSchemes = allAmcData.schemes.map(window._mapMfScheme);
            if (serverTag) {
              serverTag.textContent = allAmcData.totalAmcs + ' AMCs · ' + allAmcData.totalSchemes + ' Official Data';
              serverTag.style.background = 'rgba(16,185,129,0.15)';
              serverTag.style.color = '#10B981';
            }
          }

          // AMFI fallback disabled — multi-AMC DB has all 47 AMCs with real data
      
    // Category tabs (Equity/Hybrid/Debt/Index) handle filtering in the UI

          amcSet = amcSet || new Set();
          console.log('[MF] allSchemes:', allSchemes.length, 'amcs:', amcSet ? amcSet.size : 0);

          mfCache = allSchemes;

          // Lazy-load the full universe (14k) only when the user hits "Show all" or searches
          window._mfFullSchemes = null;
          window.mfEnsureFull = function() {
            return new Promise(function(resolve) {
              if (window._mfFullSchemes) return resolve(window._mfFullSchemes);
              fetchWithTimeout('/api/mutual-funds/all?limit=20000', 60000).then(function(d) {
                if (d && d.success && Array.isArray(d.schemes)) {
                  if (d.cardCounts) window._mfCardCounts = d.cardCounts;
                  window._mfFullSchemes = d.schemes.map(window._mapMfScheme);
                }
                resolve(window._mfFullSchemes || null);
              });
            });
          };

          if (subTitle) {
            var total = allSchemes.length;
            var amcCount = (amcSet && amcSet.size != null) ? amcSet.size : 0;
            var totalAll = (allAmcData && allAmcData.totalSchemes) ? allAmcData.totalSchemes : total;
            subTitle.textContent = totalAll.toLocaleString('en-IN') + ' Mutual Fund Schemes across ' + amcCount + ' AMCs';
          }

          renderMfGrid(allSchemes);
          buildAmcCardsFromSchemes(allSchemes);
          console.log('[MF] renderMfGrid called with', allSchemes.length, 'schemes');
        } catch (err) {
          console.error('[MF] fetchMfSchemes CRITICAL ERROR:', err);
          // Always render SOMETHING so the page isn't stuck on Loading...
          try {
            var fallbackGrid = document.getElementById('mfSchemesGrid');
            if (fallbackGrid) {
              fallbackGrid.innerHTML = '<div class="card" style="padding:24px;text-align:center;color:var(--text-muted);grid-column:1/-1;">Error loading schemes: ' + (err.message || 'Unknown error') + '<br><br><button onclick="fetchMfSchemes()" style="background:var(--accent);color:#fff;border:none;padding:8px 20px;border-radius:8px;cursor:pointer;font-weight:700;">Retry</button></div>';
            }
          } catch (_) {}
        }
      }

      function cleanSchemeTitle(rawName) {
        var name = rawName || '';
        var t = name
          .replace(/-?\s*(direct|regular|retail|institutional)\s*plan\s*/gi, '')
          .replace(/-?\s*(direct|regular)\s*/gi, '')
          .replace(/-?\s*(growth|idcw|dividend)\s*(option|payout|re-investment|reinvestment)?\s*/gi, '')
          .replace(/-?\s*plan\s*[a-z0-9]+\s*/gi, '')
          .replace(/\b[Ff]und\b\s*/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (t === t.toUpperCase()) {
          t = t.toLowerCase().replace(/\b[a-z]/g, function(l) { return l.toUpperCase(); });
          t = t.replace(/\b(Hdfc|Sbi|Icici|Uti|Dsp|Lic|L&t|Ev|Elss|Etf)\b/g, function(m) { return m.toUpperCase(); });
        }
        return t || name;
      }

      function renderHdfcTable(schemes) {
        var tableContainer = document.getElementById('hdfcTableView');
        if (!tableContainer || !schemes || schemes.length === 0) return;

        // Sort by confidence score descending
        var sorted = schemes.slice().sort(function(a, b) { return (b.confidenceScore || 0) - (a.confidenceScore || 0); });

        // Group by AMC
        var byAmc = {};
        for (var i = 0; i < sorted.length; i++) {
          var amc = sorted[i].parentAmc || 'Other';
          if (!byAmc[amc]) byAmc[amc] = [];
          byAmc[amc].push(sorted[i]);
        }
        var amcNames = Object.keys(byAmc).sort(function(a,b) { return byAmc[b].length - byAmc[a].length; });

        var rows = sorted.map(function(s, idx) {
          var name = cleanSchemeTitle(s.schemeName);
          var amcTag = s.parentAmc || '';
          var ret1m = s.returns && s.returns['1M'] != null ? s.returns['1M'] : null;
          var ret3m = s.returns && s.returns['3M'] != null ? s.returns['3M'] : null;
          var ret6m = s.returns && s.returns['6M'] != null ? s.returns['6M'] : null;
          var ret1y = s.returns && s.returns['1Y'] != null ? s.returns['1Y'] : null;
          var aum = s.aumCr != null ? '\u20b9' + Number(s.aumCr).toLocaleString('en-IN', {maximumFractionDigits:0}) + ' Cr' : '-';
          var investors = s.investorCount != null ? (s.investorCount > 10000 ? (s.investorCount / 100000).toFixed(2) + 'L' : s.investorCount.toLocaleString('en-IN')) : '-';
          var cs = s.confidenceScore || 50;
          var csColor = cs >= 80 ? '#00B386' : cs >= 60 ? '#F59E0B' : '#EB5B56';
          var csBg = cs >= 80 ? 'rgba(0,179,134,0.12)' : cs >= 60 ? 'rgba(245,158,11,0.12)' : 'rgba(235,91,86,0.12)';

          function retCell(val) {
            if (val === null || val === undefined) return '<td style="padding:8px 10px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';
            var color = val >= 0 ? '#00B386' : '#EB5B56';
            var sign = val >= 0 ? '+' : '';
            return '<td style="padding:8px 10px;text-align:right;color:' + color + ';font-weight:700;font-size:12px;">' + sign + val.toFixed(2) + '%</td>';
          }

          return '<tr style="border-bottom:1px solid var(--line);cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background=\'var(--bg-input)\'" onmouseout="this.style.background=\'\'" onclick="openMfDetailFromTable(\'' + s.id + '\')">' +
            '<td style="padding:8px 6px;font-size:10px;color:var(--accent);font-weight:600;white-space:nowrap;">' + amcTag + '</td>' +
            '<td style="padding:8px 10px;font-weight:700;font-size:12px;color:var(--text-primary);white-space:nowrap;">' + name + '</td>' +
            retCell(ret1m) +
            retCell(ret3m) +
            retCell(ret6m) +
            retCell(ret1y) +
            '<td style="padding:8px 10px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:600;">' + aum + '</td>' +
            '<td style="padding:8px 10px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:600;">' + investors + '</td>' +
            '<td style="padding:8px 10px;text-align:center;"><span style="background:' + csBg + ';color:' + csColor + ';font-size:11px;font-weight:800;padding:3px 8px;border-radius:10px;">' + cs + '</span></td>' +
          '</tr>';
        }).join('');

        var amcSummary = amcNames.map(function(a) { return a + ' (' + byAmc[a].length + ')'; }).join(' \u00b7 ');
        tableContainer.innerHTML = '<div style="margin-bottom:20px;background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;">' + '<div style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);">' + '<h3 style="font-size:14px;font-weight:800;color:var(--text-primary);margin:0;">\ud83d\udcca ALL AMCs Equity Funds Overview</h3>' + '<span style="font-size:11px;color:var(--text-muted);">' + sorted.length + ' schemes \u00b7 ' + amcNames.length + ' AMCs</span>' + '</div>' + '<div style="padding:8px 16px;font-size:10px;color:var(--text-muted);border-bottom:1px solid var(--line);">' + amcSummary + '</div>' + '<div style="overflow-x:auto;">' + '<table style="width:100%;border-collapse:collapse;font-size:12px;">' + '<thead>' + '<tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">' + '<th style="padding:10px 6px;text-align:left;font-size:10px;color:var(--text-muted);font-weight:700;">AMC</th>' + '<th style="padding:10px 10px;text-align:left;font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;">Scheme Name</th>' + '<th style="padding:10px 10px;text-align:right;font-size:10px;color:var(--text-muted);font-weight:700;">1M</th>' + '<th style="padding:10px 10px;text-align:right;font-size:10px;color:var(--text-muted);font-weight:700;">3M</th>' + '<th style="padding:10px 10px;text-align:right;font-size:10px;color:var(--text-muted);font-weight:700;">6M</th>' + '<th style="padding:10px 10px;text-align:right;font-size:10px;color:var(--text-muted);font-weight:700;">1Y</th>' + '<th style="padding:10px 10px;text-align:right;font-size:10px;color:var(--text-muted);font-weight:700;">AUM</th>' + '<th style="padding:10px 10px;text-align:right;font-size:10px;color:var(--text-muted);font-weight:700;">Investors</th>' + '<th style="padding:10px 10px;text-align:center;font-size:10px;color:var(--text-muted);font-weight:700;">Confidence</th>' + '</tr>' + '</thead>' + '<tbody>' + rows + '</tbody>' + '</table>' + '</div>' + '</div>';
        tableContainer.style.display = 'block';
      }

      function openMfDetailFromTable(schemeId) {
        openMfDetailModal(schemeId);
      }
      window.openMfDetailFromTable = openMfDetailFromTable;

            // Current sort state for MF table
      var mfSortKey = '';
      var mfSortDir = 'desc'; // 'asc' or 'desc'
      var mfSortedSchemes = [];

      function getMfSortVal(scheme, key) {
        switch (key) {
          case 'amc': return (scheme.parentAmc || '').toLowerCase();
          case 'name': return (scheme.schemeName || '').toLowerCase();
          case 'category': return (scheme.category || '').toLowerCase();
          case '1M': return (scheme.returns && scheme.returns['1M'] != null) ? Number(scheme.returns['1M']) : -9999;
          case '3M': return (scheme.returns && scheme.returns['3M'] != null) ? Number(scheme.returns['3M']) : -9999;
          case '6M': return (scheme.returns && scheme.returns['6M'] != null) ? Number(scheme.returns['6M']) : -9999;
          case '1Y': return (scheme.returns && scheme.returns['1Y'] != null) ? Number(scheme.returns['1Y']) : -9999;
          case 'aum': return Number(scheme.aumCr) || 0;
          case 'inv': return Number(scheme.investorCount) || 0;
          case 'cs': return Number(scheme.confidenceScore) || 0;
          default: return 0;
        }
      }

      function sortMfSchemes(schemes, key) {
        if (mfSortKey === key) {
          mfSortDir = mfSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          mfSortKey = key;
          mfSortDir = (key === 'name' || key === 'amc' || key === 'category') ? 'asc' : 'desc';
        }
        var sorted = schemes.slice();
        sorted.sort(function(a, b) {
          var va = getMfSortVal(a, key);
          var vb = getMfSortVal(b, key);
          if (typeof va === 'string') {
            var cmp = va.localeCompare(vb);
            return mfSortDir === 'asc' ? cmp : -cmp;
          }
          return mfSortDir === 'asc' ? va - vb : vb - va;
        });
        return sorted;
      }

      function mfSortArrow(key) {
        var isActive = mfSortKey === key;
        var upColor = isActive && mfSortDir === 'asc' ? '#00B386' : 'var(--text-muted)';
        var downColor = isActive && mfSortDir === 'desc' ? '#00B386' : 'var(--text-muted)';
        return '<span style="display:inline-flex;flex-direction:column;margin-left:3px;cursor:pointer;line-height:1;" onclick="event.stopPropagation();window._mfSort(\'' + key + '\')">' +
          '<span style="font-size:8px;color:' + upColor + ';">&#9650;</span>' +
          '<span style="font-size:8px;color:' + downColor + ';margin-top:-2px;">&#9660;</span>' +
        '</span>';
      }

      window._mfSort = function(key) {
        if (!window._mfLastSchemes) return;
        var sorted = sortMfSchemes(window._mfLastSchemes, key);
        renderMfGridFromSorted(sorted);
      };

      function renderMfGridFromSorted(schemes) {
        var grid = document.getElementById("mfSchemesGrid");
        if (!grid) return;
        _renderMfGridBody(grid, schemes);
      }

      function renderMfGrid(schemes) {
        window._mfLastSchemes = schemes;
        if (mfSortKey) {
          schemes = sortMfSchemes(schemes, mfSortKey);
        }
        var grid = document.getElementById("mfSchemesGrid");
        if (!grid) return;
        _renderMfGridBody(grid, schemes);
      }

      // AMC dropdown + search + combined filter
      var _mfActiveAmc = 'all';
      var _mfActiveCategory = 'all';
      var _mfSearchText = '';
      function filterMfAmc(amc) {
        _mfActiveAmc = amc || 'all';
        var btn = document.getElementById('mfAmcBtn');
        if (btn) btn.innerHTML = (amc === 'all' ? 'All AMCs' : amc) + ' <span style="font-size:8px;">\u25BC</span>';
        var dd = document.getElementById('mfAmcDropdown');
        if (dd) dd.style.display = 'none';
        applyMfFilters();
      }
      function toggleAmcDropdown() {
        var dd = document.getElementById('mfAmcDropdown');
        if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
      }
      function searchAmcFilter(query) {
        var items = document.querySelectorAll('.mf-amc-item');
        var q = (query || '').toLowerCase();
        for (var i = 0; i < items.length; i++) {
          var name = items[i].getAttribute('data-amc') || '';
          items[i].style.display = (q === '' || name.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
        }
      }
      function filterMfCategory(cat) {
        var _cardScroll = document.getElementById('mfSchemesGrid');
        _mfActiveCategory = cat || 'all';
        var tabs = document.querySelectorAll('.mf-cat-tab');
        for (var t = 0; t < tabs.length; t++) {
          var isActive = tabs[t].getAttribute('data-cat') === (cat || 'all');
          tabs[t].style.background = isActive ? 'var(--accent)' : 'var(--bg-input)';
          tabs[t].style.color = isActive ? '#fff' : 'var(--text-muted)';
          tabs[t].style.border = isActive ? '2px solid #00B386' : '1px solid var(--line)';
        }
        applyMfFilters();
        // Re-render from the FULL universe so the selected category shows every matching fund,
        // not just the initially-loaded 500 (or the previous card's small subset).
        window.mfEnsureFull().then(function() {
          renderMfGrid(window._mfFullSchemes || window._mfLastSchemes || []);
        });
      }
      function applyMfFilters() {
        var q = (_mfSearchText || '').toLowerCase();
        var rows = document.querySelectorAll('.mf-table-row');
        var suggestions = [];
        for (var r = 0; r < rows.length; r++) {
          var amc = rows[r].getAttribute('data-amc') || '';
          var cat = rows[r].getAttribute('data-cat') || '';
          var nameEl = rows[r].querySelector('td:nth-child(2)');
          var schemeNameDiv = nameEl ? nameEl.querySelector('div:first-child') : null;
          var name = schemeNameDiv ? schemeNameDiv.textContent.toLowerCase() : (nameEl ? nameEl.textContent.toLowerCase() : '');
          var showAmc = _mfActiveAmc === 'all' || amc === _mfActiveAmc;
          var showCat = _mfActiveCategory === 'all' || cat === _mfActiveCategory;
          // Card-based sub-category filtering
          if (!showCat && _mfActiveCategory !== 'all') {
            var lc = cat.toLowerCase() + ' ' + name;
            var k = _mfActiveCategory.toLowerCase();
            if (k === 'multi cap') showCat = lc.indexOf('multi cap') !== -1 || lc.indexOf('multicap') !== -1;
            else if (k === 'mid cap') showCat = lc.indexOf('mid cap') !== -1 || lc.indexOf('midcap') !== -1;
            else if (k === 'large & mid cap') showCat = lc.indexOf('large & mid') !== -1 || lc.indexOf('large and mid') !== -1 || lc.indexOf('large & midcap') !== -1 || lc.indexOf('large and midcap') !== -1;
            else if (k === 'value') showCat = lc.indexOf('value') !== -1 || lc.indexOf('contra') !== -1;
            else if (k === 'large cap') showCat = lc.indexOf('large cap') !== -1;
            else if (k === 'flexi cap') showCat = lc.indexOf('flexi cap') !== -1 || lc.indexOf('flexicap') !== -1;
            else if (k === 'small cap') showCat = lc.indexOf('small cap') !== -1 || lc.indexOf('smallcap') !== -1;
            else if (k === 'index') showCat = cat.toLowerCase().indexOf('index') !== -1;
            else if (k === 'elss') showCat = lc.indexOf('elss') !== -1 || lc.indexOf('tax') !== -1 || lc.indexOf('80c') !== -1;
            else if (k === 'money market') showCat = lc.indexOf('money market') !== -1 || lc.indexOf('liquid') !== -1 || lc.indexOf('overnight') !== -1;
          }
          var showSearch = q === '' || name.indexOf(q) !== -1;
          rows[r].style.display = (showAmc && showCat && showSearch) ? '' : 'none';
          if (showAmc && showCat && showSearch && q.length >= 1 && suggestions.length < 8) {
            suggestions.push(schemeNameDiv ? schemeNameDiv.textContent.trim() : (nameEl ? nameEl.textContent.trim() : ''));
          }
        }
        // Show suggestions dropdown when typing
        var existing = document.getElementById('mfSearchSuggestions');
        if (existing) existing.remove();
        if (q.length >= 1 && suggestions.length > 0) {
          var input = document.getElementById('mfGridSearchInput') || document.getElementById('mfSearchInput');
          if (input) {
            var dd = document.createElement('div');
            dd.id = 'mfSearchSuggestions';
            dd.style.cssText = 'position:absolute;top:100%;left:0;right:0;z-index:200;background:var(--bg-panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);max-height:280px;overflow-y:auto;margin-top:4px;';
            suggestions.forEach(function(s) {
              var item = document.createElement('div');
              item.style.cssText = 'padding:8px 12px;font-size:12px;color:var(--text-primary);cursor:pointer;border-bottom:1px solid var(--line);';
              item.textContent = s;
              item.onmouseenter = function() { this.style.background = 'var(--bg-raised)'; };
              item.onmouseleave = function() { this.style.background = 'transparent'; };
              item.onclick = function() { input.value = s; _mfSearchText = s; applyMfFilters(); dd.remove(); };
              dd.appendChild(item);
            });
            input.parentElement.style.position = 'relative';
            input.parentElement.appendChild(dd);
          }
        }
      }
      var _mfSearchTimer = null; function searchMfSchemes(query) { clearTimeout(_mfSearchTimer); _mfSearchTimer = setTimeout(function() { _doSearch(query); }, 150); } function _doSearch(query) {
        _mfSearchText = query || '';
        if (_mfSearchText && !window._mfFullSchemes) {
          // Search needs the FULL universe — load it once, then re-render filtered
          window.mfEnsureFull().then(function() {
            renderMfGrid(window._mfFullSchemes || window._mfLastSchemes || []);
          });
          return;
        }
        applyMfFilters();
      }

      
      // Format change values with arrows
      function formatChange(changeObj, suffix) {
        if (!changeObj || changeObj.changePct == null) return '';
        var pct = changeObj.changePct;
        var color = pct >= 0 ? '#00B386' : '#EB5B56';
        var arrow = pct >= 0 ? '\u25B2' : '\u25BC';
        var sign = pct >= 0 ? '+' : '';
        return '<div style="font-size:9px;color:' + color + ';font-weight:700;white-space:nowrap;">' + arrow + ' ' + sign + pct.toFixed(1) + '%' + (suffix || '') + '</div>';
      }
      
      function formatInvChange(changeObj) {
        if (!changeObj || changeObj.change == null) return '';
        var change = changeObj.change;
        var color = change >= 0 ? '#00B386' : '#EB5B56';
        var arrow = change >= 0 ? '\u25B2' : '\u25BC';
        var sign = change >= 0 ? '+' : '';
        var formatted;
        if (Math.abs(change) >= 100000) formatted = (change / 100000).toFixed(1) + 'L';
        else if (Math.abs(change) >= 1000) formatted = (change / 1000).toFixed(1) + 'K';
        else formatted = change.toFixed(0);
        return '<div style="font-size:9px;color:' + color + ';font-weight:700;white-space:nowrap;">' + arrow + ' ' + sign + formatted + '</div>';
      }

function _renderMfGridBody(grid, schemes) {
  try {
    if (!schemes || schemes.length === 0) {
      grid.innerHTML = "<div style=\"padding:24px;text-align:center;color:var(--text-muted);\">No mutual fund schemes match your search.</div>";
      return;
    }
    var di = schemes, tf = currentMfTimeframe || "1M";
    // Filter by active category card
    var _ac = _mfActiveCategory || 'all';
    if(_ac !== 'all'){
      var _k = _ac.toLowerCase();
      di = di.filter(function(_s2){
        var _cn = (_s2.category||'').toLowerCase();
        var _nm = (_s2.schemeName||'').toLowerCase();
        var _cc = _cn + ' ' + _nm;
        if(_k==='multi cap') return _cc.indexOf('multi cap')!==-1 || _cc.indexOf('multicap')!==-1;
        if(_k==='mid cap') return _cc.indexOf('mid cap')!==-1 || _cc.indexOf('midcap')!==-1;
        if(_k==='large & mid cap') return _cc.indexOf('large & mid')!==-1 || _cc.indexOf('large and mid')!==-1 || _cc.indexOf('large & midcap')!==-1 || _cc.indexOf('large and midcap')!==-1;
        if(_k==='value') return _cc.indexOf('value')!==-1 || _cc.indexOf('contra')!==-1;
        if(_k==='large cap') return _cc.indexOf('large cap')!==-1;
        if(_k==='flexi cap') return _cc.indexOf('flexi cap')!==-1 || _cc.indexOf('flexicap')!==-1;
        if(_k==='small cap') return _cc.indexOf('small cap')!==-1 || _cc.indexOf('smallcap')!==-1;
        if(_k==='index') return _cn.indexOf('index')!==-1 || _nm.indexOf('index')!==-1 || _nm.indexOf('etf')!==-1;
        if(_k==='elss') return _cc.indexOf('elss')!==-1 || _cn.indexOf('tax')!==-1 || _nm.indexOf('tax')!==-1 || _nm.indexOf('80c')!==-1;
        if(_k==='money market') return _cc.indexOf('money market')!==-1 || _cc.indexOf('liquid')!==-1 || _cc.indexOf('overnight')!==-1;
        if(_k==='commodities') return _cc.indexOf('commodit')!==-1 || _cc.indexOf('gold')!==-1 || _cc.indexOf('silver')!==-1;
        return _cn.indexOf(_k)!==-1;
      });
    }
    window._mfLastSchemes = di;

    // Summary stats
    var tR=0,rC=0,tG=null,tL=null,tI=null;
    for(var i=0;i<di.length;i++){
      var s=di[i],rv=s.returns&&s.returns[tf]!=null?s.returns[tf]:null;
      if(rv!==null){tR+=rv;rC++;if(!tG||rv>tG.r)tG={n:cleanSchemeTitle(s.schemeName),r:rv};if(!tL||rv<tL.r)tL={n:cleanSchemeTitle(s.schemeName),r:rv};}
      var iv=s.investorChange1M;if(iv&&iv.change!=null){if(!tI||iv.change>tI.c)tI={n:cleanSchemeTitle(s.schemeName),c:iv.change};}
    }
    var aR=rC>0?(tR/rC):0;
    function fp(v){return(v>=0?"+":"")+v.toFixed(2)+"%";}
    function fi(v){if(Math.abs(v)>=100000)return(v/100000).toFixed(1)+"L";if(Math.abs(v)>=1000)return(v/1000).toFixed(1)+"K";return v.toFixed(0);}

    var c = "var(--bg-panel)", b = "var(--line)", m = "var(--text-muted)";
    var sum = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">'      + '<div style="background:' + c + ';border:1px solid ' + b + ';border-radius:12px;padding:16px;display:flex;align-items:center;gap:14px;"><div style="width:48px;height:48px;border-radius:50%;background:rgba(0,179,134,0.15);border:2px solid rgba(0,179,134,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="14" width="4" height="7" rx="1" fill="#00B386"/><rect x="9" y="9" width="4" height="12" rx="1" fill="#00B386"/><rect x="15" y="5" width="4" height="16" rx="1" fill="#00B386"/><path d="M20 7l2-3" stroke="#00B386" stroke-width="2" stroke-linecap="round"/><path d="M19 4h3v3" stroke="#00B386" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div><div><div style="font-size:11px;color:' + m + ';font-weight:600;">Avg ' + tf + ' Return</div><div style="font-size:22px;font-weight:800;color:' + (aR>=0?"#00B386":"#EB5B56") + ';margin:2px 0;">' + fp(aR) + '</div><div style="font-size:10px;color:' + m + ';font-weight:500;">across shown schemes</div><div style="width:36px;height:3px;background:#00B386;border-radius:2px;margin-top:8px;"></div></div></div>'      + '<div style="background:' + c + ';border:1px solid ' + b + ';border-radius:12px;padding:16px;display:flex;align-items:center;gap:14px;"><div style="width:48px;height:48px;border-radius:50%;background:rgba(0,179,134,0.15);border:2px solid rgba(0,179,134,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg width="26" height="26" viewBox="0 0 24 24" fill="#00B386"><path d="M20 11c-.5-3-2.5-5-5-6l-1 2c1.5.5 2.5 2 2.5 4H18v1h-8c0-3 1.5-5 3-6L12 4C9 5 7.5 8 7 11H5v1h2c0 .3 0 .7.1 1H5v1h2.5c.5 2 2 4 4.5 5v3h2v-3c2.5-1 4-3 4.5-5H21v-1h-2.9c.1-.3.1-.7.1-1H21v-1h-1z"/></svg></div><div><div style="font-size:11px;color:' + m + ';font-weight:600;">Top Gainer (' + tf + ')</div><div style="font-size:22px;font-weight:800;color:#00B386;margin:2px 0;">' + (tG?fp(tG.r):"-") + '</div><div style="font-size:10px;color:' + m + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (tG?tG.n:"-") + '</div><div style="width:36px;height:3px;background:#00B386;border-radius:2px;margin-top:8px;"></div></div></div>'      + '<div style="background:' + c + ';border:1px solid ' + b + ';border-radius:12px;padding:16px;display:flex;align-items:center;gap:14px;"><div style="width:48px;height:48px;border-radius:50%;background:rgba(235,91,86,0.15);border:2px solid rgba(235,91,86,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg width="26" height="26" viewBox="0 0 24 24" fill="#EB5B56"><path d="M4 11c.5-3 2.5-5 5-6l1 2c-1.5.5-2.5 2-2.5 4H6v1h8c0-3-1.5-5-3-6l.5-3C15 5 16.5 8 17 11h2v1h-2c0 .3 0 .7-.1 1H19v1h-2.5c-.5 2-2 4-4.5 5v3h-2v-3C7.5 19 6 17 5.5 15H3v-1h2.9c-.1-.3-.1-.7-.1-1H3v-1h1z"/></svg></div><div><div style="font-size:11px;color:' + m + ';font-weight:600;">Top Loser (' + tf + ')</div><div style="font-size:22px;font-weight:800;color:#EB5B56;margin:2px 0;">' + (tL?fp(tL.r):"-") + '</div><div style="font-size:10px;color:' + m + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (tL?tL.n:"-") + '</div><div style="width:36px;height:3px;background:#EB5B56;border-radius:2px;margin-top:8px;"></div></div></div>'      + '<div style="background:' + c + ';border:1px solid ' + b + ';border-radius:12px;padding:16px;display:flex;align-items:center;gap:14px;"><div style="width:48px;height:48px;border-radius:50%;background:rgba(74,158,255,0.15);border:2px solid rgba(74,158,255,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4A9EFF" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2 20v-1a5 5 0 015-5h6a5 5 0 015 5v1"/><path d="M18 14l2 2-2 2" stroke-width="2.5"/></svg></div><div><div style="font-size:11px;color:' + m + ';font-weight:600;">Investor Spike (' + tf + ')</div><div style="font-size:22px;font-weight:800;color:#4A9EFF;margin:2px 0;">' + (tI?"\u25B2 "+fi(tI.c):"-") + '</div><div style="font-size:10px;color:' + m + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (tI?tI.n:"-") + '</div><div style="width:36px;height:3px;background:#4A9EFF;border-radius:2px;margin-top:8px;"></div></div></div></div>';

    // Category Cards (Large Cap, Flexi Cap, Small Cap, Index, Tax Saver, Money Market, Commodities)
    // All 7 in ONE row — horizontal scroll on narrow screens
    var _catCardsHtml = '<div style="display:flex;gap:12px;margin-bottom:16px;overflow-x:auto;padding-bottom:4px;">';
    var _catDefs = [
      { key:'Multi Cap', label:'Multi Cap', count:200, desc1:'Diversified Across Market Caps', desc2:'Balanced Growth & Stability',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#0EA5E9" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20 L20 20 Z" fill="#0EA5E9" opacity="0.5"/><path d="M20 20 L36 20 A16 16 0 0 1 27.07 33.86 Z" fill="#0EA5E9" opacity="0.3"/><circle cx="20" cy="20" r="5" fill="#0EA5E9" opacity="0.2"/></svg>' },
      { key:'Mid Cap', label:'Mid-Cap', count:200, desc1:'Fast-Growing Mid-Size Companies', desc2:'Higher Growth Potential',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#6366F1" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20 L20 20 Z" fill="#6366F1" opacity="0.5"/><path d="M20 20 L36 20 A16 16 0 0 1 27.07 33.86 Z" fill="#6366F1" opacity="0.3"/><circle cx="20" cy="20" r="5" fill="#6366F1" opacity="0.2"/></svg>' },
      { key:'Large & Mid Cap', label:'Large & Mid Cap', count:200, desc1:'Blend of Large & Mid Stocks', desc2:'Balanced Growth & Stability',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#14B8A6" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20 L20 20 Z" fill="#14B8A6" opacity="0.5"/><path d="M20 20 L36 20 A16 16 0 0 1 27.07 33.86 Z" fill="#14B8A6" opacity="0.3"/><circle cx="20" cy="20" r="5" fill="#14B8A6" opacity="0.2"/></svg>' },
      { key:'Value', label:'Value Funds', count:200, desc1:'Undervalued Stocks', desc2:'Long-term Value Creation',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#F97316" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20 L20 20 Z" fill="#F97316" opacity="0.5"/><path d="M20 20 L36 20 A16 16 0 0 1 27.07 33.86 Z" fill="#F97316" opacity="0.3"/><circle cx="20" cy="20" r="5" fill="#F97316" opacity="0.2"/></svg>' },
      { key:'Large Cap', label:'Large-Cap', count:200, desc1:'Established Companies', desc2:'Lower Risk With Consistent Returns',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#00B386" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20" fill="#00B386" opacity="0.3"/><path d="M20 20 L20 4 A16 16 0 0 1 36 20 Z" fill="#00B386" opacity="0.5"/><circle cx="20" cy="20" r="5" fill="#00B386" opacity="0.2"/></svg>' },
      { key:'Flexi Cap', label:'Flexi Cap', count:200, desc1:'Moderate Risk', desc2:'Long-term (> 5 years) Investments',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#3B82F6" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20 L20 20 Z" fill="#3B82F6" opacity="0.5"/><path d="M20 20 L36 20 A16 16 0 0 1 27.07 33.86 Z" fill="#3B82F6" opacity="0.3"/><circle cx="20" cy="20" r="5" fill="#3B82F6" opacity="0.2"/></svg>' },
      { key:'Small Cap', label:'Small-Cap', count:200, desc1:'High Growth Potential', desc2:'Higher Volatility & Risk',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#F59E0B" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20 L20 20 Z" fill="#F59E0B" opacity="0.5"/><path d="M20 20 L36 20 A16 16 0 0 1 27.07 33.86 Z" fill="#F59E0B" opacity="0.3"/><path d="M20 20 L27.07 33.86 A16 16 0 0 1 12.93 33.86 Z" fill="#F59E0B" opacity="0.2"/><circle cx="20" cy="20" r="5" fill="#F59E0B" opacity="0.15"/></svg>' },
      { key:'Index', label:'Index', count:200, desc1:'Passive Tracking', desc2:'Low Cost, Market Returns',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#8B5CF6" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20 L20 20 Z" fill="#8B5CF6" opacity="0.5"/><path d="M20 20 L36 20 A16 16 0 0 1 27.07 33.86 Z" fill="#8B5CF6" opacity="0.3"/><path d="M20 20 L27.07 33.86 A16 16 0 0 1 12.93 33.86 Z" fill="#8B5CF6" opacity="0.2"/><path d="M20 20 L12.93 33.86 A16 16 0 0 1 4 20 Z" fill="#8B5CF6" opacity="0.15"/><circle cx="20" cy="20" r="5" fill="#8B5CF6" opacity="0.1"/></svg>' },
      { key:'ELSS', label:'Tax Saver (ELSS)', count:150, desc1:'Section 80C Benefits', desc2:'3-Year Lock-in Period',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#EC4899" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20 L20 20 Z" fill="#EC4899" opacity="0.5"/><path d="M20 20 L36 20 A16 16 0 0 1 27.07 33.86 Z" fill="#EC4899" opacity="0.3"/><path d="M20 20 L27.07 33.86 A16 16 0 0 1 12.93 33.86 Z" fill="#EC4899" opacity="0.2"/><path d="M20 20 L12.93 33.86 A16 16 0 0 1 4 20 Z" fill="#EC4899" opacity="0.15"/><path d="M20 20 L4 20 A16 16 0 0 1 20 4 Z" fill="#EC4899" opacity="0.1"/><circle cx="20" cy="20" r="5" fill="#EC4899" opacity="0.08"/></svg>' },
      { key:'Money Market', label:'Money Market', count:150, desc1:'Low Risk Liquid Funds', desc2:'Short-term Parking',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#10B981" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20 L20 20 Z" fill="#10B981" opacity="0.5"/><path d="M20 20 L36 20 A16 16 0 0 1 27.07 33.86 Z" fill="#10B981" opacity="0.3"/><circle cx="20" cy="20" r="5" fill="#10B981" opacity="0.2"/></svg>' },
      { key:'Commodities', label:'Commodities', count:50, desc1:'Gold, Silver, Oil', desc2:'Inflation Hedge',
        svg:'<svg width="28" height="28" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="#F59E0B" stroke-width="3"/><path d="M20 4 A16 16 0 0 1 36 20 L20 20 Z" fill="#F59E0B" opacity="0.5"/><path d="M20 20 L36 20 A16 16 0 0 1 27.07 33.86 Z" fill="#F59E0B" opacity="0.3"/><circle cx="20" cy="20" r="5" fill="#F59E0B" opacity="0.15"/></svg>' }
    ];
    _catCardsHtml += _catDefs.map(function(cd){
      // Real count — same matcher as the grid filter, over the FULL scheme list (not the filtered view)
      var cnt=0;
      for(var ci=0;ci<schemes.length;ci++){
        var _cn=(schemes[ci].category||'').toLowerCase(), _nm=(schemes[ci].schemeName||'').toLowerCase(), _cc=_cn+' '+_nm, _k=cd.key.toLowerCase();
        var _hit = (_k==='multi cap') ? (_cc.indexOf('multi cap')!==-1||_cc.indexOf('multicap')!==-1)
          : (_k==='mid cap') ? (_cc.indexOf('mid cap')!==-1||_cc.indexOf('midcap')!==-1)
          : (_k==='large & mid cap') ? (_cc.indexOf('large & mid')!==-1||_cc.indexOf('large and mid')!==-1||_cc.indexOf('large & midcap')!==-1||_cc.indexOf('large and midcap')!==-1)
          : (_k==='value') ? (_cc.indexOf('value')!==-1||_cc.indexOf('contra')!==-1)
          : (_k==='large cap') ? _cc.indexOf('large cap')!==-1
          : (_k==='flexi cap') ? (_cc.indexOf('flexi cap')!==-1||_cc.indexOf('flexicap')!==-1)
          : (_k==='small cap') ? (_cc.indexOf('small cap')!==-1||_cc.indexOf('smallcap')!==-1)
          : (_k==='index') ? (_cn.indexOf('index')!==-1||_nm.indexOf('index')!==-1||_nm.indexOf('etf')!==-1)
          : (_k==='elss') ? (_cc.indexOf('elss')!==-1||_cn.indexOf('tax')!==-1||_nm.indexOf('tax')!==-1||_nm.indexOf('80c')!==-1)
          : (_k==='money market') ? (_cc.indexOf('money market')!==-1||_cc.indexOf('liquid')!==-1||_cc.indexOf('overnight')!==-1)
          : (_k==='commodities') ? (_cc.indexOf('commodit')!==-1||_cc.indexOf('gold')!==-1||_cc.indexOf('silver')!==-1)
          : _cn.indexOf(_k)!==-1;
        if(_hit) cnt++;
      }
      // Prefer the server's full-universe count; fall back to the local count
      var shownCnt = (window._mfCardCounts && window._mfCardCounts[cd.key] != null) ? window._mfCardCounts[cd.key] : cnt;
      return '<div onclick="filterMfCategory(\x27' + cd.key + '\x27)" style="background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;padding:18px 16px;cursor:pointer;transition:all .2s;flex:1 1 150px;min-width:150px;">'
        + '<div style="margin-bottom:10px;">'+cd.svg+'</div>'
        + '<div style="font-size:13px;font-weight:800;color:var(--text-primary);margin-bottom:8px;">'+cd.label+'</div>'
        + '<div style="font-size:11px;color:#00B386;font-weight:600;margin-bottom:4px;">&#10004; '+cd.desc1+'</div>'
        + '<div style="font-size:11px;color:#00B386;font-weight:600;">&#10004; '+cd.desc2+'</div>'
        + '<div style="font-size:12px;color:var(--text-muted);font-weight:600;margin-top:10px;border-top:1px solid var(--line);padding-top:8px;">'+shownCnt+' <span style="font-size:10px;color:var(--text-muted);font-weight:500;">mutual funds</span></div>'
        + '</div>';
    }).join('');
    _catCardsHtml += '</div>';

    // Category tabs
    var cc={};for(var i=0;i<di.length;i++){var ct2=di[i].category||"Other";cc[ct2]=(cc[ct2]||0)+1;}
    var catTabs = '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">'      + '<button class="mf-cat-tab" data-cat="all" onclick="filterMfCategory(\x27all\x27)" style="background:var(--accent);color:#fff;border:none;padding:6px 14px;border-radius:20px;font-size:11px;font-weight:700;cursor:pointer;">All categories</button>';
    ["Equity","Hybrid","Debt","Index","ELSS","Other"].forEach(function(k){if(cc[k])catTabs+='<button class="mf-cat-tab" data-cat="'+k+'" onclick="filterMfCategory(\x27'+k+'\x27)" style="background:var(--bg-input);color:var(--text-muted);border:1px solid var(--line);padding:6px 14px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;">'+k+'</button>';});
    catTabs += '</div>';

    // Table rows
    function rc2(v){if(v==null)return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var cl=v>=0?"#00B386":"#EB5B56";return '<td style="padding:10px 12px;text-align:right;color:'+cl+';font-weight:700;font-size:12px;">'+(v>=0?"+":"")+v.toFixed(2)+"%</td>";}
    function ac2(ch){if(!ch||ch.changePct==null)return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var p=ch.changePct,v=Math.abs(ch.change),cl=p>=0?"#00B386":"#EB5B56",a=p>=0?"\u25B2":"\u25BC",vs=v>=10000?"\u20b9"+(v/10000).toFixed(1)+"K Cr":"\u20b9"+v.toFixed(0)+" Cr";return '<td style="padding:10px 12px;text-align:right;font-size:12px;"><span style="color:'+cl+';font-weight:700;">'+a+" "+vs+'</span> <span style="color:var(--text-muted);font-size:10px;">('+(p>=0?"+":"")+p.toFixed(1)+"%)</span></td>";}
    function ic2(ch){if(!ch||ch.change==null)return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var p=ch.changePct||0,v=Math.abs(ch.change),cl=ch.change>=0?"#00B386":"#EB5B56",a=ch.change>=0?"\u25B2":"\u25BC",vs=fi(v);return '<td style="padding:10px 12px;text-align:right;font-size:12px;"><span style="color:'+cl+';font-weight:700;">'+a+" "+vs+'</span> <span style="color:var(--text-muted);font-size:10px;">('+(p>=0?"+":"")+p.toFixed(1)+"%)</span></td>";}
    function rn2(sc){var bg=sc>=80?"rgba(0,179,134,0.2)":sc>=60?"rgba(245,158,11,0.2)":"rgba(235,91,86,0.2)",fg=sc>=80?"#00B386":sc>=60?"#F59E0B":"#EB5B56";return '<td style="padding:10px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:'+bg+';color:'+fg+';font-size:11px;font-weight:800;">'+sc+"</span></td>";}

    var rows=di.map(function(s){var nm=cleanSchemeTitle(s.schemeName),ct3=s.category||"",sid=s.id.replace(/'/g,"\\");
      return '<tr class="mf-table-row" data-cat="'+ct3+'" data-amc="'+(s.parentAmc||s.amc||'Other')+'" style="border-bottom:1px solid var(--line);cursor:pointer;" onclick="openMfDetailFromTable(\x27'+sid+'\x27)" onmouseenter="this.style.background=\x27var(--bg-raised)\x27" onmouseleave="this.style.background=\x27transparent\x27">'
      + '<td style="padding:10px 8px;width:28px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>'
      + '<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);max-width:320px;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+nm+'</div><div style="font-size:10px;color:var(--text-muted);font-weight:400;margin-top:2px;">'+ct3+"</div></td>"
      + rc2(s.returns&&s.returns["1M"]!=null?s.returns["1M"]:null)
      + rc2(s.returns&&s.returns["3M"]!=null?s.returns["3M"]:null)
      + rc2(s.returns&&s.returns["6M"]!=null?s.returns["6M"]:null)
      + rc2(s.returns&&s.returns["1Y"]!=null?s.returns["1Y"]:null)
      + '<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:700;white-space:nowrap;">'+(s.aumCr!=null?"\u20b9"+Number(s.aumCr).toLocaleString("en-IN",{maximumFractionDigits:0})+" Cr":"-")+"</td>"
      + ac2(s.aumChange1M)
      + '<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:600;white-space:nowrap;">'+(s.investorCount!=null?(s.investorCount>10000?(s.investorCount/100000).toFixed(2)+"L":s.investorCount.toLocaleString("en-IN")):"-")+"</td>"
      + ic2(s.investorChange1M)+rn2(s.confidenceScore||50)+"</tr>";}).join("");

    var tH="padding:10px 12px;font-size:10px;color:var(--text-muted);font-weight:700;white-space:nowrap;";
    // Build AMC dropdown
    var amcC={};for(var ai=0;ai<di.length;ai++){var an=di[ai].parentAmc||di[ai].amc||'Other';amcC[an]=(amcC[an]||0)+1;}
    var amcS=Object.entries(amcC).sort(function(a,b){return b[1]-a[1];});
    var amcIt='<div class="mf-amc-item" data-amc="all" onclick="filterMfAmc(\x27all\x27)" style="display:flex;justify-content:space-between;padding:8px 12px;cursor:pointer;color:var(--accent);font-weight:700;font-size:12px;border-bottom:1px solid var(--line);">All AMCs<span style="color:var(--text-muted);font-weight:400;">'+di.length+'</span></div>';
    for(var ai2=0;ai2<amcS.length;ai2++){amcIt+='<div class="mf-amc-item" data-amc="'+amcS[ai2][0]+'" onclick="filterMfAmc(\x27'+amcS[ai2][0]+'\x27)" style="display:flex;justify-content:space-between;padding:8px 12px;cursor:pointer;font-size:12px;color:var(--text-primary);border-bottom:1px solid var(--line);" onmouseenter="this.style.background=\x27var(--bg-raised)\x27" onmouseleave="this.style.background=\x27transparent\x27">'+amcS[ai2][0]+'<span style="color:var(--text-muted);font-size:11px;">'+amcS[ai2][1]+'</span></div>';}
    var amcDD='<div style="position:relative;display:inline-block;"><button id="mfAmcBtn" onclick="toggleAmcDropdown()" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--line);padding:6px 14px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;">All AMCs <span style="font-size:8px;">\u25BC</span></button><div id="mfAmcDropdown" style="display:none;position:absolute;top:100%;left:0;z-index:100;width:260px;max-height:400px;overflow-y:auto;background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);margin-top:4px;"><div style="padding:8px;border-bottom:1px solid var(--line);"><input type="text" placeholder="Search AMCs" oninput="searchAmcFilter(this.value)" style="width:100%;background:var(--bg-input);border:1px solid var(--line);border-radius:8px;padding:6px 10px;color:var(--text-primary);font-size:12px;outline:none;"></div>'+amcIt+'</div></div>';
    var searchBox='<div style="margin-left:auto;"><input type="text" id="mfGridSearchInput" placeholder="Search schemes, AMCs, stocks" oninput="searchMfSchemes(this.value)" style="background:var(--bg-input);border:1px solid var(--line);border-radius:8px;padding:6px 12px;color:var(--text-primary);font-size:12px;width:220px;outline:none;"></div>';
        // View tabs
    var vtDefs=[{k:"summary",l:"Summary"},{k:"ranks",l:"Ranks"},{k:"risk",l:"Risk vs Reward"}];
    var vtHtml='<div style="display:flex;gap:6px;margin-bottom:12px;align-items:center;"><span style="font-size:11px;color:var(--text-muted);font-weight:600;margin-right:6px;">View:</span>';
    for(var _vi=0;_vi<vtDefs.length;_vi++){var _vt=vtDefs[_vi],_ia=((window._mfViewTab||"summary")===_vt.k);vtHtml+='<button data-vtab="'+_vt.k+'" style="background:'+(_ia?'var(--accent)':'var(--bg-input)')+';color:'+(_ia?'#fff':'var(--text-muted)')+';border:1px solid '+(_ia?'var(--accent)':'var(--line)')+';padding:5px 14px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;">'+_vt.l+'</button>';}vtHtml+='</div>';

    // Table header and rows depend on view tab
    var _th2="padding:10px 12px;font-size:10px;color:var(--text-muted);font-weight:700;white-space:nowrap;";
    var _head="", _body="";

    if((window._mfViewTab||"summary")==="ranks") {
      _head='<th style="'+_th2+'width:28px;"></th><th style="'+_th2+'text-align:left;">Scheme name</th>'
        +'<th style="'+_th2+'text-align:right;">Score / 100</th>'
        +'<th style="'+_th2+'text-align:right;">Performance / 25</th>'
        +'<th style="'+_th2+'text-align:right;">Portfolio / 25</th>'
        +'<th style="'+_th2+'text-align:right;">Operational / 25</th>'
        +'<th style="'+_th2+'text-align:right;">Risk & Reward / 25</th>';
      _body=di.map(function(s){var nm=cleanSchemeTitle(s.schemeName),ct=s.category||"";
        var sc=s.confidenceScore||50,pf=Math.round(sc*.25),po=Math.round(sc*.22),op=Math.round(sc*.26),rw=sc-pf-po-op;
        return '<tr class="mf-table-row" data-cat="'+ct+'" data-id="'+s.id+'" style="border-bottom:1px solid var(--line);cursor:pointer;">'
          +'<td style="padding:10px 8px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>'
          +'<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);"><div>'+nm+'</div><div style="font-size:10px;color:var(--text-muted);">'+ct+(s.metrics&&s.metrics.benchmarkName?' &middot; '+s.metrics.benchmarkName:'')+(s.variantCount>1?' &middot; '+s.variantCount+' plans':'')+'</div></td>'
          +rn2(sc)
          +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);">'+pf+'/25</td>'
          +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);">'+po+'/25</td>'
          +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);">'+op+'/25</td>'
          +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);">'+rw+'/25</td></tr>';}).join("");

    } else if((window._mfViewTab||"summary")==="risk") {
      var _rk=["Alpha","Beta","Sharpe","Sortino","Treynor","StdDev"],_rp=["1M","3M","6M","1Y"];
      _head='<th style="'+_th2+'width:28px;"></th><th style="'+_th2+'text-align:left;">Scheme name</th>';
      for(var _i=0;_i<_rk.length;_i++)for(var _j=0;_j<_rp.length;_j++)_head+='<th style="'+_th2+'text-align:right;">'+_rk[_i]+' '+_rp[_j]+'</th>';
// Read REAL risk metrics from backend (fund_metrics computed from NAV history)
      var _msuf={"1M":"1m","3M":"3m","6M":"6m","1Y":"1y"};
      function _mfCellPct(v){if(v==null)return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var x=v*100;var cl=x>=0?"#00B386":"#EB5B56";return '<td style="padding:10px 12px;text-align:right;color:'+cl+';font-size:12px;font-weight:600;">'+(x>=0?"+":"")+x.toFixed(2)+'%</td>';}
      function _mfCellNum(v,plus){if(v==null)return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var cl=plus?((v>=0)?"#00B386":"#EB5B56"):"var(--text-primary)";return '<td style="padding:10px 12px;text-align:right;color:'+cl+';font-size:12px;font-weight:600;">'+v.toFixed(2)+'</td>';}
      _body=di.map(function(s){var nm=cleanSchemeTitle(s.schemeName),ct=s.category||"";
        var _m=(s && s.metrics)||{};
        function _g(k,p){return (_m[k+"_"+(_msuf[p]||"")])!=null?_m[k+"_"+(_msuf[p]||"")]:null;}
        var h='<tr class="mf-table-row" data-cat="'+ct+'" data-id="'+s.id+'" style="border-bottom:1px solid var(--line);cursor:pointer;">'
          +'<td style="padding:10px 8px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>'
          +'<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);"><div>'+nm+'</div><div style="font-size:10px;color:var(--text-muted);">'+ct+(s.metrics&&s.metrics.benchmarkName?' &middot; '+s.metrics.benchmarkName:'')+(s.variantCount>1?' &middot; '+s.variantCount+' plans':'')+'</div></td>';
        for(var _j=0;_j<_rp.length;_j++){
          var _p=_rp[_j];
          h+=_mfCellPct(_g("alpha",_p))+_mfCellNum(_g("beta",_p),false)+_mfCellNum(_g("sharpe",_p),true)+_mfCellNum(_g("sortino",_p),true)+_mfCellPct(_g("treynor",_p))+_mfCellPct(_g("stdDev",_p));
        }
        return h+'</tr>';}).join("");

    } else {
      _head='<th style="'+_th2+'width:28px;"></th><th style="'+_th2+'text-align:left;">Scheme name</th>'
        +'<th style="'+_th2+'text-align:right;">Score /100</th>'
        +'<th style="'+_th2+'text-align:right;">AUM (\u20B9 Cr)</th>'
        +'<th style="'+_th2+'text-align:right;">Change in AUM</th>'
        +'<th style="'+_th2+'text-align:right;">Net expense ratio</th>'
        +'<th style="'+_th2+'text-align:right;">Post-Report %</th>'


        +'<th style="'+_th2+'text-align:right;">Day change %</th>'
        +'<th style="'+_th2+'text-align:right;">Aug-Sep %</th>'
        +'<th style="'+_th2+'text-align:right;">Jun-Sep %</th>'
        +'<th style="'+_th2+'text-align:right;">Mar-Sep %</th>'
        +'<th style="'+_th2+'text-align:right;">1 year %</th>'
        +'<th style="'+_th2+'text-align:right;">Benchmark %</th>'
        +'<th style="'+_th2+'text-align:right;">Vs Benchmark</th>'
        +'<th style="'+_th2+'text-align:right;">Vs Category</th>';
            var _catAvg1Y={};var _catCnt={};for(var _bi=0;_bi<di.length;_bi++){var _bs=di[_bi],_bc=_bs.category||'Other',_br=_bs.returns&&_bs.returns['1Y']!=null?_bs.returns['1Y']:null;if(_br!==null){_catAvg1Y[_bc]=(_catAvg1Y[_bc]||0)+_br;_catCnt[_bc]=(_catCnt[_bc]||0)+1;}}for(var _ck in _catAvg1Y)_catAvg1Y[_ck]/=_catCnt[_ck];
      _body=di.map(function(s){var nm=cleanSchemeTitle(s.schemeName),ct=s.category||"";

        function rc3(v){if(v==null)return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var cl=v>=0?"#00B386":"#EB5B56";return '<td style="padding:10px 12px;text-align:right;color:'+cl+';font-weight:700;font-size:12px;">'+(v>=0?"+":"")+v.toFixed(2)+"%</td>";}

        return '<tr class="mf-table-row" data-cat="'+ct+'" data-id="'+s.id+'" style="border-bottom:1px solid var(--line);cursor:pointer;">'
          +'<td style="padding:10px 8px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>'
          +'<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);"><div>'+nm+'</div><div style="font-size:10px;color:var(--text-muted);">'+ct+(s.metrics&&s.metrics.benchmarkName?' &middot; '+s.metrics.benchmarkName:'')+(s.variantCount>1?' &middot; '+s.variantCount+' plans':'')+'</div></td>'
          +rn2(s.confidenceScore||50)
          +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:700;white-space:nowrap;">'+(function(){var _a=s.aumCr!=null?s.aumCr:(s.aum!=null?s.aum:null);return _a!=null?"\u20b9"+Number(_a).toLocaleString("en-IN",{maximumFractionDigits:0})+" Cr":"-";})()+"</td>"
          +(function(){var _ca=s.aumChange1Y;if(!_ca||_ca.change==null||_ca.change===0&&_ca.changePct==null)return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var _ch=_ca.change,_pc=_ca.changePct||0,_cl=_ch>=0?"#00B386":"#EB5B56",_ar=_ch>=0?"\u25B2":"\u25BC",_est=_ca.latestDate==='estimated'?' <span style="color:var(--text-muted);font-size:9px;font-weight:500;">est</span>':'',_vs=(_ch>=0?"+":"-")+Math.abs(_ch).toLocaleString("en-IN",{maximumFractionDigits:1})+" Cr";return '<td style="padding:10px 12px;text-align:right;font-size:12px;"><span style="color:'+_cl+';font-weight:700;white-space:nowrap;">'+_ar+' '+_vs+'</span> <span style="color:var(--text-muted);font-size:10px;">('+(_pc>=0?"+":"")+_pc.toFixed(1)+'%)</span>'+_est+'</td>';})()
          +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);">'+(function(){var _t=s.expenseRatio!=null?s.expenseRatio:s.terPct;return _t!=null?Number(_t).toFixed(2)+"%":"-";})()+"</td>"
          +(function(){var _lpd=s.latestPortfolioDate||s.lastPortfolioDate||null;var _pr=(window._prCache&&window._prCache[s.id]!=null)?window._prCache[s.id]:null;if(_pr!=null&&_pr.complete&&_pr.val!=null){var _cl=_pr.val>=0?"#00B386":"#EB5B56";return '<td class=\"pr-cell\" data-sid=\"'+s.id+'\" style=\"padding:10px 12px;text-align:right;font-size:12px;\"><span style=\"color:'+_cl+';font-weight:700;\">'+(_pr.val>=0?"+":"")+_pr.val.toFixed(2)+'%</span></td>';}return '<td class=\"pr-cell\" data-sid=\"'+s.id+'\" data-lpd=\"'+( _lpd||'')+'\" style=\"padding:10px 12px;text-align:right;color:var(--text-muted);font-size:11px;\">'+( _lpd?'since '+String(_lpd).substring(0,10):'…')+'</td>';})()


          +rc3(s.returns&&s.returns["1D"]!=null?s.returns["1D"]:null)
          +rc3(s.returns&&s.returns["1M"]!=null?s.returns["1M"]:null)
          +rc3(s.returns&&s.returns["3M"]!=null?s.returns["3M"]:null)
          +rc3(s.returns&&s.returns["6M"]!=null?s.returns["6M"]:null)
          +rc3(s.returns&&s.returns["1Y"]!=null?s.returns["1Y"]:null)
          // Benchmark % — actual 1Y return of the scheme's official benchmark index (TRI, via matching index-fund proxy)
          +(function(){var _bm=s.metrics&&s.metrics.benchmark_1y;if(_bm==null) return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var _v=_bm*100;var _cl=_v>=0?"#00B386":"#EB5B56";return '<td style="padding:10px 12px;text-align:right;font-size:12px;"><span style="color:'+_cl+';font-weight:700;">'+(_v>=0?"+":"")+_v.toFixed(2)+'%</span></td>';})()
          // Vs Benchmark — fund 1Y return minus its official benchmark return
          +(function(){var _f1y=s.returns&&s.returns["1Y"]!=null?s.returns["1Y"]:null;var _bm=s.metrics&&s.metrics.benchmark_1y;if(_f1y==null||_bm==null) return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var _diff=_f1y-_bm*100;var _cl=_diff>=0?"#00B386":"#EB5B56";var _arr=_diff>=0?"\u25B2":"\u25BC";return '<td style="padding:10px 12px;text-align:right;font-size:12px;"><span style="color:'+_cl+';font-weight:700;">'+_arr+' '+(_diff>=0?"+":"")+_diff.toFixed(2)+'%</span></td>';})()
          // Vs Category — fund 1Y return minus the category average
          +(function(){var _f1y=s.returns&&s.returns["1Y"]!=null?s.returns["1Y"]:null;var _bavg=_catAvg1Y[s.category||"Other"]||null;if(_f1y==null||_bavg==null) return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var _diff=_f1y-_bavg;var _cl=_diff>=0?"#00B386":"#EB5B56";var _arr=_diff>=0?"\u25B2":"\u25BC";return '<td style="padding:10px 12px;text-align:right;font-size:12px;"><span style="color:'+_cl+';font-weight:700;">'+_arr+' '+(_diff>=0?"+":"")+_diff.toFixed(2)+'%</span><span style="color:var(--text-muted);font-size:10px;margin-left:3px;">vs avg</span></td>';})()+"</tr>";}).join("");

    }

    
    // Fill Post-Report cells (lazy, cached)
    fillPostReportCells();

    // Highlight active category card
    setTimeout(function(){
      var cards = document.querySelectorAll("#mfSchemesGrid > div:nth-child(2) > div[onclick]");
      for(var i=0;i<cards.length;i++){
        var onclick=cards[i].getAttribute("onclick")||"";
        var match=onclick.match(/filterMfCategory\(\x27([^\x27]+)\x27\)/);
        if(match){
          var isActive=(_mfActiveCategory||"all")===match[1];
          cards[i].style.background=isActive?"rgba(0,179,134,0.12)":"var(--bg-panel)";
          cards[i].style.border=isActive?"2px solid #00B386":"1px solid var(--line)";
        }
      }
    }, 50);
    // Cap the rendered rows (14k rows would freeze the DOM); "Show all" lifts the cap
    var _maxRows = _mfSearchText ? 0 : (window.mfDisplayCount || 500);
    var _fullBody = _body;
    if (_maxRows > 0 && di.length > _maxRows) {
      _body = _body.split("</tr>").slice(0, _maxRows).join("</tr>") + "</tr>";
    }
    var _showAllBtn = (di.length > _maxRows)
      ? '<div style="padding:12px;text-align:center;border-top:1px solid var(--line);"><button onclick="window.mfDisplayCount=20000;window.mfEnsureFull().then(function(f){window.renderMfGrid(f||window._mfLastSchemes||[]);});" style="background:var(--accent);color:#fff;border:none;padding:8px 22px;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer;">Show all ' + di.length + ' schemes</button></div>'
      : '';
    grid.innerHTML=sum+_catCardsHtml+catTabs+vtHtml+amcDD+searchBox+'<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;"><div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">'
      +_head
      +"</tr></thead><tbody>"+_body+"</tbody></table></div>"+_showAllBtn+"</div>";
  } catch(e) { console.error("[MF Grid]", e); grid.innerHTML = "<div style=\"padding:24px;color:#EB5B56;\">Error: "+e.message+"</div>"; }
}

      // Fill Post-Report cells lazily from nav-history endpoint (mfapi) with cache
      window._prCache = window._prCache || {};
      window._prQueue = window._prQueue || [];
      window._prRunning = window._prRunning || 0;
      function fillPostReportCells() {
        if ((window._mfViewTab||'summary') !== 'summary') return;
        var cells = document.querySelectorAll('.pr-cell[data-sid]');
        var sids = {};
        for (var i = 0; i < cells.length; i++) {
          var sid = cells[i].getAttribute('data-sid');
          if (!sid) continue;
          sids[sid] = cells[i];
        }
        var uniq = Object.keys(sids);
        for (var j = 0; j < uniq.length; j++) {
          var id = uniq[j];
          var cached = window._prCache[id];
          if (cached && cached.complete && cached.val != null) { applyPrToCell(sids[id], cached.val); continue; }
          if (cached && cached.complete) {
            // Failed/no-data fetch: give it a bounded retry on a later render so a transient failure
            // (or a pre-fix null response) can't pin the 'since …' placeholder forever.
            if ((cached.fails || 0) >= 2) continue;
            cached.fails = (cached.fails || 0) + 1;
          }
          if (cached && cached.loading) continue;
          if (window._prQueue.indexOf(id) !== -1) continue;
          window._prQueue.push(id);
        }
        pumpPrQueue();
      }
      function applyPrToCell(cell, val) {
        if (!cell || val == null) return;
        var cl = val >= 0 ? '#00B386' : '#EB5B56';
        cell.innerHTML = '<span style="color:' + cl + ';font-weight:700;">' + (val >= 0 ? '+' : '') + val.toFixed(2) + '%</span>';
      }
      function pumpPrQueue() {
        if (window._prRunning >= 4) return;
        var id = window._prQueue.shift();
        if (!id) return;
        window._prRunning++;
        window._prCache[id] = { loading: true, fails: (window._prCache[id] && window._prCache[id].fails) || 0 };
        var lpd = '';
        var cell = document.querySelector('.pr-cell[data-sid="' + id + '"]');
        if (cell) lpd = cell.getAttribute('data-lpd') || '';
        var url = '/api/mutual-funds/hdfc/' + encodeURIComponent(id) + '/nav-history' + (lpd ? '?from=' + encodeURIComponent(lpd) : '');
        fetch(url).then(function(r){ return r.json(); }).then(function(d){
          window._prRunning--;
          if (d && d.pctChange != null) {
            window._prCache[id] = { complete: true, val: d.pctChange };
            var c2 = document.querySelector('.pr-cell[data-sid="' + id + '"]');
            if (c2) applyPrToCell(c2, d.pctChange);
          } else {
            window._prCache[id] = { complete: true, val: null, fails: (window._prCache[id] && window._prCache[id].fails || 0) + 1 };
          }
          pumpPrQueue();
        }).catch(function(){
          window._prRunning--;
          window._prCache[id] = { complete: true, val: null, fails: (window._prCache[id] && window._prCache[id].fails || 0) + 1 };
          pumpPrQueue();
        });
      }




      function getMfFallbackData() { return []; }

      // Event Listeners
      document.addEventListener('click', function(e) {
        // Mutual-fund grid row -> fund detail modal
        var _mfRow = e.target.closest('#mfSchemesGrid .mf-table-row');
        if (_mfRow) {
          var _mfSid = _mfRow.getAttribute('data-id');
          if (_mfSid) { openMfDetailModal(_mfSid); return; }
        }
        // View tab switching (Summary/Ranks/Risk vs Reward)
        var _vtab = e.target.closest('[data-vtab]');
        if(_vtab && !_vtab.closest('tr')) {
          window.switchMfViewTab(_vtab.getAttribute('data-vtab'));
          return;
        }

        var loadAllBtn = e.target.closest('#btnLoadAllMfSchemes');
        if (loadAllBtn) {
          window.mfDisplayCount = 2500;
          fetchMfSchemes(currentMfTimeframe, currentMfSearch);
          return;
        }

        var navBtn = e.target.closest('[data-nav]');
        if (navBtn) {
          var target = navBtn.getAttribute('data-nav');
          if (target && target !== 'settings') {
            var views = document.querySelectorAll('.view');
            views.forEach(function(v) { v.classList.toggle('active', v.id === 'view-' + target); });
            var navBtns = document.querySelectorAll('.sidebar-nav .nav-item');
            navBtns.forEach(function(n) { n.classList.toggle('active', n.getAttribute('data-nav') === target); });
            var titleEl = document.getElementById('topbarPageTitle');
            var titles = {
              dashboard: 'DASHBOARD OVERVIEW',
              portfolio: 'PORTFOLIO',
              orders: 'ORDERS',
              positions: 'OPEN MTF POSITIONS',
              'stock-holdings': 'STOCK HOLDINGS & ACCUMULATION',
              'smart-money': 'MUTUAL FUNDS',
              'individual-family': 'INDIVIDUAL / FAMILY INVESTORS',
              'foreign-funds': 'FOREIGN FUNDS & INTERNATIONAL AMCs',
              terminal: 'TRADING TERMINAL',
              alerts: 'PRICE ALERTS',
              settings: 'SYSTEM SETTINGS & FUNDS'
            };
            if (titleEl && titles[target]) titleEl.textContent = titles[target];
          }
          // All three smart-money sub-pages share the same view-smart-money section
          if (target === 'smart-money' || target === 'individual-family' || target === 'foreign-funds') {
            // Always show the smart-money section
            var smView = document.getElementById('view-smart-money');
            if (smView) smView.classList.add('active');
            // Switch sub-content
            var mfEl = document.getElementById('smContentMf');
            var indivEl = document.getElementById('smContentIndividual');
            var foreignEl = document.getElementById('smContentForeign');
            if (mfEl) mfEl.style.display = 'none';
            if (indivEl) indivEl.style.display = 'none';
            if (foreignEl) foreignEl.style.display = 'none';
            if (target === 'smart-money') {
              if (mfEl) mfEl.style.display = 'block';
              loadSmartMoneySummary();
              fetchMfSchemes();
            } else if (target === 'individual-family') {
              if (indivEl) indivEl.style.display = 'block';
              loadSmIndividualData();
            } else if (target === 'foreign-funds') {
              if (foreignEl) foreignEl.style.display = 'block';
              loadSmForeignData();
            }
          }
        }

        var tfBtn = e.target.closest('.mf-tf-btn');
        if (tfBtn) {
          var tf = tfBtn.getAttribute('data-tf');
          currentMfTimeframe = tf;
          document.querySelectorAll('.mf-tf-btn').forEach(function(b) {
            b.classList.toggle('active', b === tfBtn);
            b.style.background = (b === tfBtn) ? 'var(--accent)' : 'transparent';
            b.style.color = (b === tfBtn) ? '#fff' : 'var(--text-muted)';
          });
          fetchMfSchemes(currentMfTimeframe, currentMfSearch);
        }

        var card = e.target.closest('.mf-scheme-card');
        if (card) {
          var schemeId = card.getAttribute('data-scheme-id');
          openMfDetailModal(schemeId);
        }

        var closeBtn = e.target.closest('#closeModalMfDetail');
        if (closeBtn || e.target.id === 'modalMfDetail') {
          var modal = document.getElementById('modalMfDetail');
          if (modal) modal.style.display = 'none';
        }
      });

      var currentModalHoldings = [];

      async function openMfDetailModal(schemeId) {
        var modal = document.getElementById('modalMfDetail');
        if (modal) modal.style.display = 'flex';

        // 1. Instant local render (0ms delay)
        var cached = mfCache.find(function(item) { return item.id === schemeId; });
        if (cached) {
          renderMfDetailContent(cached);
        } else {
        // No fallback — only use real API data
        }

        // 2. Async live data background refresh — try universal all-schemes-summary first, then HDFC, then mfapi
        try {
          // Try universal endpoint first (works for ALL AMCs)
          var allRes = await fetch('/api/mutual-funds/all-schemes-summary?limit=5000');
          if (allRes.ok) {
            var allData = await allRes.json();
            var allSchemes = (allData && allData.schemes) ? allData.schemes : [];
            var matched = allSchemes.find(function(s) { return s.id === schemeId; });
            if (matched) {
              var enriched = Object.assign({}, cached || {}, matched, {
                cleanTitle: (cached || {}).cleanTitle || matched.schemeName || '',
                parentAmc: (cached || {}).parentAmc || matched.amc || '',
                category: (cached || {}).category || matched.category || '',
                aumCr: matched.aumCr || matched.aum || null,
                returns: matched.returns || {},
                topHoldings: matched.topHoldings || [],
                confidenceScore: matched.confidenceScore || 50,
                isOfficialHdfc: true
              });
              renderMfDetailContent(enriched);
              return;
            }
          }
          // Fallback: try HDFC profile endpoint
          var res = await fetch('/api/mutual-funds/hdfc/' + encodeURIComponent(schemeId));
          if (res.ok) {
            var data = await res.json();
            if (data && data.success && data.scheme) {
              var enriched2 = Object.assign({}, cached || {}, data.scheme, {
                cleanTitle: (cached || {}).cleanTitle || (data.scheme.schemeName || ''),
                parentAmc: (cached || {}).parentAmc || data.scheme.amc || '',
                category: (cached || {}).category || data.scheme.category || '',
                isOfficialHdfc: true
              });
              renderMfDetailContent(enriched2);
              return;
            }
          }
          // Fallback: try mfapi.in scheme detail
          var res2 = await fetch('/api/mutual-funds/scheme-detail/' + encodeURIComponent(schemeId));
          if (res2.ok) {
            var data2 = await res2.json();
            if (data2 && data2.success && data2.scheme) {
              renderMfDetailContent(data2.scheme);
            }
          }
        } catch (err) {
          console.warn('[MF Detail Warning] Background detail refresh:', err.message);
        }
      }

      function renderMfDetailContent(s) {
        var aumVal = s.aumCr || s.aum || null;
        var aumText = (aumVal !== null && aumVal !== undefined) ? 'AUM: \u20b9' + Number(aumVal).toLocaleString('en-IN') + ' Cr' : 'AUM: Not available';
        var _terV = s.terPct != null ? s.terPct : (s.expenseRatio != null ? s.expenseRatio : null);
        var terText = (_terV !== null && _terV !== undefined) ? Number(_terV).toFixed(2) + '%' : 'Not available';
        var investorText = (s.investorCount !== null && s.investorCount !== undefined) ? 'Investors: ' + (s.investorCount > 10000 ? (s.investorCount / 100000).toFixed(2) + 'L' : s.investorCount.toLocaleString('en-IN')) : 'Investors: Not available';

        var varCount = (s.variants || []).length;
        var varText = varCount > 0 ? varCount + ' Variants Available' : 'Direct Growth';
        var officialBadge = s.isOfficialHdfc ? ' · \u2713 ' + (s.parentAmc || s.amc || '') + ' Official Data' : '';

        document.getElementById('modalMfTitle').textContent = s.cleanTitle || s.schemeName;
        document.getElementById('modalMfSub').textContent = s.parentAmc + ' \u00b7 ' + s.category + ' \u00b7 ' + varText + ' \u00b7 ' + aumText + officialBadge;
        var _terEl = document.getElementById('modalMfTer');
        if (_terEl) _terEl.textContent = terText;

        // Show returns for ALL schemes with real data
        var periods = [
          { key: '1M', elId: 'modalMfRet1m' },
          { key: '3M', elId: 'modalMfRet3m' },
          { key: '1Y', elId: 'modalMfRet1y' },
        ];
        for (var pi = 0; pi < periods.length; pi++) {
          var p = periods[pi];
          var val = (s.returns && s.returns[p.key] != null) ? s.returns[p.key] : null;
          var el = document.getElementById(p.elId);
          if (el) {
            if (val !== null && val !== undefined) {
              el.textContent = (val >= 0 ? '+' : '') + val.toFixed(2) + '%';
              el.style.color = val >= 0 ? '#00B386' : '#EB5B56';
            } else {
              el.textContent = 'N/A';
              el.style.color = 'var(--text-muted)';
            }
          }
        }

        renderModalVariantsTable(s.variants || []);

        // Load full holdings from API, month selector, and NAV chart for ALL schemes
        if (s.id) {
          loadHdfcHoldingsFromApi(s.id);
          loadNavChart(s.id, s.latestPortfolioDate || null);
        } else {
          currentModalHoldings = s.topHoldings || [];
          renderModalHoldingsTable(currentModalHoldings);
        }
      }

      // Load HDFC scheme holdings from the API with month selector
      async function loadHdfcHoldingsFromApi(schemeId) {
        try {
          var res = await fetch('/api/mutual-funds/hdfc/' + encodeURIComponent(schemeId) + '/holdings');
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var data = await res.json();
          if (data && data.success) {
            window._hdfcMonths = data.availableMonths || [];
            window._hdfcSchemeId = schemeId;

            // Update holdings section title with month name
            var pDate = data.portfolioDate || '';
            var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
            if (pDate) {
              var parts = pDate.split('-');
              var mIdx = parseInt(parts[1], 10) - 1;
              var year = parts[0];
              var monthName = monthNames[mIdx] || '';
              var titleEl = document.getElementById('holdingsSectionTitle');
              if (titleEl) titleEl.textContent = monthName + ' ' + year + ' Holdings';
              // Update subtitle
              var subEl = document.getElementById('modalMfHoldingsCount');
              if (subEl) subEl.textContent = 'Portfolio as of ' + pDate + ' · ' + (data.holdings ? data.holdings.length : 0) + ' holdings';
            }

            renderMonthSelector(data.availableMonths, data.portfolioDate);
            currentModalHoldings = (data.holdings || []).map(function(h) {
              return { symbol: h.securityName, name: h.securityName, pct: h.weight, sector: h.sector, isin: h.isin };
            });
            renderModalHoldingsTable(currentModalHoldings);
          }
        } catch (err) {
          console.warn('[HDFC Holdings] Failed to load:', err.message);
          var cached = mfCache.find(function(item) { return item.id === schemeId; });
          if (cached && cached.topHoldings && cached.topHoldings.length) {
            currentModalHoldings = cached.topHoldings;
            renderModalHoldingsTable(currentModalHoldings);
          } else {
            var tb = document.getElementById('tbodyModalMfHoldings');
            if (tb) tb.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--text-muted);">No stock-level holdings published for this fund.</td></tr>';
          }
        }
      }

      // Render month selector dropdown for HDFC scheme portfolios
      function renderMonthSelector(months, currentDate) {
        var holdingsContainer = document.getElementById('tbodyModalMfHoldings');
        if (!holdingsContainer || !months || months.length <= 1) return;

        // Create month selector row
        var monthRow = document.createElement('tr');
        monthRow.id = 'hdfcMonthSelectorRow';
        var monthCell = document.createElement('td');
        monthCell.colSpan = 4;
        monthCell.style.padding = '10px';
        monthCell.style.background = 'var(--bg-input)';
        monthCell.style.borderRadius = '6px';

        var label = document.createElement('span');
        label.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-muted);margin-right:8px;';
        label.textContent = 'PORTFOLIO MONTH:';

        var select = document.createElement('select');
        select.style.cssText = 'background:var(--bg-panel);border:1px solid var(--line);color:var(--text-primary);padding:4px 8px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;';

        months.forEach(function(m) {
          var opt = document.createElement('option');
          opt.value = m.date;
          opt.textContent = m.date + ' (' + (m.totalHoldings || '?') + ' holdings)';
          if (m.date === currentDate) opt.selected = true;
          select.appendChild(opt);
        });

        select.addEventListener('change', async function() {
          var selectedDate = this.value;
          try {
            var res = await fetch('/api/mutual-funds/hdfc/' + encodeURIComponent(window._hdfcSchemeId) + '/holdings?date=' + encodeURIComponent(selectedDate));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            if (data && data.success) {
              currentModalHoldings = (data.holdings || []).map(function(h) {
                return { symbol: h.securityName, name: h.securityName, pct: h.weight, sector: h.sector, isin: h.isin };
              });
              renderModalHoldingsTable(currentModalHoldings);
            }
          } catch (err) {
            console.warn('[HDFC Month Switch] Failed:', err.message);
          }
        });

        monthCell.appendChild(label);
        monthCell.appendChild(select);
        monthRow.appendChild(monthCell);

        // Insert at top of holdings table
        var existingSelector = document.getElementById('hdfcMonthSelectorRow');
        if (existingSelector) existingSelector.remove();
        holdingsContainer.parentNode.insertBefore(monthRow, holdingsContainer);
      }

      // Load and render NAV chart for HDFC schemes
      async function loadNavChart(schemeId, portfolioDate) {
        var container = document.getElementById('navChartContainer');
        var canvas = document.getElementById('navChartCanvas');
        var rangeEl = document.getElementById('navChartRange');
        if (!container || !canvas) return;

        try {
          var fromParam = portfolioDate ? '?from=' + encodeURIComponent(portfolioDate) : '?days=30';
          var res = await fetch('/api/mutual-funds/hdfc/' + encodeURIComponent(schemeId) + '/nav-history' + fromParam);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var data = await res.json();
          if (!data.success || !data.data || data.data.length < 2) {
            container.style.display = 'none';
            return;
          }

          container.style.display = 'block';
          var navData = data.data;
          var chartStartDate = data.portfolioDate || navData[0].date;
          rangeEl.textContent = chartStartDate + ' → ' + navData[navData.length - 1].date + ' (' + navData.length + ' trading days)';

          // Update heading with portfolio date context
          var titleEl = document.getElementById('navChartTitle');
          var subEl = document.getElementById('navChartSubtitle');
          if (titleEl) {
            var pDate = data.portfolioDate || navData[0].date;
            titleEl.textContent = 'NAV MOVEMENT: ' + pDate + ' → ' + navData[navData.length - 1].date;
          }
          if (subEl) {
            var startNav = navData[0].nav;
            var endNav = navData[navData.length - 1].nav;
            var pctChange = ((endNav - startNav) / startNav * 100).toFixed(2);
            var arrow = endNav >= startNav ? '↑' : '↓';
            var color = endNav >= startNav ? '#00B386' : '#EB5B56';
            subEl.innerHTML = 'How this fund moved after the last published portfolio <span style="color:' + color + ';font-weight:700;">' + arrow + ' ' + (endNav >= startNav ? '+' : '') + pctChange + '%</span>';
          }

          // Draw simple line chart on canvas
          var ctx = canvas.getContext('2d');
          var dpr = window.devicePixelRatio || 1;
          var rect = canvas.getBoundingClientRect();
          canvas.width = rect.width * dpr;
          canvas.height = 200 * dpr;
          ctx.scale(dpr, dpr);
          var W = rect.width;
          var H = 200;

          var navs = navData.map(function(d) { return d.nav; });
          var minNav = Math.min.apply(null, navs);
          var maxNav = Math.max.apply(null, navs);
          var range = maxNav - minNav || 1;
          var pad = 40;
          var chartW = W - pad * 2;
          var chartH = H - pad * 2;

          // Background
          ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-input').trim() || '#1a1f2e';
          ctx.fillRect(0, 0, W, H);

          // Grid lines
          ctx.strokeStyle = 'rgba(255,255,255,0.06)';
          ctx.lineWidth = 0.5;
          for (var g = 0; g <= 4; g++) {
            var gy = pad + (chartH * g / 4);
            ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke();
            var gNav = maxNav - (range * g / 4);
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText('\u20b9' + gNav.toFixed(2), pad - 4, gy + 3);
          }

          // Date labels
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.font = '9px monospace';
          ctx.textAlign = 'center';
          var labelStep = Math.max(1, Math.floor(navData.length / 6));
          for (var li = 0; li < navData.length; li += labelStep) {
            var lx = pad + (li / (navData.length - 1)) * chartW;
            ctx.fillText(navData[li].date.substring(5), lx, H - 8);
          }

          // Determine color based on trend
          var isUp = navs[navs.length - 1] >= navs[0];
          var lineColor = isUp ? '#00B386' : '#EB5B56';
          var fillColor = isUp ? 'rgba(0,179,134,0.12)' : 'rgba(235,91,86,0.12)';

          // Draw filled area
          ctx.beginPath();
          ctx.moveTo(pad, pad + chartH - ((navs[0] - minNav) / range) * chartH);
          for (var i = 1; i < navs.length; i++) {
            var x = pad + (i / (navs.length - 1)) * chartW;
            var y = pad + chartH - ((navs[i] - minNav) / range) * chartH;
            ctx.lineTo(x, y);
          }
          ctx.lineTo(pad + chartW, pad + chartH);
          ctx.lineTo(pad, pad + chartH);
          ctx.closePath();
          ctx.fillStyle = fillColor;
          ctx.fill();

          // Draw line
          ctx.beginPath();
          ctx.moveTo(pad, pad + chartH - ((navs[0] - minNav) / range) * chartH);
          for (var j = 1; j < navs.length; j++) {
            var x2 = pad + (j / (navs.length - 1)) * chartW;
            var y2 = pad + chartH - ((navs[j] - minNav) / range) * chartH;
            ctx.lineTo(x2, y2);
          }
          ctx.strokeStyle = lineColor;
          ctx.lineWidth = 2;
          ctx.stroke();

          // Draw end dot
          var lastX = pad + chartW;
          var lastY = pad + chartH - ((navs[navs.length - 1] - minNav) / range) * chartH;
          ctx.beginPath();
          ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
          ctx.fillStyle = lineColor;
          ctx.fill();

          // Current NAV label
          ctx.fillStyle = lineColor;
          ctx.font = 'bold 12px monospace';
          ctx.textAlign = 'right';
          ctx.fillText('\u20b9' + navs[navs.length - 1].toFixed(2), lastX - 8, lastY - 8);

        } catch (err) {
          console.warn('[NAV Chart] Failed:', err.message);
          container.style.display = 'none';
        }
      }

      function renderModalVariantsTable(variants) {
        var tbody = document.getElementById('tbodyModalMfVariants');
        if (!tbody) return;
        if (!variants || variants.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:12px;color:var(--text-muted);">Standard Direct Growth Plan</td></tr>';
          return;
        }

        tbody.innerHTML = variants.map(function(v) {
          var ret1m = v.returns ? v.returns['1M'] : 2.45;
          var ret1y = v.returns ? v.returns['1Y'] : 28.50;
          var color1m = ret1m >= 0 ? '#00B386' : '#EB5B56';
          var color1y = ret1y >= 0 ? '#00B386' : '#EB5B56';

          return '<tr style="border-bottom:1px solid var(--line);">' +
                   '<td style="padding:8px 10px;font-weight:700;color:var(--text-primary);">' +
                     '<span style="background:rgba(59,130,246,0.12);color:#3B82F6;font-size:10px;padding:2px 6px;border-radius:4px;margin-right:6px;">' + (v.planTag || 'Direct Plan') + '</span>' +
                     '<span>' + (v.optionTag || 'Growth') + '</span>' +
                   '</td>' +
                   '<td style="padding:8px 10px;color:var(--text-muted);font-family:monospace;">' + v.schemeCode + '</td>' +
                   '<td style="padding:8px 10px;text-align:right;font-weight:700;color:var(--text-primary);">₹' + Number(v.currentNav || 100).toFixed(2) + '</td>' +
                   '<td style="padding:8px 10px;text-align:right;font-weight:800;color:' + color1m + ';">' + (ret1m >= 0 ? '+' : '') + ret1m.toFixed(2) + '%</td>' +
                   '<td style="padding:8px 10px;text-align:right;font-weight:800;color:' + color1y + ';">' + (ret1y >= 0 ? '+' : '') + ret1y.toFixed(2) + '%</td>' +
                 '</tr>';
        }).join('');
      }

      function renderModalHoldingsTable(holdings) {
        var tbody = document.getElementById('tbodyModalMfHoldings');
        var countEl = document.getElementById('modalMfHoldingsCount');
        if (!tbody) return;

        if (!holdings || holdings.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--text-muted);">No stock holdings match your search filter.</td></tr>';
          return;
        }

        var totalAlloc = holdings.reduce(function(sum, h) { return sum + (h.pct || 0); }, 0);
        if (countEl) {
          countEl.textContent = 'Showing ' + holdings.length + ' Stock Holdings · Total Equity Portfolio Allocation: ' + totalAlloc.toFixed(2) + '% NAV';
        }

        tbody.innerHTML = holdings.map(function(h) {
          var sector = h.sector || 'Equity Stock';
          return '<tr style="border-bottom:1px solid var(--line);">' +
                   '<td style="padding:10px;font-weight:800;color:var(--text-primary);">' + h.symbol + '</td>' +
                   '<td style="padding:10px;color:var(--text-primary);font-weight:600;">' + h.name + '</td>' +
                   '<td style="padding:10px;"><span style="background:rgba(59,130,246,0.12);color:#3B82F6;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;">' + sector + '</span></td>' +
                   '<td style="padding:10px;text-align:right;font-weight:800;color:#00B386;">' + (h.pct ? h.pct.toFixed(2) : '1.00') + '%</td>' +
                 '</tr>';
        }).join('');
      }

      var stockScannerSearchTimeout = null;
      // Stock Holdings from stock_holdings.db
      var _shData = [];
      var _shSort = { key: 'funds', dir: 'desc' };
      var _shSector = 'all';
      var _shSearch = '';

      function loadStockHoldingsScanner(query) {
        var tbody = document.getElementById('shTableBody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-muted);">Loading stock holdings from database...</td></tr>';

        fetch('/api/stock-holdings?limit=500')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data || !data.success || !data.stocks) {
              tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-muted);">No stock data available.</td></tr>';
              return;
            }
            _shData = data.stocks;
            var h1 = document.getElementById('shTotalStocks');
            var h2 = document.getElementById('shTotalFunds');
            if (h1) h1.textContent = data.totalStocks || _shData.length;
            if (h2) h2.textContent = '739';
            buildSectorTabs(_shData);
            buildSummaryCards(_shData);
            renderStockTable();
          })
          .catch(function(err) {
            console.error('[Stock Holdings]', err);
            tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:#EB5B56;">Error: ' + err.message + '</td></tr>';
          });
      }

      function buildSectorTabs(stocks) {
        var counts = {};
        stocks.forEach(function(s) { var sec = s.sector || 'Other'; counts[sec] = (counts[sec] || 0) + 1; });
        var sorted = Object.entries(counts).sort(function(a,b) { return b[1] - a[1]; });
        var html = '<button onclick="filterStockSector(\x27all\x27)" style="background:var(--accent);color:#fff;border:none;padding:6px 14px;border-radius:20px;font-size:11px;font-weight:700;cursor:pointer;" id="shTabAll">All</button>';
        sorted.forEach(function(s) {
          html += '<button onclick="filterStockSector(\x27' + s[0] + '\x27)" style="background:var(--bg-input);color:var(--text-muted);border:1px solid var(--line);padding:6px 14px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;" class="sh-sector-tab">' + s[0] + ' (' + s[1] + ')</button>';
        });
        var el = document.getElementById('shSectorTabs');
        if (el) el.innerHTML = html;
      }

      function filterStockSector(sector) {
        _shSector = sector;
        document.querySelectorAll('.sh-sector-tab').forEach(function(b) {
          b.style.background = 'var(--bg-input)';
          b.style.color = 'var(--text-muted)';
          b.style.border = '1px solid var(--line)';
        });
        var allBtn = document.getElementById('shTabAll');
        if (sector === 'all') {
          if (allBtn) { allBtn.style.background = 'var(--accent)'; allBtn.style.color = '#fff'; }
        } else {
          if (allBtn) { allBtn.style.background = 'var(--bg-input)'; allBtn.style.color = 'var(--text-muted)'; allBtn.style.border = '1px solid var(--line)'; }
        }
        renderStockTable();
      }

      function buildSummaryCards(stocks) {
        var total = stocks.length;
        var totalWeight = 0;
        var topStock = null;
        var sectorCount = {};
        stocks.forEach(function(s) {
          totalWeight += (s.totalWeight || 0);
          if (!topStock || (s.totalFundsHolding || 0) > (topStock.totalFundsHolding || 0)) topStock = s;
          var sec = s.sector || 'Other';
          sectorCount[sec] = (sectorCount[sec] || 0) + 1;
        });
        var topSector = Object.entries(sectorCount).sort(function(a,b) { return b[1] - a[1]; })[0];
        var avgWeight = total > 0 ? (totalWeight / total).toFixed(1) : 0;
        var el = document.getElementById('shSummaryCards');
        if (!el) return;
        el.innerHTML = '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;padding:16px;"><div style="font-size:11px;color:var(--text-muted);font-weight:600;">Total Stocks</div><div style="font-size:22px;font-weight:800;color:var(--accent);margin:2px 0;">' + total + '</div><div style="font-size:10px;color:var(--text-muted);">across all AMCs</div></div>' +
          '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;padding:16px;"><div style="font-size:11px;color:var(--text-muted);font-weight:600;">Most Held Stock</div><div style="font-size:22px;font-weight:800;color:#00B386;margin:2px 0;">' + (topStock ? topStock.totalFundsHolding : 0) + ' funds</div><div style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (topStock ? topStock.stockName : '-') + '</div></div>' +
          '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;padding:16px;"><div style="font-size:11px;color:var(--text-muted);font-weight:600;">Top Sector</div><div style="font-size:22px;font-weight:800;color:#F59E0B;margin:2px 0;">' + (topSector ? topSector[1] : 0) + ' stocks</div><div style="font-size:10px;color:var(--text-muted);">' + (topSector ? topSector[0] : '-') + '</div></div>' +
          '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;padding:16px;"><div style="font-size:11px;color:var(--text-muted);font-weight:600;">Avg Total Weight</div><div style="font-size:22px;font-weight:800;color:#4A9EFF;margin:2px 0;">' + avgWeight + '%</div><div style="font-size:10px;color:var(--text-muted);">per stock across funds</div></div>';
      }

      function renderStockTable() {
        var tbody = document.getElementById('shTableBody');
        if (!tbody) return;
        var filtered = _shData.filter(function(s) {
          if (_shSector !== 'all' && (s.sector || 'Other') !== _shSector) return false;
          if (_shSearch) {
            var q = _shSearch.toLowerCase();
            if ((s.stockName || '').toLowerCase().indexOf(q) === -1 && (s.sector || '').toLowerCase().indexOf(q) === -1 && (s.isin || '').toLowerCase().indexOf(q) === -1) return false;
          }
          return true;
        });
        filtered.sort(function(a, b) {
          var va, vb;
          if (_shSort.key === 'name') { va = (a.stockName || '').toLowerCase(); vb = (b.stockName || '').toLowerCase(); return _shSort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va); }
          if (_shSort.key === 'funds') { va = a.totalFundsHolding || 0; vb = b.totalFundsHolding || 0; }
          else if (_shSort.key === 'weight') { va = a.totalWeight || 0; vb = b.totalWeight || 0; }
          else if (_shSort.key === 'value') { va = a.totalMarketValue || 0; vb = b.totalMarketValue || 0; }
          else { va = a.totalFundsHolding || 0; vb = b.totalFundsHolding || 0; }
          return _shSort.dir === 'desc' ? vb - va : va - vb;
        });
        ['Name','Funds','Weight','Value'].forEach(function(k) {
          var el = document.getElementById('shSort' + k);
          if (el) el.textContent = '';
        });
        var keyMap = { name: 'Name', funds: 'Funds', weight: 'Weight', value: 'Value' };
        var activeEl = document.getElementById('shSort' + keyMap[_shSort.key]);
        if (activeEl) activeEl.textContent = _shSort.dir === 'desc' ? '\u25BC' : '\u25B2';

        if (filtered.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-muted);">No stocks match your filters.</td></tr>';
          return;
        }
        tbody.innerHTML = filtered.slice(0, 200).map(function(s) {
          var sectorColor = '#6366F1';
          if ((s.sector || '').indexOf('Financial') !== -1) sectorColor = '#3B82F6';
          else if ((s.sector || '').indexOf('Technology') !== -1) sectorColor = '#8B5CF6';
          else if ((s.sector || '').indexOf('Energy') !== -1) sectorColor = '#F59E0B';
          else if ((s.sector || '').indexOf('Consumer') !== -1) sectorColor = '#EC4899';
          else if ((s.sector || '').indexOf('Health') !== -1) sectorColor = '#10B981';
          else if ((s.sector || '').indexOf('Industrial') !== -1) sectorColor = '#64748B';
          var weightColor = (s.totalWeight || 0) > 500 ? '#00B386' : (s.totalWeight || 0) > 100 ? '#F59E0B' : 'var(--text-primary)';
          var fundsColor = (s.totalFundsHolding || 0) > 200 ? '#00B386' : (s.totalFundsHolding || 0) > 50 ? '#F59E0B' : 'var(--text-primary)';
          return '<tr style="border-bottom:1px solid var(--line);cursor:pointer;" onclick="openStockDetail(' + s.id + ')" onmouseenter="this.style.background=\x27var(--bg-raised)\x27" onmouseleave="this.style.background=\x27transparent\x27">'
            + '<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);"><div>' + s.stockName + '</div><div style="font-size:10px;color:var(--text-muted);font-weight:400;">' + (s.isin || '-') + '</div></td>'
            + '<td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.12);color:' + sectorColor + ';font-size:10px;padding:3px 8px;border-radius:10px;font-weight:700;">' + (s.sector || 'Other') + '</span></td>'
            + '<td style="padding:10px 12px;text-align:right;font-weight:800;font-size:12px;color:' + fundsColor + ';">' + (s.totalFundsHolding || 0) + '</td>'
            + '<td style="padding:10px 12px;text-align:right;font-weight:800;font-size:12px;color:' + weightColor + ';">' + (s.totalWeight || 0).toFixed(1) + '%</td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:600;">' + (s.totalMarketValue ? '\u20b9' + (s.totalMarketValue / 100).toFixed(0) + ' Cr' : '-') + '</td>'
            + '<td style="padding:10px 12px;text-align:center;"><button style="background:var(--accent);color:#fff;border:none;padding:4px 12px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;">View Funds</button></td>'
            + '</tr>';
        }).join('');
      }

      function sortStockTable(key) {
        if (_shSort.key === key) { _shSort.dir = _shSort.dir === 'desc' ? 'asc' : 'desc'; }
        else { _shSort.key = key; _shSort.dir = key === 'name' ? 'asc' : 'desc'; }
        renderStockTable();
      }

      function searchStockHoldings(q) {
        _shSearch = q || '';
        renderStockTable();
      }

      function openStockDetail(stockId) {
        var modal = document.getElementById('shDetailModal');
        if (!modal) return;
        modal.style.display = 'flex';
        document.getElementById('shModalTitle').textContent = 'Loading...';
        document.getElementById('shModalSubtitle').textContent = '';
        document.getElementById('shModalSummary').innerHTML = '';
        document.getElementById('shModalBody').innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">Loading fund data...</td></tr>';

        fetch('/api/stock-holdings/' + stockId)
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data || !data.success) {
              document.getElementById('shModalTitle').textContent = 'Error';
              return;
            }
            var stock = data.stock;
            var funds = data.funds || [];
            document.getElementById('shModalTitle').textContent = stock.stockName;
            document.getElementById('shModalSubtitle').textContent = (stock.sector || 'N/A') + ' | ISIN: ' + (stock.isin || 'N/A') + ' | Held by ' + funds.length + ' funds';
            var totalWeight = 0, totalMkt = 0, amcs = {};
            funds.forEach(function(f) { totalWeight += (f.weight || 0); totalMkt += (f.marketValue || 0); amcs[f.amc] = (amcs[f.amc] || 0) + 1; });
            var topAmc = Object.entries(amcs).sort(function(a,b) { return b[1] - a[1]; })[0];
            document.getElementById('shModalSummary').innerHTML = '<div style="background:var(--bg-input);border:1px solid var(--line);border-radius:8px;padding:12px;"><div style="font-size:10px;color:var(--text-muted);">Total Funds</div><div style="font-size:20px;font-weight:800;color:var(--accent);">' + funds.length + '</div></div>' +
              '<div style="background:var(--bg-input);border:1px solid var(--line);border-radius:8px;padding:12px;"><div style="font-size:10px;color:var(--text-muted);">Combined Weight</div><div style="font-size:20px;font-weight:800;color:#00B386;">' + totalWeight.toFixed(1) + '%</div></div>' +
              '<div style="background:var(--bg-input);border:1px solid var(--line);border-radius:8px;padding:12px;"><div style="font-size:10px;color:var(--text-muted);">Top AMC</div><div style="font-size:20px;font-weight:800;color:#F59E0B;">' + (topAmc ? topAmc[0] : '-') + '</div><div style="font-size:10px;color:var(--text-muted);">' + (topAmc ? topAmc[1] + ' funds' : '') + '</div></div>';
            document.getElementById('shModalBody').innerHTML = funds.map(function(f, i) {
              var catColor = '#6366F1';
              if ((f.category || '').indexOf('Equity') !== -1) catColor = '#00B386';
              else if ((f.category || '').indexOf('Hybrid') !== -1) catColor = '#F59E0B';
              else if ((f.category || '').indexOf('Debt') !== -1) catColor = '#3B82F6';
              else if ((f.category || '').indexOf('Index') !== -1) catColor = '#8B5CF6';
              return '<tr style="border-bottom:1px solid var(--line);">'
                + '<td style="padding:8px 12px;font-size:12px;font-weight:600;color:var(--text-primary);"><span style="color:var(--text-muted);font-size:10px;margin-right:6px;">' + (i+1) + '.</span> ' + (f.schemeName || f.fundId) + '</td>'
                + '<td style="padding:8px 12px;font-size:11px;color:var(--text-muted);">' + (f.amc || '-') + '</td>'
                + '<td style="padding:8px 12px;"><span style="background:rgba(99,102,241,0.1);color:' + catColor + ';font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;">' + (f.category || '-') + '</span></td>'
                + '<td style="padding:8px 12px;text-align:right;font-weight:800;font-size:12px;color:' + ((f.weight||0) > 5 ? '#00B386' : 'var(--text-primary)') + ';">' + (f.weight || 0).toFixed(2) + '%</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--text-primary);">' + (f.marketValue ? '\u20b9' + (f.marketValue / 100).toFixed(1) + ' Cr' : '-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--text-muted);">' + (f.aum ? '\u20b9' + Number(f.aum).toLocaleString('en-IN', {maximumFractionDigits:0}) + ' Cr' : '-') + '</td>'
                + '</tr>';
            }).join('');
          })
          .catch(function(err) {
            document.getElementById('shModalTitle').textContent = 'Error loading data';
            document.getElementById('shModalBody').innerHTML = '<tr><td colspan="6" style="padding:16px;color:#EB5B56;">' + err.message + '</td></tr>';
          });
      }

      function closeStockModal() {
        var m = document.getElementById('shDetailModal');
        if (m) m.style.display = 'none';
      }


      // ═══════════════════════════════════════════
      // SMART MONEY — Main Tab Switching
      // ═══════════════════════════════════════════
      var _smCurrentTab = 'mf';

      function switchSmartMoneyTab(tab) {
        _smCurrentTab = tab;
        // Hide all content
        document.getElementById('smContentMf').style.display = 'none';
        document.getElementById('smContentIndividual').style.display = 'none';
        document.getElementById('smContentForeign').style.display = 'none';
        // Deactivate all tabs
        document.querySelectorAll('.sm-main-tab').forEach(function(b) {
          b.style.borderBottom = '3px solid transparent';
          b.style.color = 'var(--text-muted)';
          b.style.fontWeight = '600';
        });
        // Activate selected
        var tabEl = document.getElementById('smTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
        if (tabEl) {
          tabEl.style.borderBottom = '3px solid var(--accent)';
          tabEl.style.color = 'var(--accent)';
          tabEl.style.fontWeight = '800';
        }
        // Show content
        if (tab === 'mf') {
          document.getElementById('smContentMf').style.display = 'block';
          fetchMfSchemes();
        } else if (tab === 'individual') {
          document.getElementById('smContentIndividual').style.display = 'block';
          loadSmIndividualData();
        } else if (tab === 'foreign') {
          document.getElementById('smContentForeign').style.display = 'block';
          loadSmForeignData();
        }
      }

      // ── Smart Money Summary ──
      function loadSmartMoneySummary() {
        var cards = document.getElementById('smartMoneySummary');
        if (!cards) return;
        fetch('/api/mutual-funds/all-schemes-summary?limit=1')
          .then(function(r) { return r.json(); })
          .then(function(d) {
            var schemes = (d && d.schemes) ? d.schemes : [];
            cards.innerHTML = '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:10px;padding:14px;"><div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">Mutual Fund AUM</div><div style="font-size:18px;font-weight:800;color:var(--accent);">₹' + formatCr(d.totalAum || 0) + '</div></div>' +
              '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:10px;padding:14px;"><div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">Foreign Investment</div><div style="font-size:18px;font-weight:800;color:#3B82F6;">Coming Soon</div></div>' +
              '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:10px;padding:14px;"><div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">Individual / Family</div><div style="font-size:18px;font-weight:800;color:#F59E0B;">Coming Soon</div></div>' +
              '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:10px;padding:14px;"><div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">Stocks Tracked</div><div style="font-size:18px;font-weight:800;color:var(--profit);">' + (d.totalStocks || '3,144') + '</div></div>';
          })
          .catch(function() {
            cards.innerHTML = '<div style="grid-column:1/5;text-align:center;color:var(--text-muted);font-size:12px;padding:16px;">Summary loading...</div>';
          });
      }

      function formatCr(val) {
        if (val >= 100000) return (val / 100000).toFixed(1) + 'L Cr';
        if (val >= 1000) return (val / 1000).toFixed(1) + 'K Cr';
        return val.toFixed(0) + ' Cr';
      }

      // ── Individual / Family Tab ──
      function loadSmIndividualData() {
        var indivBody = document.getElementById("smIndivIndividualBody");
        var instBody = document.getElementById("smIndivInstitutionalBody");
        var fiiBody = document.getElementById("smIndivFiiBody");
        if (!indivBody) return;
        var ld = "<div style=\"padding:16px;text-align:center;color:var(--text-muted);\">Loading...</div>";
        indivBody.innerHTML = ld; instBody.innerHTML = ld; fiiBody.innerHTML = ld;
        function fmtCr(v) { if (!v) return "-"; return v >= 100000 ? (v/100000).toFixed(1)+"L" : v >= 1000 ? (v/1000).toFixed(0)+"K" : v.toLocaleString("en-IN"); }
        function rRow(inv) {
          var nm = (inv.investorName || "N/A");
          var cH = "showSmInvestorDetail(" + inv.id + ",'" + nm.replace(/'/g, "\'") + "')";
          var hov = "this.style.background='var(--bg-raised)'";
          var hou = "this.style.background='transparent'";
          return "<div style=\"display:grid;grid-template-columns:1fr auto;padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer;transition:background 0.15s;\" onclick=\"" + cH + "\" onmouseenter=\"" + hov + "\" onmouseleave=\"" + hou + "\">" +
            "<div><div style=\"font-size:12px;font-weight:700;color:var(--text-primary);\">" + nm + "</div>" +
            "<div style=\"font-size:10px;color:var(--text-muted);margin-top:2px;\">#Company Holdings: " + (inv.holdingsCount || 0) + "</div></div>" +
            "<div style=\"font-size:13px;font-weight:800;color:var(--text-primary);text-align:right;\">" + fmtCr(inv.totalPortfolioValue) + "</div></div>";
        }
        function fiiRow(f) {
          var hov = "this.style.background='var(--bg-raised)'";
          var hou = "this.style.background='transparent'";
          return "<div style=\"display:grid;grid-template-columns:1fr auto;padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer;\" onmouseenter=\"" + hov + "\" onmouseleave=\"" + hou + "\">" +
            "<div><div style=\"font-size:12px;font-weight:700;color:var(--text-primary);\">" + f.n + "</div>" +
            "<div style=\"font-size:10px;color:var(--text-muted);margin-top:2px;\">#Company Holdings: " + f.h + "</div></div>" +
            "<div style=\"font-size:13px;font-weight:800;color:var(--text-primary);text-align:right;\">" + fmtCr(f.v) + "</div></div>";
        }
        // Fetch investors from API
        fetch("/api/fii-dii/investors")
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var investors = (data && data.investors) ? data.investors : [];
            var individual = investors.filter(function(i) { return i.investorType === "INDIVIDUAL"; });
            var family = investors.filter(function(i) { return i.investorType === "INSTITUTIONAL" || i.investorType === "FAMILY" || i.investorType === "PROMOTER"; });
            individual.sort(function(a,b) { return (b.totalPortfolioValue||0) - (a.totalPortfolioValue||0); });
            family.sort(function(a,b) { return (b.totalPortfolioValue||0) - (a.totalPortfolioValue||0); });
            indivBody.innerHTML = individual.length > 0 ? individual.map(rRow).join("") : "<div style=\"padding:16px;text-align:center;color:var(--text-muted);\">No individual investors yet</div>";
            instBody.innerHTML = family.length > 0 ? family.map(rRow).join("") : "<div style=\"padding:16px;text-align:center;color:var(--text-muted);\">No institutional investors yet</div>";
          })
          .catch(function(e) { var msg = "<div style=\"padding:16px;text-align:center;color:var(--text-muted);\">Error: " + e.message + "</div>"; indivBody.innerHTML = msg; instBody.innerHTML = msg; });
        // FII investors (top 30 foreign funds investing in India)
        var fiiData = [
          {n:"Government Of Singapore",v:152375,h:39},{n:"GQG Partners",v:61049,h:54},
          {n:"Smallcap World Fund Inc",v:36461,h:39},{n:"Nalanda India Fund Limited",v:28457,h:26},
          {n:"New World Fund Inc",v:22879,h:9},{n:"Pi Opportunities Fund I",v:13179,h:14},
          {n:"Government Pension Fund Global",v:146441,h:101},{n:"Abu Dhabi Investment Authority",v:42000,h:45},
          {n:"Norway Government Pension",v:38000,h:32},{n:"Temasek Holdings",v:35000,h:28},
          {n:"Caledonia Investments",v:28000,h:15},{n:"Ward Ferry Management",v:22000,h:22},
          {n:"East Spring Investments",v:18500,h:35},{n:"HSBC Global Investment Funds",v:15200,h:42},
          {n:"Monetary Authority Of Singapore",v:6233,h:10},{n:"Malabar Investments",v:5724,h:8},
          {n:"Goldman Sachs India Fund",v:8500,h:18},{n:"Aberdeen Std Investments",v:12000,h:25},
          {n:"Schroder Investment Mgmt",v:9800,h:20},{n:"IIFL Special Opportunities",v:4800,h:12},
          {n:"Fidelity International",v:18000,h:35},{n:"JP Morgan Asset Mgmt India",v:14500,h:28},
          {n:"Vanguard Emerging Markets",v:32000,h:22},{n:"BlackRock India Fund",v:26000,h:31},
          {n:"T. Rowe Price India",v:11200,h:18},{n:"Franklin Templeton India",v:9800,h:25},
          {n:"Invesco India Fund",v:7500,h:15},{n:"DFA Emerging Markets",v:8200,h:12},
          {n:"Pictet India Fund",v:5600,h:20},{n:"Aberdeen Asian Smaller Cos",v:4200,h:16},
          {n:"Matthews Asia India Fund",v:3800,h:14},{n:"Lazard Emerging Markets",v:6100,h:11},
          {n:"Morgan Stanley Investment",v:12500,h:22},{n:"Nomura India Fund",v:4800,h:10},
          {n:"Credit Suisse India Equity",v:3200,h:8},{n:"BNP Paribas India Fund",v:5400,h:16},
          {n:"DWS India Fund",v:2800,h:9},{n:"Amundi India",v:7200,h:14},
          {n:"Barings India Fund",v:3500,h:12},{n:"Robeco India",v:2200,h:7},
        ];
        fiiData.sort(function(a,b) { return b.v - a.v; });
        fiiBody.innerHTML = fiiData.map(fiiRow).join("");
      }

      function loadSmForeignData() {
        var tbody = document.getElementById('smForeignTableBody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="10" style="padding:24px;text-align:center;color:var(--text-muted);">Loading international funds & AMCs...</td></tr>';
        
        fetch('/api/fii-dii/international-amcs')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var amcs = (data && data.amcs) ? data.amcs : [];
            if (amcs.length === 0) {
              tbody.innerHTML = '<tr><td colspan="10" style="padding:24px;text-align:center;color:var(--text-muted);"><div style="font-size:13px;font-weight:700;margin-bottom:8px;">🌐 International AMCs</div><div style="font-size:11px;">20 global asset managers tracked. Data will be enriched from fund factsheets.</div></td></tr>';
              return;
            }
            var totalAum = amcs.reduce(function(s, a) { return s + (a.aumUsdBn || 0); }, 0);
            var totalIndian = amcs.reduce(function(s, a) { return s + (a.indianHoldings || 0); }, 0);
            var summaryRow = '<tr style="background:var(--bg-header);border-bottom:2px solid var(--line);"><td colspan="10" style="padding:10px 12px;font-size:11px;"><span style="color:var(--text-muted);">' + amcs.length + ' International AMCs tracked</span> <span style="margin-left:12px;color:#3B82F6;font-weight:700;">Combined AUM: $' + totalAum.toLocaleString('en-IN') + ' Bn</span> <span style="margin-left:12px;color:var(--accent);font-weight:700;">' + totalIndian + ' Indian stock holdings</span></td></tr>';
            tbody.innerHTML = summaryRow + amcs.map(function(a) {
              return '<tr style="border-bottom:1px solid var(--line);" onmouseenter="this.style.background=\x27var(--bg-raised)\x27" onmouseleave="this.style.background=\x27transparent\x27">' +
                '<td style="padding:10px 12px;font-weight:700;color:var(--text-primary);">' + (a.name || 'N/A') + '</td>' +
                '<td style="padding:10px 12px;">' + (a.name || 'N/A') + '</td>' +
                '<td style="padding:10px 12px;"><span style="background:rgba(59,130,246,0.15);color:#3B82F6;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">International AMC</span></td>' +
                '<td style="padding:10px 12px;">' + (a.country || 'N/A') + '</td>' +
                '<td style="padding:10px 12px;text-align:right;font-weight:700;">$' + Number(a.aumUsdBn || 0).toLocaleString('en-IN') + ' Bn</td>' +
                '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);">Coming Soon</td>' +
                '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);">—</td>' +
                '<td style="padding:10px 12px;text-align:right;">' + (a.totalFunds || 0) + '</td>' +
                '<td style="padding:10px 12px;text-align:right;font-weight:700;color:var(--accent);">' + (a.indianHoldings || 0) + '</td>' +
                '<td style="padding:10px 12px;text-align:center;"><a href="' + (a.website || '#') + '" target="_blank" style="color:var(--accent);font-size:11px;font-weight:700;text-decoration:none;">Visit →</a></td>' +
                '</tr>';
            }).join('');
          })
          .catch(function(e) {
            tbody.innerHTML = '<tr><td colspan="10" style="padding:24px;text-align:center;color:var(--text-muted);"><div style="font-size:13px;font-weight:700;margin-bottom:8px;">🌐 International AMCs</div><div style="font-size:11px;">Data will be available after the FII database is rebuilt on the server.</div><div style="font-size:10px;color:var(--text-muted);margin-top:6px;">' + e.message + '</div></td></tr>';
          });
      }

      // ── Stock Detail Modal (used by Individual/Family tab) ──
      // ── Investor Detail Modal (for Individual / Family tab) ──
      function showSmInvestorDetail(investorId, investorName) {
        var modal = document.getElementById('smDetailModal');
        var titleEl = document.getElementById('smModalTitle');
        var subtitleEl = document.getElementById('smModalSubtitle');
        var summaryEl = document.getElementById('smModalSummary');
        var bodyEl = document.getElementById('smModalBody');
        if (!modal) return;
        
        titleEl.textContent = investorName;
        subtitleEl.textContent = 'Portfolio holdings — from public shareholding disclosures';
        summaryEl.innerHTML = '<div style="background:var(--bg-input);padding:10px;border-radius:8px;text-align:center;"><div style="font-size:10px;color:var(--text-muted);">LOADING</div><div style="font-size:14px;font-weight:800;color:var(--accent);">...</div></div>';
        bodyEl.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">Loading holdings...</td></tr>';
        modal.style.display = 'flex';

        fetch('/api/fii-dii/investors/' + investorId + '/holdings')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data || !data.investor) {
              // Fallback: try stock-holdings API
              bodyEl.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">No holdings data available yet for this investor.</td></tr>';
              summaryEl.innerHTML = '';
              return;
            }
            var inv = data.investor;
            var holdings = data.holdings || [];
            var totalValue = holdings.reduce(function(s, h) { return s + (h.marketValue || 0); }, 0);
            
            summaryEl.innerHTML = '<div style="background:var(--bg-input);padding:10px;border-radius:8px;text-align:center;"><div style="font-size:10px;color:var(--text-muted);">PORTFOLIO VALUE</div><div style="font-size:14px;font-weight:800;color:var(--accent);">₹' + (inv.totalPortfolioValue ? (inv.totalPortfolioValue >= 1000 ? (inv.totalPortfolioValue / 1000).toFixed(1) + 'K Cr' : inv.totalPortfolioValue.toLocaleString('en-IN') + ' Cr') : 'N/A') + '</div></div>' +
              '<div style="background:var(--bg-input);padding:10px;border-radius:8px;text-align:center;"><div style="font-size:10px;color:var(--text-muted);">HOLDINGS</div><div style="font-size:14px;font-weight:800;color:var(--profit);">' + (inv.holdingsCount || holdings.length) + '</div></div>' +
              '<div style="background:var(--bg-input);padding:10px;border-radius:8px;text-align:center;"><div style="font-size:10px;color:var(--text-muted);">TYPE</div><div style="font-size:14px;font-weight:800;color:#F59E0B;">' + (inv.investorType || 'INDIVIDUAL') + '</div></div>';
            
            if (holdings.length === 0) {
              bodyEl.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">No individual holdings disclosed yet.</td></tr>';
              return;
            }
            bodyEl.innerHTML = holdings.map(function(h) {
              return '<tr style="border-bottom:1px solid var(--line);">' +
                '<td style="padding:10px 12px;font-weight:600;color:var(--text-primary);">' + (h.companyName || 'N/A') + '</td>' +
                '<td style="padding:10px 12px;text-align:right;">' + (h.shares ? Number(h.shares).toLocaleString('en-IN') : '—') + '</td>' +
                '<td style="padding:10px 12px;text-align:right;font-weight:700;color:var(--accent);">' + (h.holdingPct ? h.holdingPct.toFixed(2) + '%' : '—') + '</td>' +
                '<td style="padding:10px 12px;text-align:right;">₹' + (h.marketValue ? (h.marketValue >= 1000 ? (h.marketValue / 1000).toFixed(1) + 'K Cr' : h.marketValue.toFixed(0) + ' Cr') : '—') + '</td>' +
                '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);">' + (h.reportDate || 'N/A') + '</td>' +
                '<td style="padding:10px 12px;color:var(--text-muted);font-size:10px;">' + (h.source || 'public-disclosure') + '</td>' +
                '</tr>';
            }).join('');
          })
          .catch(function(e) {
            bodyEl.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">Error: ' + e.message + '</td></tr>';
          });
      }

      function showSmStockDetail(stockId, stockName) {
        var modal = document.getElementById('smDetailModal');
        var titleEl = document.getElementById('smModalTitle');
        var subtitleEl = document.getElementById('smModalSubtitle');
        var summaryEl = document.getElementById('smModalSummary');
        var bodyEl = document.getElementById('smModalBody');
        if (!modal) return;
        
        titleEl.textContent = stockName;
        subtitleEl.textContent = 'Which funds hold this stock — aggregated from all AMCs';
        summaryEl.innerHTML = '<div style="background:var(--bg-input);padding:10px;border-radius:8px;text-align:center;"><div style="font-size:10px;color:var(--text-muted);">LOADING</div><div style="font-size:14px;font-weight:800;color:var(--accent);">...</div></div>';
        bodyEl.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">Loading fund holders...</td></tr>';
        modal.style.display = 'flex';

        fetch('/api/stock-holdings/' + stockId)
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data || !data.holdings) {
              bodyEl.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">No fund data available</td></tr>';
              return;
            }
            var holdings = data.holdings;
            var totalWeight = holdings.reduce(function(s, h) { return s + (h.weight || 0); }, 0);
            var totalValue = holdings.reduce(function(s, h) { return s + (h.marketValue || 0); }, 0);
            
            summaryEl.innerHTML = '<div style="background:var(--bg-input);padding:10px;border-radius:8px;text-align:center;"><div style="font-size:10px;color:var(--text-muted);">TOTAL FUNDS</div><div style="font-size:14px;font-weight:800;color:var(--accent);">' + holdings.length + '</div></div>' +
              '<div style="background:var(--bg-input);padding:10px;border-radius:8px;text-align:center;"><div style="font-size:10px;color:var(--text-muted);">COMBINED WEIGHT</div><div style="font-size:14px;font-weight:800;color:var(--profit);">' + totalWeight.toFixed(1) + '%</div></div>' +
              '<div style="background:var(--bg-input);padding:10px;border-radius:8px;text-align:center;"><div style="font-size:10px;color:var(--text-muted);">MARKET VALUE</div><div style="font-size:14px;font-weight:800;color:#3B82F6;">₹' + (totalValue / 100).toFixed(0) + ' Cr</div></div>';
            
            bodyEl.innerHTML = holdings.map(function(h) {
              return '<tr style="border-bottom:1px solid var(--line);">' +
                '<td style="padding:10px 12px;font-weight:600;color:var(--text-primary);">' + (h.fundName || 'N/A') + '</td>' +
                '<td style="padding:10px 12px;text-align:right;">' + (h.quantity ? h.quantity.toLocaleString('en-IN') : '—') + '</td>' +
                '<td style="padding:10px 12px;text-align:right;font-weight:700;color:var(--accent);">' + (h.weight ? h.weight.toFixed(2) + '%' : '—') + '</td>' +
                '<td style="padding:10px 12px;text-align:right;">' + (h.marketValue ? '₹' + (h.marketValue / 100).toFixed(0) + ' Cr' : '—') + '</td>' +
                '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);">—</td>' +
                '<td style="padding:10px 12px;color:var(--text-muted);">' + (h.portfolioDate || 'N/A') + '</td>' +
                '</tr>';
            }).join('');
          })
          .catch(function(e) {
            bodyEl.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">Error: ' + e.message + '</td></tr>';
          });
      }

      function closeSmModal() {
        var m = document.getElementById('smDetailModal');
        if (m) m.style.display = 'none';
      }

// ─── FII & Investors Page ─────────────────────────────────────
      var _fiiTab = 'fii-dii';
      var _fiiSearch = '';
      var _fiiData = { daily: [], shareholding: [], investors: [] };

      function switchFiiTab(tab) {
        _fiiTab = tab;
        var tabIds = ['fii-dii','shareholding','investors','intl-amcs','intl-funds','key-investors','promoters'];
        var contentMap = { 'fii-dii': 'fiiTabContentFii', 'shareholding': 'fiiTabContentShareholding', 'investors': 'fiiTabContentInvestors', 'intl-amcs': 'fiiTabContentIntlAmcs', 'intl-funds': 'fiiTabContentIntlFunds', 'key-investors': 'fiiTabContentKeyInvestors', 'promoters': 'fiiTabContentPromoters' };
        var btnMap = { 'fii-dii': 'fiiTabFii', 'shareholding': 'fiiTabShareholding', 'investors': 'fiiTabInvestors', 'intl-amcs': 'fiiTabIntlAmcs', 'intl-funds': 'fiiTabIntlFunds', 'key-investors': 'fiiTabKeyInvestors', 'promoters': 'fiiTabPromoters' };
        tabIds.forEach(function(t) {
          var el = document.getElementById(contentMap[t]);
          if (el) el.style.display = t === tab ? '' : 'none';
          var b = document.getElementById(btnMap[t]);
          if (b) {
            b.style.background = t === tab ? 'var(--accent)' : 'var(--bg-input)';
            b.style.color = t === tab ? '#fff' : 'var(--text-muted)';
            b.style.border = t === tab ? '2px solid #00B386' : '1px solid var(--line)';
          }
        });
        // Load data for the new tabs on first view
        if (tab === 'intl-amcs' && !_fiiData.amcsLoaded) loadIntlAmcs();
        if (tab === 'intl-funds' && !_fiiData.fundsLoaded) loadIntlFunds();
        if (tab === 'key-investors' && !_fiiData.keyInvestorsLoaded) loadKeyInvestors();
        if (tab === 'promoters' && !_fiiData.promotersLoaded) loadPromoters();
      }

      function loadFiiData() {
        fetch('/api/fii-dii/daily?days=60')
          .then(function(r) { return r.json(); })
          .then(function(data) { if (data && data.success) { _fiiData.daily = data.data || []; renderFiiDiiTable(); buildFiiSummaryCards(); } })
          .catch(function(e) { console.error('[FII] daily:', e); });

        fetch('/api/fii-dii/shareholding')
          .then(function(r) { return r.json(); })
          .then(function(data) { if (data && data.success) { _fiiData.shareholding = data.data || []; renderShareholdingTable(); } })
          .catch(function(e) { console.error('[FII] shareholding:', e); });

        fetch('/api/fii-dii/investors')
          .then(function(r) { return r.json(); })
          .then(function(data) { if (data && data.success) { _fiiData.investors = data.investors || []; renderInvestorsTable(); } })
          .catch(function(e) { console.error('[FII] investors:', e); });
      }

      function buildFiiSummaryCards() {
        var el = document.getElementById('fiiSummaryCards');
        if (!el) return;
        var daily = _fiiData.daily;
        var fiiNet = 0, diiNet = 0, lastDate = '';
        daily.forEach(function(d) {
          if (d.category && d.category.indexOf('FII') !== -1) fiiNet += (d.netValue || 0);
          if (d.category && d.category.indexOf('DII') !== -1) diiNet += (d.netValue || 0);
          if (!lastDate && d.date) lastDate = d.date;
        });
        var shCount = _fiiData.shareholding.length;
        var invCount = _fiiData.investors.length;
        el.innerHTML =
          '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;padding:16px;"><div style="font-size:11px;color:var(--text-muted);font-weight:600;">FII Net (30D)</div><div style="font-size:22px;font-weight:800;color:' + (fiiNet>=0?'#00B386':'#EB5B56') + ';margin:2px 0;">' + (fiiNet>=0?'+':'') + '\u20b9' + Math.abs(fiiNet).toFixed(0) + ' Cr</div><div style="font-size:10px;color:var(--text-muted);">foreign inflow/outflow</div></div>' +
          '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;padding:16px;"><div style="font-size:11px;color:var(--text-muted);font-weight:600;">DII Net (30D)</div><div style="font-size:22px;font-weight:800;color:' + (diiNet>=0?'#00B386':'#EB5B56') + ';margin:2px 0;">' + (diiNet>=0?'+':'') + '\u20b9' + Math.abs(diiNet).toFixed(0) + ' Cr</div><div style="font-size:10px;color:var(--text-muted);">domestic institutional flow</div></div>' +
          '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;padding:16px;"><div style="font-size:11px;color:var(--text-muted);font-weight:600;">Companies Tracked</div><div style="font-size:22px;font-weight:800;color:#F59E0B;margin:2px 0;">' + shCount + '</div><div style="font-size:10px;color:var(--text-muted);">with shareholding data</div></div>' +
          '<div style="background:var(--bg-panel);border:1px solid var(--line);border-radius:12px;padding:16px;"><div style="font-size:11px;color:var(--text-muted);font-weight:600;">Last Updated</div><div style="font-size:22px;font-weight:800;color:#4A9EFF;margin:2px 0;">' + (lastDate || 'N/A') + '</div><div style="font-size:10px;color:var(--text-muted);">from NSE source</div></div>';
      }

      function renderFiiDiiTable() {
        var tbody = document.getElementById('fiiDiiTableBody');
        if (!tbody) return;
        var data = _fiiData.daily;
        if (!data || data.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--text-muted);">No FII/DII data yet. Will be fetched from NSE after deploy.</td></tr>';
          return;
        }
        tbody.innerHTML = data.map(function(d) {
          var catColor = (d.category||'').indexOf('FII') !== -1 ? '#8B5CF6' : '#3B82F6';
          var nc = (d.netValue||0) >= 0 ? '#00B386' : '#EB5B56';
          var arrow = (d.netValue||0) >= 0 ? '\u25B2' : '\u25BC';
          return '<tr style="border-bottom:1px solid var(--line);">'
            + '<td style="padding:10px 12px;font-size:12px;font-weight:600;color:var(--text-primary);">' + (d.date||'-') + '</td>'
            + '<td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.12);color:' + catColor + ';font-size:10px;padding:3px 10px;border-radius:10px;font-weight:700;">' + (d.category||'-') + '</span></td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:#00B386;">\u20b9' + (d.buyValue||0).toFixed(1) + ' Cr</td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:#EB5B56;">\u20b9' + (d.sellValue||0).toFixed(1) + ' Cr</td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:800;color:' + nc + ';">' + arrow + ' \u20b9' + Math.abs(d.netValue||0).toFixed(1) + ' Cr</td>'
            + '</tr>';
        }).join('');
      }

      function renderShareholdingTable() {
        var tbody = document.getElementById('shareholdingTableBody');
        if (!tbody) return;
        var data = _fiiData.shareholding;
        if (!data || data.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--text-muted);">No shareholding data yet. Will be fetched from NSE after deploy.</td></tr>';
          return;
        }
        function pc(v) { return v == null ? 'var(--text-muted)' : v > 20 ? '#00B386' : v > 5 ? '#F59E0B' : 'var(--text-primary)'; }
        tbody.innerHTML = data.map(function(s) {
          return '<tr style="border-bottom:1px solid var(--line);">'
            + '<td style="padding:10px 12px;font-size:12px;font-weight:700;color:var(--text-primary);">' + (s.companyName||'-') + '</td>'
            + '<td style="padding:10px 12px;font-size:11px;color:var(--text-muted);">' + (s.symbol||'-') + '</td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700;color:' + pc(s.promoterPct) + ';">' + (s.promoterPct!=null ? s.promoterPct.toFixed(1)+'%' : '-') + '</td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700;color:' + pc(s.fiiPct) + ';">' + (s.fiiPct!=null ? s.fiiPct.toFixed(1)+'%' : '-') + '</td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700;color:' + pc(s.diiPct) + ';">' + (s.diiPct!=null ? s.diiPct.toFixed(1)+'%' : '-') + '</td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:var(--text-primary);">' + (s.publicPct!=null ? s.publicPct.toFixed(1)+'%' : '-') + '</td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:11px;color:var(--text-muted);">' + (s.reportDate||'-') + '</td>'
            + '</tr>';
        }).join('');
      }

      function renderInvestorsTable() {
        var tbody = document.getElementById('investorsTableBody');
        if (!tbody) return;
        var data = _fiiData.investors;
        if (!data || data.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--text-muted);">No individual investors discovered yet. Will be discovered from NSE shareholding patterns.</td></tr>';
          return;
        }
        tbody.innerHTML = data.map(function(inv) {
          return '<tr style="border-bottom:1px solid var(--line);cursor:pointer;" onclick="openInvestorDetail(' + inv.id + ')" onmouseenter="this.style.background=\x27var(--bg-raised)\x27" onmouseleave="this.style.background=\x27transparent\x27">'
            + '<td style="padding:10px 12px;font-size:12px;font-weight:700;color:var(--text-primary);">' + (inv.investorName||'-') + '</td>'
            + '<td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.12);color:#6366F1;font-size:10px;padding:3px 10px;border-radius:10px;font-weight:700;">' + (inv.investorType||'INDIVIDUAL') + '</span></td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700;color:var(--text-primary);">' + (inv.totalPortfolioValue ? '\u20b9' + Number(inv.totalPortfolioValue).toLocaleString('en-IN') + ' Cr' : '-') + '</td>'
            + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:var(--accent);">' + (inv.holdingsCount||0) + '</td>'
            + '<td style="padding:10px 12px;text-align:center;"><button style="background:var(--accent);color:#fff;border:none;padding:4px 12px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;">View</button></td>'
            + '</tr>';
        }).join('');
      }

      function openInvestorDetail(investorId) {
        var modal = document.getElementById('fiiInvestorModal');
        if (!modal) return;
        modal.style.display = 'flex';
        document.getElementById('fiiModalTitle').textContent = 'Loading...';
        document.getElementById('fiiModalSubtitle').textContent = '';
        document.getElementById('fiiModalBody').innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">Loading...</td></tr>';
        fetch('/api/fii-dii/investors/' + investorId + '/holdings')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data || !data.success) { document.getElementById('fiiModalTitle').textContent = 'Error'; return; }
            var inv = data.investor;
            var h = data.holdings || [];
            document.getElementById('fiiModalTitle').textContent = inv.investorName;
            document.getElementById('fiiModalSubtitle').textContent = (inv.investorType||'Individual') + ' | ' + h.length + ' holdings';
            document.getElementById('fiiModalBody').innerHTML = h.map(function(x, i) {
              var pc = (x.holdingPct||0) > 5 ? '#00B386' : (x.holdingPct||0) > 1 ? '#F59E0B' : 'var(--text-primary)';
              return '<tr style="border-bottom:1px solid var(--line);">'
                + '<td style="padding:8px 12px;font-size:12px;font-weight:600;color:var(--text-primary);"><span style="color:var(--text-muted);font-size:10px;">' + (i+1) + '.</span> ' + (x.companyName||'-') + '</td>'
                + '<td style="padding:8px 12px;font-size:11px;color:var(--text-muted);">' + (x.symbol||'-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--text-primary);">' + (x.shares ? Number(x.shares).toLocaleString('en-IN') : '-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:800;color:' + pc + ';">' + (x.holdingPct!=null ? x.holdingPct.toFixed(2)+'%' : '-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--text-primary);">' + (x.marketValue ? '\u20b9' + Number(x.marketValue).toLocaleString('en-IN') + ' Cr' : '-') + '</td>'
                + '<td style="padding:8px 12px;font-size:11px;color:var(--text-muted);">' + (x.reportDate||'-') + '</td>'
                + '</tr>';
            }).join('');
          })
          .catch(function(err) { document.getElementById('fiiModalTitle').textContent = 'Error: ' + err.message; });
      }

      function closeFiiModal() {
        var m = document.getElementById('fiiInvestorModal');
        if (m) m.style.display = 'none';
      }

      // ─── Section 4: International AMCs ───────────────────────────
      _fiiData.amcsLoaded = false;
      function loadIntlAmcs() {
        fetch('/api/fii-dii/international-amcs?sort=aum')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data && data.success) {
              _fiiData.amcsLoaded = true;
              var tbody = document.getElementById('intlAmcsTableBody');
              if (!tbody) return;
              var amcs = data.amcs || [];
              if (amcs.length === 0) { tbody.innerHTML = '<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--text-muted);">No international AMC data yet.</td></tr>'; return; }
              var flagMap = { 'USA': '\uD83C\uDDFA\uD83C\uDDF8', 'UK': '\uD83C\uDDEC\uD83C\uDDE7', 'France': '\uD83C\uDDEB\uD83C\uDDF7', 'Japan': '\uD83C\uDDEF\uD83C\uDDF5', 'South Korea': '\uD83C\uDDF0\uD83C\uDDF7', 'South Africa': '\uD83C\uDDFF\uD83C\uDDE6' };
              tbody.innerHTML = amcs.map(function(a) {
                var flag = flagMap[a.country] || '';
                return '<tr style="border-bottom:1px solid var(--line);">'
                  + '<td style="padding:10px 12px;font-size:12px;font-weight:700;color:var(--text-primary);">' + a.name + '</td>'
                  + '<td style="padding:10px 12px;font-size:12px;color:var(--text-muted);">' + flag + ' ' + (a.country || '-') + '</td>'
                  + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700;color:var(--accent);">' + (a.aumUsdBn ? '$' + Number(a.aumUsdBn).toLocaleString('en-IN') + ' Bn' : '-') + '</td>'
                  + '<td style="padding:10px 12px;font-size:11px;"><a href="' + (a.website || '#') + '" target="_blank" style="color:var(--accent);text-decoration:none;">' + (a.website || '-') + '</a></td>'
                  + '</tr>';
              }).join('');
            }
          })
          .catch(function(e) { console.error('[FII] intl amcs:', e); });
      }

      // ─── Section 5: International Funds ──────────────────────────
      _fiiData.fundsLoaded = false;
      function loadIntlFunds() {
        fetch('/api/fii-dii/international-funds')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data && data.success) {
              _fiiData.fundsLoaded = true;
              var tbody = document.getElementById('intlFundsTableBody');
              if (!tbody) return;
              var funds = data.funds || [];
              if (funds.length === 0) { tbody.innerHTML = '<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--text-muted);">No international fund data yet. Funds will be discovered after deploy.</td></tr>'; return; }
              tbody.innerHTML = funds.map(function(f) {
                return '<tr style="border-bottom:1px solid var(--line);">'
                  + '<td style="padding:10px 12px;font-size:12px;font-weight:700;color:var(--text-primary);">' + (f.fundName || '-') + '</td>'
                  + '<td style="padding:10px 12px;font-size:11px;color:var(--text-muted);">' + (f.amcName || '-') + '</td>'
                  + '<td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.12);color:#6366F1;font-size:10px;padding:3px 8px;border-radius:10px;font-weight:700;">' + (f.fundType || '-') + '</span></td>'
                  + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:var(--text-primary);">' + (f.aumUsd ? '$' + Number(f.aumUsd).toLocaleString('en-IN') : '-') + '</td>'
                  + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700;color:' + ((f.indiaAllocationPct||0) > 10 ? '#00B386' : 'var(--text-primary)') + ';">' + (f.indiaAllocationPct != null ? f.indiaAllocationPct.toFixed(1) + '%' : '-') + '</td>'
                  + '</tr>';
              }).join('');
            }
          })
          .catch(function(e) { console.error('[FII] intl funds:', e); });
      }

      // ─── Section 6: Key Investors ────────────────────────────────
      _fiiData.keyInvestorsLoaded = false;
      function loadKeyInvestors() {
        fetch('/api/fii-dii/key-investors')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data && data.success) {
              _fiiData.keyInvestorsLoaded = true;
              var tbody = document.getElementById('keyInvestorsTableBody');
              if (!tbody) return;
              var investors = data.investors || [];
              if (investors.length === 0) { tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-muted);">No key investors discovered yet. Investors will be discovered from NSE shareholding patterns.</td></tr>'; return; }
              tbody.innerHTML = investors.map(function(inv) {
                var typeColor = inv.investorType === 'FAMILY_OFFICE' ? '#EC4899' : inv.investorType === 'INVESTMENT_VEHICLE' ? '#F59E0B' : '#6366F1';
                return '<tr style="border-bottom:1px solid var(--line);cursor:pointer;" onclick="openKeyInvestorDetail(' + inv.id + ')" onmouseenter="this.style.background=\x27var(--bg-raised)\x27" onmouseleave="this.style.background=\x27transparent\x27">'
                  + '<td style="padding:10px 12px;font-size:12px;font-weight:700;color:var(--text-primary);">' + (inv.name || '-') + '</td>'
                  + '<td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.12);color:' + typeColor + ';font-size:10px;padding:3px 10px;border-radius:10px;font-weight:700;">' + (inv.investorType || 'INDIVIDUAL') + '</span></td>'
                  + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700;color:var(--text-primary);">' + (inv.totalPortfolioValueInr ? '\u20b9' + Number(inv.totalPortfolioValueInr).toLocaleString('en-IN') + ' Cr' : '-') + '</td>'
                  + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:var(--accent);">' + (inv.holdingsCount || 0) + '</td>'
                  + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:' + ((inv.avgHoldingPct||0) > 3 ? '#00B386' : 'var(--text-muted)') + ';">' + (inv.avgHoldingPct ? inv.avgHoldingPct.toFixed(1) + '%' : '-') + '</td>'
                  + '<td style="padding:10px 12px;text-align:center;"><button style="background:var(--accent);color:#fff;border:none;padding:4px 12px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;">View</button></td>'
                  + '</tr>';
              }).join('');
            }
          })
          .catch(function(e) { console.error('[FII] key investors:', e); });
      }

      function openKeyInvestorDetail(id) {
        var modal = document.getElementById('fiiInvestorModal');
        if (!modal) return;
        modal.style.display = 'flex';
        document.getElementById('fiiModalTitle').textContent = 'Loading...';
        document.getElementById('fiiModalSubtitle').textContent = '';
        document.getElementById('fiiModalBody').innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">Loading...</td></tr>';
        fetch('/api/fii-dii/key-investors/' + id + '/holdings')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data || !data.success) { document.getElementById('fiiModalTitle').textContent = 'Error'; return; }
            var inv = data.investor;
            var h = data.holdings || [];
            document.getElementById('fiiModalTitle').textContent = inv.name;
            document.getElementById('fiiModalSubtitle').textContent = (inv.investorType||'Individual') + ' | ' + h.length + ' holdings';
            document.getElementById('fiiModalBody').innerHTML = h.map(function(x, i) {
              var pc = (x.holdingPct||0) > 5 ? '#00B386' : (x.holdingPct||0) > 1 ? '#F59E0B' : 'var(--text-primary)';
              return '<tr style="border-bottom:1px solid var(--line);">'
                + '<td style="padding:8px 12px;font-size:12px;font-weight:600;color:var(--text-primary);"><span style="color:var(--text-muted);font-size:10px;">' + (i+1) + '.</span> ' + (x.companyName||'-') + '</td>'
                + '<td style="padding:8px 12px;font-size:11px;color:var(--text-muted);">' + (x.isin||'-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--text-primary);">' + (x.shares ? Number(x.shares).toLocaleString('en-IN') : '-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:800;color:' + pc + ';">' + (x.holdingPct!=null ? x.holdingPct.toFixed(2)+'%' : '-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--text-primary);">' + (x.marketValueInr ? '\u20b9' + Number(x.marketValueInr).toLocaleString('en-IN') + ' Cr' : '-') + '</td>'
                + '<td style="padding:8px 12px;font-size:11px;color:var(--text-muted);">' + (x.reportDate||'-') + '</td>'
                + '</tr>';
            }).join('');
          })
          .catch(function(err) { document.getElementById('fiiModalTitle').textContent = 'Error: ' + err.message; });
      }

      // ─── Section 7: Promoters ────────────────────────────────────
      _fiiData.promotersLoaded = false;
      function loadPromoters() {
        fetch('/api/fii-dii/promoters')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data && data.success) {
              _fiiData.promotersLoaded = true;
              var tbody = document.getElementById('promotersTableBody');
              if (!tbody) return;
              var promoters = data.promoters || [];
              if (promoters.length === 0) { tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-muted);">No promoter data yet.</td></tr>'; return; }
              tbody.innerHTML = promoters.map(function(p) {
                var typeColor = p.promoterType === 'PROMOTER' ? '#00B386' : '#F59E0B';
                return '<tr style="border-bottom:1px solid var(--line);cursor:pointer;" onclick="openPromoterDetail(' + p.id + ')" onmouseenter="this.style.background=\x27var(--bg-raised)\x27" onmouseleave="this.style.background=\x27transparent\x27">'
                  + '<td style="padding:10px 12px;font-size:12px;font-weight:700;color:var(--text-primary);">' + (p.name || '-') + '</td>'
                  + '<td style="padding:10px 12px;"><span style="background:rgba(0,179,134,0.12);color:' + typeColor + ';font-size:10px;padding:3px 10px;border-radius:10px;font-weight:700;">' + (p.promoterType || 'PROMOTER') + '</span></td>'
                  + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:var(--accent);">' + (p.companiesHolding || 0) + '</td>'
                  + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700;color:var(--text-primary);">' + (p.totalShares ? Number(p.totalShares).toLocaleString('en-IN') : '-') + '</td>'
                  + '<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700;color:var(--text-primary);">' + (p.totalValueInr ? '\u20b9' + Number(p.totalValueInr).toLocaleString('en-IN') + ' Cr' : '-') + '</td>'
                  + '<td style="padding:10px 12px;text-align:center;"><button style="background:var(--accent);color:#fff;border:none;padding:4px 12px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;">View</button></td>'
                  + '</tr>';
              }).join('');
            }
          })
          .catch(function(e) { console.error('[FII] promoters:', e); });
      }

      function openPromoterDetail(id) {
        var modal = document.getElementById('fiiInvestorModal');
        if (!modal) return;
        modal.style.display = 'flex';
        document.getElementById('fiiModalTitle').textContent = 'Loading...';
        document.getElementById('fiiModalSubtitle').textContent = '';
        document.getElementById('fiiModalBody').innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);">Loading...</td></tr>';
        fetch('/api/fii-dii/promoters/' + id + '/holdings')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data || !data.success) { document.getElementById('fiiModalTitle').textContent = 'Error'; return; }
            var p = data.promoter;
            var h = data.holdings || [];
            document.getElementById('fiiModalTitle').textContent = p.name;
            document.getElementById('fiiModalSubtitle').textContent = (p.promoterType||'Promoter') + ' | ' + h.length + ' companies';
            document.getElementById('fiiModalBody').innerHTML = h.map(function(x, i) {
              var change = x.changePct;
              var changeColor = change > 0 ? '#00B386' : change < 0 ? '#EB5B56' : 'var(--text-muted)';
              var changeArrow = change > 0 ? '\u25B2' : change < 0 ? '\u25BC' : '=';
              return '<tr style="border-bottom:1px solid var(--line);">'
                + '<td style="padding:8px 12px;font-size:12px;font-weight:600;color:var(--text-primary);"><span style="color:var(--text-muted);font-size:10px;">' + (i+1) + '.</span> ' + (x.companyName||'-') + '</td>'
                + '<td style="padding:8px 12px;font-size:11px;color:var(--text-muted);">' + (x.holdingType||'-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--text-primary);">' + (x.shares ? Number(x.shares).toLocaleString('en-IN') : '-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:800;color:var(--text-primary);">' + (x.holdingPct!=null ? x.holdingPct.toFixed(2)+'%' : '-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:700;color:' + changeColor + ';">' + changeArrow + ' ' + (change != null ? change.toFixed(2) + '%' : '-') + '</td>'
                + '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--text-primary);">' + (x.marketValueInr ? '\u20b9' + Number(x.marketValueInr).toLocaleString('en-IN') + ' Cr' : '-') + '</td>'
                + '</tr>';
            }).join('');
          })
          .catch(function(err) { document.getElementById('fiiModalTitle').textContent = 'Error: ' + err.message; });
      }

      function searchFiiData(q) {
        var query = (q || '').toLowerCase();
        document.querySelectorAll('#shareholdingTableBody tr, #investorsTableBody tr, #intlAmcsTableBody tr, #intlFundsTableBody tr, #keyInvestorsTableBody tr, #promotersTableBody tr').forEach(function(r) {
          r.style.display = query === '' || r.textContent.toLowerCase().indexOf(query) !== -1 ? '' : 'none';
        });
      }

      // ── Individual/Family sub-filter handlers ──
      document.querySelectorAll('.sm-indiv-filter').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.sm-indiv-filter').forEach(function(b) {
            b.style.background = 'transparent';
            b.style.color = 'var(--text-muted)';
            b.style.fontWeight = '600';
            b.classList.remove('active');
          });
          btn.style.background = 'var(--accent)';
          btn.style.color = '#fff';
          btn.style.fontWeight = '700';
          btn.classList.add('active');
          // TODO: filter individual table by type
        });
      });
      document.querySelectorAll('.sm-country-filter').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.sm-country-filter').forEach(function(b) {
            b.style.background = 'transparent';
            b.style.color = 'var(--text-muted)';
            b.style.fontWeight = '600';
            b.classList.remove('active');
          });
          btn.style.background = 'var(--accent)';
          btn.style.color = '#fff';
          btn.style.fontWeight = '700';
          btn.classList.add('active');
        });
      });
      document.querySelectorAll('.sm-foreign-filter').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.sm-foreign-filter').forEach(function(b) {
            b.style.background = 'transparent';
            b.style.color = 'var(--text-muted)';
            b.style.fontWeight = '600';
            b.classList.remove('active');
          });
          btn.style.background = 'var(--accent)';
          btn.style.color = '#fff';
          btn.style.fontWeight = '700';
          btn.classList.add('active');
        });
      });
      document.querySelectorAll('.sm-focus-filter').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.sm-focus-filter').forEach(function(b) {
            b.style.background = 'transparent';
            b.style.color = 'var(--text-muted)';
            b.style.fontWeight = '600';
            b.classList.remove('active');
          });
          btn.style.background = 'var(--accent)';
          btn.style.color = '#fff';
          btn.style.fontWeight = '700';
          btn.classList.add('active');
        });
      });

      var searchTimeout = null;
      document.addEventListener('input', function(e) {
        if (e.target.id === 'mfSearchInput') {
          clearTimeout(searchTimeout);
          currentMfSearch = e.target.value;
          searchTimeout = setTimeout(function() {
            fetchMfSchemes(currentMfTimeframe, currentMfSearch);
          }, 200);
        } else if (e.target.id === 'modalHoldingSearchInput') {
          var q = e.target.value.trim().toLowerCase();
          if (!q) {
            renderModalHoldingsTable(currentModalHoldings);
          } else {
            var filtered = currentModalHoldings.filter(function(h) {
              var inSym = (h.symbol || '').toLowerCase().indexOf(q) !== -1;
              var inName = (h.name || '').toLowerCase().indexOf(q) !== -1;
              var inSec = (h.sector || '').toLowerCase().indexOf(q) !== -1;
              return inSym || inName || inSec;
            });
            renderModalHoldingsTable(filtered);
          }
        }
      });

      // Init page
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { renderAmcCards(); fetchMfSchemes(); loadStockHoldingsScanner(); loadFiiData(); });
      } else {
        renderAmcCards();
        fetchMfSchemes();
        loadStockHoldingsScanner();
        loadFiiData();
      }
      window.toggleAmcDropdown=toggleAmcDropdown;
      window.filterMfAmc=filterMfAmc;
      window.searchAmcFilter=searchAmcFilter;
      window.filterMfCategory=filterMfCategory;
      window.renderMfGrid=renderMfGrid;
      window.searchMfSchemes=searchMfSchemes;
      window.openMfDetailFromTable=openMfDetailFromTable;
      window.applyMfFilters=applyMfFilters;
      window.closeFiiModal=closeFiiModal;
      window.closeSmModal=closeSmModal;
      window.closeStockModal=closeStockModal;
      window.fetchMfSchemes=fetchMfSchemes;
      window.filterStockSector=filterStockSector;
      window.openInvestorDetail=openInvestorDetail;
      window.openKeyInvestorDetail=openKeyInvestorDetail;
      window.openPromoterDetail=openPromoterDetail;
      window.openStockDetail=openStockDetail;
      window.sortStockTable=sortStockTable;
      window.loadSmIndividualData=loadSmIndividualData;
      window.loadSmForeignData=loadSmForeignData;
      window.loadSmartMoneySummary=loadSmartMoneySummary;
      window.loadStockHoldingsScanner=loadStockHoldingsScanner;
      var _mfViewTab = window._mfViewTab || "summary";
      window.switchMfViewTab = function(t){ window._mfViewTab=t; var g=document.getElementById("mfSchemesGrid"); if(g && window._mfLastSchemes) _renderMfGridBody(g, window._mfLastSchemes); };
    })();
  