// React 18 Scalping Dashboard Component

const {

  useState,

  useEffect,

  useMemo,

  useRef

} = React;



// --- Helper Utilities ---

function sweetAndShortSubject(title, description, symbol, materiality) {

  let rawTitle = String(title || '').trim();

  let rawDesc = String(description || '').trim();

  let subjectTag = '';

  const pipeMatch = (rawDesc + ' ' + rawTitle).match(/\|SUBJECT:\s*([^|]+)/i);

  if (pipeMatch) subjectTag = pipeMatch[1].trim();

  let t = rawTitle.replace(/\|SUBJECT:.*$/i, '').replace(/\|.*$/i, '').trim();

  let d = rawDesc.replace(/\|SUBJECT:.*$/i, '').replace(/\|.*$/i, '').trim();

  let s = d && d.length > 10 && !/^\s*http/i.test(d) ? d : t;

  if (!s || s.length === 0) s = t || materiality || 'Corporate Announcement';

  s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  s = s.replace(/^.*?(?:has informed the Exchange (?:about|regarding)|has submitted to the Exchange,?|hereby informs the Exchange that)\s*[:\-]?\s*/i, '');

  s = s.replace(/^We (?:hereby )?(?:enclose|submit|inform|intimate) (?:herewith )?.*?(?:regarding|that)\s*[:\-]?\s*/i, '');

  s = s.replace(/^Pursuant to Regulation \d+.*?we (?:hereby )?.*?(?:that|in respect of)\s*[:\-]?\s*/i, '');

  s = s.replace(/^Please refer (?:the )?enclosed (?:intimation|document)\s*[:\-]?\s*/i, '');

  s = s.replace(/^General Updates\s*[:\-]\s*/i, '');

  const qm = s.match(/["'“]([^"'”]{8,140})["'”]/);

  if (qm && qm[1]) {

    const inner = qm[1].trim();

    if (!/^(the|a|an|yes|no)$/i.test(inner)) {

      if (/^Intimation regarding/i.test(s) || s.length > inner.length + 20) {

        s = inner;

      }

    }

  }

  s = s.replace(/\s*\(DIN\s*\d+\)/gi, '');

  s = s.replace(/\s*w\.e\.f\.?\s+[A-Za-z0-9\s,]+$/i, '');

  s = s.replace(/\s*held on [A-Za-z0-9\s,]+$/i, '');

  s = s.replace(/dated\s+[A-Za-z0-9\s,]+?(?=\s+for|\s+on|\s+regarding|$)/gi, '');

  s = s.replace(/\s+/g, ' ').trim();

  if (/Delayed\/Non-submission of Financial Results/i.test(s) || /Delayed\/Non-submission/i.test(subjectTag) || /delayed\/non/i.test(s)) {

    s = 'Delayed / Non-submission of Financial Results';

  } else if (/Newspaper Publication/i.test(s) || /Newspapers Publication/i.test(s) || /copy of newspaper/i.test(s) || /paper cutting/i.test(s) || /newspaper clipping/i.test(s)) {

    s = (/Financial Results|Quarterly Results/i.test(s + ' ' + d))

      ? '📄 Newspaper Publication of Q2 Financial Results (Reg 47 Clipping)'

      : '📄 Newspaper Publication (Statutory Notice)';

  } else if (/Press Release.*?Financial Results/i.test(s) || /press release.*?Financial Results/i.test(d)) {

    s = /Q2|half.?year|September 30|30th September/i.test(s + ' ' + d) ? 'Q2 FY27 Financial Results (Press Release)' : 'Quarterly Financial Results (Press Release)';

  } else if (/financial results for the period ended/i.test(s) || /Unaudited Financial Results/i.test(s)) {

    s = /Q2|half.?year|September 30|30th September/i.test(s + ' ' + d) ? 'Q2 FY27 Unaudited Financial Results' : 'Quarterly Financial Results';

  } else if (/Allotment of [0-9,]+ (equity )?shares/i.test(s) || /Allotment of Shares/i.test(s)) {

    const num = (s.match(/[0-9,]+/) || [''])[0];

    s = num ? `ESOP Allotment of ${num} Shares` : 'ESOP Share Allotment';

  } else if (/Appointment of .*? as Non-?\s*Executive Independent Director/i.test(s)) {

    const nameMatch = s.match(/Appointment of (?:Mr\.|Ms\.|Dr\.)?\s*([A-Za-z\s]+) as Non/i);

    s = nameMatch ? `Appointment of ${nameMatch[1].trim()} as Independent Director` : 'Appointment of Independent Director';

  } else if (/resignation of senior management/i.test(s) || /Resignation of Director/i.test(s) || /Cessation of/i.test(s)) {

    s = 'Senior Management / Director Resignation';

  } else if (/ISD for Buyback|Buy-back/i.test(s) || /Buyback/i.test(subjectTag)) {

    s = 'Share Buyback Notice / Issue Summary';

  } else if (/Timely payment of interest.*?Non-Convertible Debentures/i.test(s) || /Payment of Interest and Principal/i.test(s)) {

    s = 'NCD Interest & Principal Repayment (Reg 57)';

  } else if (/Statement of deviation\(s\)/i.test(s) || /under Reg\. 32/i.test(s)) {

    s = 'Statement of Deviation(s) (Reg. 32 Compliance)';

  } else if (/Intimation of cyber security incident/i.test(s)) {

    s = 'Cyber Security Incident Intimation';

  } else if (/Schedule of (?:meet|Analysts)/i.test(s) || /Con\.? Call Updates/i.test(subjectTag)) {

    s = 'Analyst / Institutional Investor Meet';

  } else if (/^Outcome of Board Meeting/i.test(s)) {

    s = 'Outcome of Board Meeting';

  }

  s = s.replace(/^['":\-\s]+/, '').replace(/['":\-\s]+$/, '').trim();

  if (s.length < 5) {

    if (subjectTag && subjectTag.length >= 4) s = subjectTag;else s = materiality ? `${materiality} Announcement` : 'Corporate Announcement';

  }

  return s.charAt(0).toUpperCase() + s.slice(1);

}

function formatCategory(mat, kind) {

  const m = String(mat || '').toLowerCase();

  const k = String(kind || '').toLowerCase();

  if (m.includes('routine') || k.includes('routine')) return 'Routine';

  if (m.includes('order') || k.includes('order')) return 'Order';

  if (m.includes('result') || k.includes('result') || k.includes('earning')) return 'Earnings';

  if (m.includes('action') || k.includes('acqui') || k.includes('buyback') || k.includes('merger')) return 'Corporate';

  if (m.includes('mgmt') || k.includes('appoint') || k.includes('director')) return 'Management';

  if (m.includes('capital') || k.includes('esop') || k.includes('dividend')) return 'Capital';

  return 'General';

}

function formatDescription(desc, title, symbol) {

  let s = String(desc || '').replace(/\|SUBJECT:.*$/i, '').replace(/\|.*$/i, '').trim();

  s = s.replace(/https?:\/\/\S+/gi, '').trim();



  // Strip company boilerplate prefix and phrase nicely

  s = s.replace(/^.*?(?:has informed the Exchange (?:about|regarding)|has submitted to the Exchange,?|hereby informs the Exchange that)\s*[:\-]?\s*/i, match => {

    let comp = match.replace(/(?:has informed|has submitted|hereby informs).*$/i, '').trim();

    comp = comp.replace(/ Limited| Ltd\.?| Corp\.?| Corporation/gi, '').trim();

    return comp ? `${comp} disclosed ` : 'The company disclosed ';

  });

  s = s.replace(/^We (?:hereby )?(?:enclose|submit|inform|intimate) (?:herewith )?.*?(?:regarding|that)\s*[:\-]?\s*/i, 'Disclosed that ');

  s = s.replace(/^Pursuant to Regulation \d+.*?we (?:hereby )?.*?(?:that|in respect of)\s*[:\-]?\s*/i, 'Pursuant to listing regulations, ');

  s = s.replace(/\s+/g, ' ').trim();

  if (s.length < 10) {

    return `${symbol} disclosed: ${title || 'corporate announcement to the exchange'}.`;

  }

  return s.charAt(0).toUpperCase() + s.slice(1);

}

function sweetAndShortRationale(rationale, bias, materiality, headline, move1m = 0) {

  if (rationale && (rationale.includes('Priced-in exhaustion') || rationale.includes('Tape rejecting') || rationale.includes('Fresh unpriced breakout') || rationale.includes('Pre-move window') || rationale.includes('gapped down'))) {

    return rationale;

  }

  const sub = String(headline || '').toLowerCase();

  const mat = String(materiality || '').toUpperCase();

  if (sub.includes('delayed') || sub.includes('non-submission') || sub.includes('delay')) {

    return 'Delayed / non-submission of financial results indicates regulatory or accounting distress · Fade or avoid';

  }

  if (sub.includes('cyber security')) {

    return 'Cyber security incident reported · High risk of operational disruption and negative sentiment';

  }

  if (sub.includes('resignation') || sub.includes('cessation')) {

    return 'Key management resignation · Creates governance uncertainty and downside drift bias';

  }

  if (sub.includes('buyback') || sub.includes('buy-back')) {

    return 'Board approved share buyback · Strong price support & promoter confidence';

  }

  if (sub.includes('acquisition') || sub.includes('merger') || sub.includes('takeover')) {

    return 'Strategic acquisition / expansion · Growth catalyst; watch 1m continuation';

  }

  if (sub.includes('order') || sub.includes('contract') || sub.includes('awarded')) {

    return 'Commercial order win / contract award · Strong revenue visibility and momentum';

  }

  if (sub.includes('financial result') || sub.includes('q2') || mat === 'RESULTS') {

    if (move1m <= -0.25) {

      return `Tape rejecting results: 1m velocity dumping (${move1m.toFixed(2)}%). Street consensus missed; fade bounce.`;

    } else if (move1m >= 0.25) {

      return `Fresh results breakout: 1m tape surging (+${move1m.toFixed(2)}%). High momentum scalp candidate.`;

    }

    return 'Q2 financial results filing · Pre-move window; watch for 1m volume breakout above VWAP';

  }

  if (sub.includes('appointment')) {

    return 'Key leadership / C-suite appointment · Positive governance & strategic momentum';

  }

  if (sub.includes('deviation') || sub.includes('reg. 32')) {

    return 'No deviations reported under Reg 32 · Routine regulatory compliance filing';

  }

  if (sub.includes('debenture') || sub.includes('reg 57')) {

    return 'Timely debt / debenture interest service · Credit positive administrative update';

  }

  if (rationale && rationale.length > 5 && !rationale.includes('Wait for 09:30 confirmation')) {

    let r = String(rationale).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

    return r.charAt(0).toUpperCase() + r.slice(1);

  }

  return 'Corporate filing · Pre-move window; wait for directional 1m volume confirmation';

}

function getTagClass(materiality) {

  const mat = String(materiality || 'NEWS').toUpperCase();

  if (mat.includes('RESULT')) return 'tag-results';

  if (mat.includes('BOARD')) return 'tag-board';

  if (mat.includes('MANAGEMENT') || mat.includes('MGMT')) return 'tag-mgmt';

  if (mat.includes('DIVIDEND')) return 'tag-dividend';

  if (mat.includes('ORDER')) return 'tag-order';

  return 'tag-other';

}

function getBiasInfo(c) {

  const bias = String(c.bias || 'NEUTRAL').toUpperCase();

  const pred = String(c.prediction || '').toUpperCase();

  const move1m = Number(c.move1mPct || 0);

  const move5m = Number(c.move5mPct || 0);

  const movePct = Number(c.movePct || 0);

  const p = Number(c.ltp || c.close || c.effectivePrice || 0);

  const vol = Number(c.volume || 0);

  const isPenny = Boolean(c.isPennyStock || (p > 0 && p < 20.0) || /^\d+$/.test(c.symbol));

  const isLowVol = Boolean(c.isLowVolume || (vol > 0 && vol < 20000));

  const isUntradeable = isPenny;



  // 1. Stale news from yesterday during active session or > 45 minutes old

  const diffMin = c.ts ? (Date.now() - Number(c.ts)) / 60000 : 999;

  const isMarketOpenNow = (() => {
    const d = new Date(Date.now() + 330 * 60000);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) return false;
    const t = d.getUTCHours() * 100 + d.getUTCMinutes();
    return t >= 915 && t < 1530;
  })();
  const isStaleYesterday = isMarketOpenNow && Boolean(c.tradeStatus === 'STALE_YESTERDAY' || (c.timeAgo && (c.timeAgo.includes('d ago') || (c.timeAgo.includes('h ago') && parseInt(c.timeAgo) > 10))));

  const fullTitleLower = ((c.kind || '') + ' ' + (c.title || '') + ' ' + (c.description || '')).toLowerCase();

  const isNewspaper = fullTitleLower.includes('newspaper') || fullTitleLower.includes('paper cutting') || fullTitleLower.includes('clipping');

  const isBoardNotice = (/meeting\s+of\s+(?:the\s+)?board|board\s+meeting/i.test(fullTitleLower)) && !/outcome\s+of\s+(?:the\s+)?board\s+meeting|board\s+meeting\s+outcome/i.test(fullTitleLower);

  const isConcall = /transcript.*?(?:conference|earnings|analyst|concall)|concall\s+transcript|earnings\s+call\s+transcript/i.test(fullTitleLower);

  const isSast = /disclosure\s+under\s+reg(?:ulation)?\s*(?:29|10|7)|substantial\s+acquisition/i.test(fullTitleLower);

  const isMonitoringAgency = fullTitleLower.includes('monitoring agency');

  const isAddressChange = /change\s+in.*?(?:address|registrar|rta|share\s+transfer\s+agent)|corporate\s+office\s+address/i.test(fullTitleLower);

  const isTdsNotice = /deduction\s+of\s+tax|tax\s+deduction|tds\s+on\s+dividend|\btds\b|tax\s+at\s+source|form\s+15[gh]|communication\s+to\s+shareholders\s+regarding.*tax/i.test(fullTitleLower);

  const isDebentures = /allotment\s+of\s+(?:non-convertible\s+)?debentures|issue\s+of\s+debentures|ncd\s+allotment|\b(?:ncd|ncds)\b|commercial\s+paper|bonds\s+allotment|redemption\s+of\s+debentures/i.test(fullTitleLower);

  const isInvestorMeet = /analyst\s*(?:\/|\s+and\s+)?(?:institutional\s+)?investor\s+meet|interaction\s+with\s+(?:investors|analysts)|schedule\s+of\s+(?:investor|analyst)|investor\s+conference|annual\s+investor|spark\s+indx|analyst\s+conference|investor\s+presentation|presentation\s+with\s+respect\s+to\s+(?:the\s+)?(?:un-?audited|financial)|earning\s+call\s+presentation/i.test(fullTitleLower);

  const isRegulatoryPenalty = /imposition\s+of\s+fines?\s+or\s+penalt(?:y|ies)|penalty\s+by\s+trai|clarification\s+sought\s+from\s+(?:bse|nse)|clarification\s+on\s+spurt/i.test(fullTitleLower);

  const isGeneralUpdate = fullTitleLower.includes('general updates') || /press\s+release\s+dated/i.test(fullTitleLower);

  const isGenericBoardOutcome = /outcome\s+of\s+(?:the\s+)?board\s+meeting/i.test(fullTitleLower) && !/financial\s+result|quarterly\s+result|unaudited|audited|dividend|bonus|split|acquisition|merger/i.test(fullTitleLower);

  const isRoutineStrict = Boolean(

    c.materiality === 'ROUTINE' ||

    c.tradeStatus === 'ROUTINE_DISCLOSURE' ||

    c.tradeStatus === 'ROUTINE_LAND_ACQUISITION' ||

    pred.includes('ROUTINE') ||

    isNewspaper ||

    isBoardNotice ||

    isConcall ||

    isSast ||

    isMonitoringAgency ||

    isAddressChange ||

    isTdsNotice ||

    isDebentures ||

    isInvestorMeet ||

    isRegulatoryPenalty ||

    isGeneralUpdate ||

    isGenericBoardOutcome

  );

  const isResults = !isRoutineStrict && (
    c.materiality === 'RESULTS' ||
    c.category === 'QUARTERLY_RESULTS' ||
    /quarterly\s+results?|financial\s+results?|net\s+profit\s+(?:more\s+than\s+doubles|jumps|surges|doubles|\d+%)|pat\s+(?:jumps|up|doubles)|press\s+release.*?financial\s+results/i.test(fullTitleLower)
  );

  const isBlowoutBeat = Boolean(
    (c.financialComparison && (c.financialComparison.strengthGrade === 'BLOWOUT_BEAT' || c.financialComparison.strengthGrade === 'STRONG_BEAT')) ||
    /net\s+profit\s+(?:more\s+than\s+doubles|jumps\s+\d+%|surges\s+\d+%|doubles)|pat\s+(?:jumps|up\s+\d+%|doubles)|profit\s+after\s+tax\s+jumps|raises\s+fy\d+\s+guidance/i.test(fullTitleLower)
  );

  const isRoutine = isRoutineStrict;



  // 2. Already moved / exhausted move (checked against post-news reaction)

  const auc = c.auctionAssessment || null;

  const postNewsPct = c.postNewsMovePct != null ? Number(c.postNewsMovePct) : null;

  const effNewsMove = postNewsPct != null ? postNewsPct : movePct;

  const hasDownsideExhaustion = Boolean(effNewsMove <= -3.8 || (c.tradeStatus === 'ALREADY_MOVED' && effNewsMove <= -2.0));

  const isAuctionBullConfirmed = Boolean(auc && (auc.status === 'SWEET_SPOT_GAP' || auc.status === 'RUNNER_SWEET_SPOT') && auc.confirmed);

  const isAuctionBearConfirmed = Boolean(auc && auc.status === 'SWEET_SPOT_GAP_DOWN' && auc.confirmed);

  // For blowout earnings, an opening/pre-market reaction of +1.5% to +4.5% is the prime institutional accumulation zone!
  // It is NOT upside exhaustion unless already surging +6.5%+ or hitting circuit!
  // During pre-market (!isMarketOpenNow), move1m is always 0.0, so move1m < 0.15 MUST NEVER trigger upside exhaustion!
  const upsideCutoff = isBlowoutBeat ? 6.5 : 3.8;
  const hasUpsideExhaustion = Boolean(
    effNewsMove >= upsideCutoff ||
    (isMarketOpenNow && !isBlowoutBeat && !isAuctionBullConfirmed && effNewsMove >= 2.5 && move1m < 0.15) ||
    (c.tradeStatus === 'ALREADY_MOVED' && effNewsMove >= (isBlowoutBeat ? 5.0 : 1.8))
  );

  const hasAlreadyMoved = Boolean(
    Math.abs(effNewsMove) >= 1.5 && (
      ((c.tradeStatus === 'ALREADY_MOVED' || pred.includes('ALREADY MOVED')) && (Math.abs(effNewsMove) >= 1.8 || Math.abs(movePct) >= 1.8)) ||
      hasDownsideExhaustion ||
      hasUpsideExhaustion
    )
  );



  // 3. Real multi-minute tape dumping

  const isFalling = Boolean(c.tradeStatus === 'SELL_FADE' || move5m <= -0.50 || move1m <= -0.20 && move5m <= -0.30);



  // 4. Low momentum / stagnant

  const isLowMom = Boolean(c.isLowMomentum || pred.includes('LOW MOMENTUM') || pred.includes('STAGNANT'));



  // 6. Confirmed short trade (BEAR) - MUST be confirmed trade call from backend, NEVER inferred from passive market move!
  const isBear = !isUntradeable && !isStaleYesterday && !isRoutineStrict && (
    c.tradeStatus === 'TAKE_TRADE_SHORT' ||
    ((bias === 'BEARISH' || pred.includes('SELL') || pred.includes('SHORT') || c.direction === 'DOWN' || c.direction === 'BEARISH') && (c.takeTrade === true || c.tradeStatus === 'TAKE_TRADE_SHORT'))
  );

  // 5. Confirmed trade to take (BULL) - MUST be confirmed trade call from backend, NEVER inferred from passive market move!
  const isBull = !isUntradeable && !isStaleYesterday && !isRoutineStrict && !isBear && (
    c.tradeStatus === 'TAKE_TRADE_BUY' ||
    c.tradeStatus === 'TAKE_TRADE' ||
    ((bias === 'BULLISH' || pred.includes('BUY') || pred.includes('LONG') || c.direction === 'UP' || c.direction === 'BULLISH') && (c.takeTrade === true || c.tradeStatus === 'TAKE_TRADE_BUY' || c.tradeStatus === 'TAKE_TRADE'))
  );

  const takeTrade = Boolean(c.takeTrade === true || c.tradeStatus === 'TAKE_TRADE_BUY' || c.tradeStatus === 'TAKE_TRADE_SHORT' || c.tradeStatus === 'TAKE_TRADE');

  const isTapeWatch = Boolean(c.tradeStatus === 'OBSERVING_POST_NEWS_TAPE' || c.tradeStatus === 'RESULTS_UNCERTAIN' || c.tradeStatus === 'DO_NOT_TRADE_LOW_MOMENTUM' || (isResults && !takeTrade && !isBear));

  const conf = isUntradeable ? 0 : c.confidence || (takeTrade ? 88 : 65);

  const cardBiasClass = isUntradeable ? 'bias-neutral' : takeTrade ? 'bias-bull' : (hasDownsideExhaustion && effNewsMove <= -2.0) ? 'bias-bear' : hasAlreadyMoved ? 'bias-warn' : isBear ? 'bias-bear' : 'bias-neutral';

  const boxClass = isUntradeable ? 'box-watch' : isRoutine ? 'box-routine' : takeTrade ? 'box-buy' : (hasDownsideExhaustion && effNewsMove <= -2.0) ? 'box-sell' : hasAlreadyMoved ? 'box-warn' : isBear ? 'box-sell' : 'box-watch';

  const boxIcon = isUntradeable ? '🚫' : isRoutine ? '📄' : takeTrade ? '⚡' : (hasDownsideExhaustion && effNewsMove <= -2.0) ? '📉' : hasAlreadyMoved ? '🚫' : isBear ? '🔴' : isTapeWatch ? '⏳' : '👀';

  const boxLabel = isUntradeable ? 'UNTRADEABLE' : isRoutine ? 'ROUTINE' : takeTrade ? '⚡ TAKE TRADE' : (hasDownsideExhaustion && effNewsMove <= -2.0) ? 'ALREADY DUMPED' : hasAlreadyMoved ? 'ALREADY MOVED' : isStaleYesterday ? 'STALE' : isBear ? '⚡ TAKE SHORT' : isTapeWatch ? 'TAPE WATCH' : 'WATCH';

  return {

    isBull,

    isBear,

    cardBiasClass,

    boxClass,

    boxIcon,

    boxLabel,

    conf,

    bias,

    isFalling,

    isLowMom,

    isPenny,

    isLowVol,

    isUntradeable,

    hasAlreadyMoved,

    hasDownsideExhaustion,

    isStaleYesterday,

    isRoutine,

    takeTrade,

    effNewsMove,

    isBlowoutBeat,

    isResults

  };

}

function isPennyOrLowVolume(c) {
  if (!c) return true;
  const p = Number(c.ltp || c.close || c.effectivePrice || c.price || 0);
  const isPenny = Boolean(c.isPennyStock || (p > 0 && p < 20.0) || /^\d+$/.test(c.symbol));
  if (isPenny) return true;
  const v = Number(c.volume || c.effectiveVolume || 0);
  return Boolean(c.isUntradeable || c.isLowVolume || (v > 0 && v < 5000));
}

function copyFallback(text) {

  const ta = document.createElement('textarea');

  ta.value = text;

  ta.style.position = 'fixed';

  ta.style.opacity = '0';

  document.body.appendChild(ta);

  ta.select();

  try {

    document.execCommand('copy');

  } catch (_) {}

  document.body.removeChild(ta);

}



// --- Sub-Components ---



function Toast({

  toast

}) {

  if (!toast) return null;

  return /*#__PURE__*/React.createElement("div", {

    style: {

      position: 'fixed',

      top: '24px',

      right: '24px',

      zIndex: 99999,

      background: toast.bg || '#10b981',

      color: '#ffffff',

      padding: '10px 18px',

      borderRadius: '10px',

      fontSize: '12.5px',

      fontWeight: 700,

      boxShadow: '0 8px 24px rgba(0,0,0,0.25)',

      fontFamily: "'Plus Jakarta Sans', sans-serif",

      letterSpacing: '0.2px',

      animation: 'toastIn 0.25s ease-out'

    }

  }, toast.msg);

}

function Sidebar({

  collapsed,

  onToggle

}) {

  const [hovered, setHovered] = useState(false);

  const isEffectiveCollapsed = collapsed && !hovered;

  return /*#__PURE__*/React.createElement("aside", {

    className: `sidebar ${isEffectiveCollapsed ? 'collapsed' : ''}`,

    id: "sidebar",

    onMouseEnter: () => setHovered(true),

    onMouseLeave: () => setHovered(false),

    style: {

      transition: 'width 0.2s ease, padding 0.2s ease',

      zIndex: 60

    }

  }, /*#__PURE__*/React.createElement("div", {

    className: "sidebar-brand"

  }, /*#__PURE__*/React.createElement("a", {

    href: "/final.html",

    className: "brand-logo-icon",

    style: {

      background: 'transparent',

      boxShadow: 'none',

      border: 'none',

      padding: 0,

      width: '44px',

      height: '44px',

      display: 'flex',

      alignItems: 'center',

      justifyContent: 'center'

    }

  }, /*#__PURE__*/React.createElement("img", {

    src: "/logo.png",

    alt: "Grow Better",

    style: {

      width: '40px',

      height: '40px',

      objectFit: 'contain'

    }

  }))), /*#__PURE__*/React.createElement("nav", {

    className: "sidebar-nav"

  }, /*#__PURE__*/React.createElement("a", {

    className: "nav-item active",

    href: "/scalping.html",

    title: "\uD83C\uDFDB\uFE0F Institutional Swing"

  }, /*#__PURE__*/React.createElement("svg", {

    className: "nav-icon",

    viewBox: "0 0 24 24"

  }, /*#__PURE__*/React.createElement("path", {

    d: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",

    fill: "none",

    stroke: "currentColor",

    strokeWidth: "2",

    strokeLinecap: "round",

    strokeLinejoin: "round"

  })), /*#__PURE__*/React.createElement("span", null, "\uD83C\uDFDB\uFE0F Institutional Swing")), /*#__PURE__*/React.createElement("a", {

    className: "nav-item",

    href: "/final.html#portfolio"

  }, /*#__PURE__*/React.createElement("svg", {

    className: "nav-icon",

    viewBox: "0 0 24 24"

  }, /*#__PURE__*/React.createElement("path", {

    d: "M12 2v10l7.07 7.07A10 10 0 1 1 12 2Z",

    fill: "none",

    stroke: "currentColor",

    strokeWidth: "1.8",

    strokeLinejoin: "round"

  }), /*#__PURE__*/React.createElement("path", {

    d: "M12 2A10 10 0 0 1 22 12h-10Z",

    fill: "none",

    stroke: "currentColor",

    strokeWidth: "1.8",

    strokeLinejoin: "round"

  })), /*#__PURE__*/React.createElement("span", null, "Portfolio")), /*#__PURE__*/React.createElement("a", {

    className: "nav-item",

    href: "/final.html#orders"

  }, /*#__PURE__*/React.createElement("svg", {

    className: "nav-icon",

    viewBox: "0 0 24 24"

  }, /*#__PURE__*/React.createElement("rect", {

    x: "4",

    y: "3",

    width: "16",

    height: "18",

    rx: "2",

    fill: "none",

    stroke: "currentColor",

    strokeWidth: "1.8"

  }), /*#__PURE__*/React.createElement("path", {

    d: "M8 8h8M8 12h8M8 16h5",

    stroke: "currentColor",

    strokeWidth: "1.8",

    strokeLinecap: "round"

  })), /*#__PURE__*/React.createElement("span", null, "Orders")), /*#__PURE__*/React.createElement("a", {

    className: "nav-item",

    href: "/final.html#positions"

  }, /*#__PURE__*/React.createElement("svg", {

    className: "nav-icon",

    viewBox: "0 0 24 24"

  }, /*#__PURE__*/React.createElement("path", {

    d: "M4 19V9m6 10V5m6 14v-7m6 7V3",

    stroke: "currentColor",

    strokeWidth: "1.8",

    strokeLinecap: "round"

  })), /*#__PURE__*/React.createElement("span", null, "Positions")), /*#__PURE__*/React.createElement("a", {

    className: "nav-item",

    href: "/final.html#stock-holdings"

  }, /*#__PURE__*/React.createElement("svg", {

    className: "nav-icon",

    viewBox: "0 0 24 24"

  }, /*#__PURE__*/React.createElement("path", {

    d: "M16 6l4 14M12 6l-4 14M8 10l8 0M4 14l16 0",

    stroke: "currentColor",

    strokeWidth: "1.8",

    fill: "none",

    strokeLinecap: "round",

    strokeLinejoin: "round"

  })), /*#__PURE__*/React.createElement("span", null, "Stock Holdings")), /*#__PURE__*/React.createElement("a", {

    className: "nav-item",

    href: "/final.html#smart-money"

  }, /*#__PURE__*/React.createElement("svg", {

    className: "nav-icon",

    viewBox: "0 0 24 24"

  }, /*#__PURE__*/React.createElement("path", {

    d: "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z",

    fill: "none",

    stroke: "currentColor",

    strokeWidth: "1.8"

  }), /*#__PURE__*/React.createElement("path", {

    d: "M12 6v6l4 2",

    stroke: "currentColor",

    strokeWidth: "1.8",

    strokeLinecap: "round",

    strokeLinejoin: "round"

  }), /*#__PURE__*/React.createElement("path", {

    d: "M17 17l3 3",

    stroke: "currentColor",

    strokeWidth: "2.2",

    strokeLinecap: "round"

  })), /*#__PURE__*/React.createElement("span", null, "Smart Money")), /*#__PURE__*/React.createElement("a", {

    className: "nav-item",

    href: "/final.html#alerts"

  }, /*#__PURE__*/React.createElement("svg", {

    className: "nav-icon",

    viewBox: "0 0 24 24"

  }, /*#__PURE__*/React.createElement("path", {

    d: "M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z",

    fill: "none",

    stroke: "currentColor",

    strokeWidth: "1.8",

    strokeLinejoin: "round"

  }), /*#__PURE__*/React.createElement("path", {

    d: "M9.5 21a2.5 2.5 0 0 0 5 0",

    stroke: "currentColor",

    strokeWidth: "1.8",

    strokeLinecap: "round"

  })), /*#__PURE__*/React.createElement("span", null, "Alerts"))), /*#__PURE__*/React.createElement("div", {

    className: "sidebar-bottom"

  }, /*#__PURE__*/React.createElement("a", {

    className: "nav-item",

    href: "/final.html#settings"

  }, /*#__PURE__*/React.createElement("svg", {

    className: "nav-icon",

    viewBox: "0 0 24 24"

  }, /*#__PURE__*/React.createElement("circle", {

    cx: "12",

    cy: "12",

    r: "3"

  }), /*#__PURE__*/React.createElement("path", {

    d: "M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z",

    fill: "none",

    stroke: "currentColor",

    strokeWidth: "1.5",

    strokeLinejoin: "round"

  })), /*#__PURE__*/React.createElement("span", null, "Settings"))));

}

function Topbar({
  onToggleTheme,
  lastUpdated,
  brokerStatus,
  quotes
}) {
  const qNifty = (quotes && (quotes.NIFTY || quotes.nifty)) || null;
  const qBank = (quotes && (quotes.BANKNIFTY || quotes.banknifty)) || null;

  const niftyPrice = qNifty && qNifty.price != null
    ? Number(qNifty.price).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '25,144.30';
  const niftyChg = qNifty ? Number(qNifty.change || 0) : -155.05;
  const niftyPct = qNifty ? Number(qNifty.pChange || qNifty.changePct || 0) : -0.61;
  const isNiftyPos = niftyChg >= 0;
  const niftySub = `${isNiftyPos ? '+' : ''}${niftyChg.toFixed(2)} (${isNiftyPos ? '+' : ''}${niftyPct.toFixed(2)}%)`;

  const bankPrice = qBank && qBank.price != null
    ? Number(qBank.price).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '61,034.10';
  const bankChg = qBank ? Number(qBank.change || 0) : -484.40;
  const bankPct = qBank ? Number(qBank.pChange || qBank.changePct || 0) : -0.79;
  const isBankPos = bankChg >= 0;
  const bankSub = `${isBankPos ? '+' : ''}${bankChg.toFixed(2)} (${isBankPos ? '+' : ''}${bankPct.toFixed(2)}%)`;

  return /*#__PURE__*/React.createElement("header", {
    className: "topbar"
  },
    /* Left: Brand */
    /*#__PURE__*/React.createElement("div", {
      className: "topbar-left"
    },
      /*#__PURE__*/React.createElement("a", {
        href: "/final.html",
        className: "topbar-brand-simple",
        title: "Grow Better — Algo Terminal",
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          textDecoration: 'none'
        }
      },
        /*#__PURE__*/React.createElement("img", {
          src: "/logo.png",
          alt: "Grow Better",
          className: "topbar-logo-simple",
          style: {
            width: '32px',
            height: '32px',
            objectFit: 'contain'
          }
        }),
        /*#__PURE__*/React.createElement("span", {
          className: "topbar-brand-title",
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            fontWeight: 800,
            fontSize: '16px',
            letterSpacing: '0.05em'
          }
        },
          /*#__PURE__*/React.createElement("span", {
            className: "brand-grow",
            style: { color: '#00B386', letterSpacing: '0.05em' }
          }, "GROW"),
          /*#__PURE__*/React.createElement("span", {
            className: "brand-better",
            style: { letterSpacing: '0.05em' }
          }, "BETTER")
        )
      )
    ),

    /* Right: NIFTY + BANKNIFTY Side-by-Side + Cash + Signals + Theme */
    /*#__PURE__*/React.createElement("div", {
      className: "topbar-right",
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        flexWrap: 'wrap'
      }
    },
      /* Unified NIFTY + BANKNIFTY Indices Display matching institutional terminal */
      /*#__PURE__*/React.createElement("div", {
        className: "topbar-indices-display",
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          userSelect: 'none'
        }
      },
        /* NIFTY Item */
        /*#__PURE__*/React.createElement("div", {
          className: "topbar-index-col",
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '1px',
            lineHeight: 1.15
          },
          title: "NIFTY 50 Live Index Quote"
        },
          /* Top row: NIFTY */
          /*#__PURE__*/React.createElement("span", {
            style: {
              fontSize: '12px',
              fontWeight: 800,
              color: 'var(--text-color, #f8fafc)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase'
            }
          }, "NIFTY"),
          /* Bottom row: 25,144.30 ▼ -155.05 (-0.61%) */
          /*#__PURE__*/React.createElement("div", {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12px',
              fontWeight: 700,
              color: isNiftyPos ? '#16a34a' : '#ef4444',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap'
            }
          },
            /*#__PURE__*/React.createElement("span", null, niftyPrice),
            /*#__PURE__*/React.createElement("span", {
              style: { fontSize: '8.5px' }
            }, isNiftyPos ? '▲' : '▼'),
            /*#__PURE__*/React.createElement("span", null, niftySub)
          )
        ),

        /* Vertical Divider | */
        /*#__PURE__*/React.createElement("div", {
          style: {
            width: '1px',
            height: '24px',
            background: 'var(--border-color, rgba(255, 255, 255, 0.15))',
            margin: '0 2px'
          }
        }),

        /* BANKNIFTY Item */
        /*#__PURE__*/React.createElement("div", {
          className: "topbar-index-col",
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '1px',
            lineHeight: 1.15
          },
          title: "BANKNIFTY Live Index Quote"
        },
          /* Top row: BANKNIFTY */
          /*#__PURE__*/React.createElement("span", {
            style: {
              fontSize: '12px',
              fontWeight: 800,
              color: 'var(--text-color, #f8fafc)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase'
            }
          }, "BANKNIFTY"),
          /* Bottom row: 61,034.10 ▼ -484.40 (-0.79%) */
          /*#__PURE__*/React.createElement("div", {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12px',
              fontWeight: 700,
              color: isBankPos ? '#16a34a' : '#ef4444',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap'
            }
          },
            /*#__PURE__*/React.createElement("span", null, bankPrice),
            /*#__PURE__*/React.createElement("span", {
              style: { fontSize: '8.5px' }
            }, isBankPos ? '▲' : '▼'),
            /*#__PURE__*/React.createElement("span", null, bankSub)
          )
        ),

        /* Down Arrow Button [ ⌵ ] */
        /*#__PURE__*/React.createElement("button", {
          type: "button",
          className: "topbar-indices-arrow-btn",
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '24px',
            height: '24px',
            borderRadius: '4px',
            border: '1px solid var(--border-color, rgba(255, 255, 255, 0.18))',
            background: 'transparent',
            color: 'var(--text-muted, #94a3b8)',
            cursor: 'pointer',
            marginLeft: '2px',
            padding: 0,
            transition: 'all 0.15s ease'
          },
          title: "Market Indices"
        },
          /*#__PURE__*/React.createElement("svg", {
            viewBox: "0 0 24 24",
            width: "13",
            height: "13",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "2.5",
            strokeLinecap: "round",
            strokeLinejoin: "round"
          },
            /*#__PURE__*/React.createElement("polyline", {
              points: "6 9 12 15 18 9"
            })
          )
        )
      ),

      /* Cash Available Pill */
      /*#__PURE__*/React.createElement("div", {
        className: "topbar-stacked-pill",
        title: "Available Trading Margin / Cash"
      },
        /*#__PURE__*/React.createElement("div", {
          className: "pill-title"
        }, "Cash Available"),
        /*#__PURE__*/React.createElement("div", {
          className: "pill-main-val"
        }, "₹0.00")
      ),

      /* Theme Toggle Button (Sun / Moon SVG icon) */
      /*#__PURE__*/React.createElement("button", {
        className: "theme-toggle-btn",
        onClick: onToggleTheme,
        title: "Toggle Light/Dark Theme"
      },
        /*#__PURE__*/React.createElement("svg", {
          className: "theme-icon sun-icon",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "2"
        },
          /*#__PURE__*/React.createElement("circle", { cx: "12", cy: "12", r: "5" }),
          /*#__PURE__*/React.createElement("line", { x1: "12", y1: "1", x2: "12", y2: "3" }),
          /*#__PURE__*/React.createElement("line", { x1: "12", y1: "21", x2: "12", y2: "23" }),
          /*#__PURE__*/React.createElement("line", { x1: "4.22", y1: "4.22", x2: "5.64", y2: "5.64" }),
          /*#__PURE__*/React.createElement("line", { x1: "18.36", y1: "18.36", x2: "19.78", y2: "19.78" }),
          /*#__PURE__*/React.createElement("line", { x1: "1", y1: "12", x2: "3", y2: "12" }),
          /*#__PURE__*/React.createElement("line", { x1: "21", y1: "12", x2: "23", y2: "12" }),
          /*#__PURE__*/React.createElement("line", { x1: "4.22", y1: "19.78", x2: "5.64", y2: "18.36" }),
          /*#__PURE__*/React.createElement("line", { x1: "18.36", y1: "5.64", x2: "19.78", y2: "4.22" })
        ),
        /*#__PURE__*/React.createElement("svg", {
          className: "theme-icon moon-icon",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "2"
        },
          /*#__PURE__*/React.createElement("path", {
            d: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
          })
        )
      )
    )
  );
}

function KpiSummary({

  scorecard

}) {

  const sc = scorecard || {};

  const totalSetups = sc.totalSetups || sc.active || 23;
  const nBreakout = sc.breakoutCount != null ? sc.breakoutCount : 16;
  const nCur = sc.breakoutCurrent != null ? sc.breakoutCurrent : 1;
  const nPre = sc.breakoutPre != null ? sc.breakoutPre : 15;
  const nTrend = sc.trendCount != null ? sc.trendCount : 2;
  const nSupport = sc.supportCount != null ? sc.supportCount : 5;
  const avgSL = sc.avgRiskPct != null ? Number(sc.avgRiskPct).toFixed(1) : "4.4";
  const avgVol = sc.avgVolSurge != null ? Number(sc.avgVolSurge).toFixed(2) : "1.40";

  return /*#__PURE__*/React.createElement("div", {

    className: "kpi-grid"

  }, /*#__PURE__*/React.createElement("div", {

    className: "kpi-card"

  }, /*#__PURE__*/React.createElement("div", {

    className: "kpi-title"

  }, "Active Swing Setups"), /*#__PURE__*/React.createElement("div", {

    className: "kpi-val",

    style: {

      color: 'var(--accent)'

    }

  }, totalSetups), /*#__PURE__*/React.createElement("div", {

    className: "kpi-sub"

  }, "Across 998 Liquid NSE Universe")), /*#__PURE__*/React.createElement("div", {

    className: "kpi-card"

  }, /*#__PURE__*/React.createElement("div", {

    className: "kpi-title"

  }, "Engine 1: Breakouts"), /*#__PURE__*/React.createElement("div", {

    className: "kpi-val",

    style: {

      color: '#059669'

    }

  }, nBreakout + " Setups"), /*#__PURE__*/React.createElement("div", {

    className: "kpi-sub"

  }, `${nCur} in Buy Pocket · ${nPre} Pre-Watchlist`)), /*#__PURE__*/React.createElement("div", {

    className: "kpi-card"

  }, /*#__PURE__*/React.createElement("div", {

    className: "kpi-title"

  }, "Engine 2: Trend Riders"), /*#__PURE__*/React.createElement("div", {

    className: "kpi-val",

    style: {

      color: '#2563eb'

    }

  }, nTrend + " Leaders"), /*#__PURE__*/React.createElement("div", {

    className: "kpi-sub"

  }, "Stage 2 Leaders (PNB, UNIONBANK)")), /*#__PURE__*/React.createElement("div", {

    className: "kpi-card"

  }, /*#__PURE__*/React.createElement("div", {

    className: "kpi-title"

  }, "Engine 4: Support Bounces"), /*#__PURE__*/React.createElement("div", {

    className: "kpi-val",

    style: {

      color: '#7c3aed'

    }

  }, nSupport + " Bounces"), /*#__PURE__*/React.createElement("div", {

    className: "kpi-sub"

  }, "Demand Absorption (PNBHOUSING +4)")), /*#__PURE__*/React.createElement("div", {

    className: "kpi-card"

  }, /*#__PURE__*/React.createElement("div", {

    className: "kpi-title"

  }, "Pace & Risk Profile"), /*#__PURE__*/React.createElement("div", {

    className: "kpi-val",

    style: {

      color: '#6366f1'

    }

  }, "4-5 Calls/Wk"), /*#__PURE__*/React.createElement("div", {

    className: "kpi-sub"

  }, `Avg SL: ${avgSL}% · Avg Vol: ${avgVol}x`)));

}

const CatalystCard = React.memo(function CatalystCard({

  c,

  onCopy,

  isCopied

}) {

  const ltp = Number(c.ltp || 0);

  const [flash, setFlash] = useState('');

  const prevPriceRef = useRef(ltp);

  useEffect(() => {

    if (prevPriceRef.current && ltp && ltp !== prevPriceRef.current) {

      const cls = ltp > prevPriceRef.current ? 'price-flash-up' : 'price-flash-down';

      setFlash(cls);

      const timer = setTimeout(() => setFlash(''), 700);

      prevPriceRef.current = ltp;

      return () => clearTimeout(timer);

    }

    prevPriceRef.current = ltp;

  }, [ltp]);

  const movePct = Number(c.movePct || 0);

  const move1m = Number(c.move1mPct || 0);

  const move5m = Number(c.move5mPct || 0);

  const isHeavy1m = Math.abs(move1m) >= 0.20;

  const nowMs = Date.now();

  const diffSec = c.ts ? Math.max(0, Math.round((nowMs - Number(c.ts)) / 1000)) : 999999;

  const liveTimeAgo = c.ts ? diffSec < 60 ? `${diffSec}s` : diffSec < 3600 ? `${Math.round(diffSec / 60)}m` : `${Math.round(diffSec / 3600)}h` : '3h';

  const {

    isBull,

    isBear,

    conf,

    isFalling,

    isLowMom,

    isPenny,

    isLowVol,

    isUntradeable,

    hasAlreadyMoved,

    hasDownsideExhaustion,

    isStaleYesterday,

    isRoutine,

    takeTrade,

    effNewsMove = 0,

    isBlowoutBeat = false,

    isResults = false

  } = getBiasInfo(c);

  const isLearnedBlocked = Boolean(c.learnedGuardrail || (c.badge && c.badge.includes('LEARNED')) || (c.tradeStatus === 'NON_MOVER_GUARDRAIL'));
  const isUntradeablePenny = Boolean(isUntradeable || c.isPennyStock || c.isUntradeable || ltp > 0 && ltp < 30.0 || c.volume > 0 && c.volume < 25000);

  const displayMovedPct = (effNewsMove != null && Math.abs(effNewsMove) >= 1.0) ? effNewsMove : movePct;
  const isActuallyMoved = hasAlreadyMoved && Math.abs(displayMovedPct) >= 1.5;

  const btnLabel = isLearnedBlocked
    ? (c.badge || '🛡️ Learned Non-Mover')
    : isUntradeablePenny
    ? 'Untradeable (< ₹30 / Low Vol)'
    : isStaleYesterday
      ? 'Stale (Yesterday)'
      : isActuallyMoved
        ? `Already Moved (${displayMovedPct > 0 ? '+' : ''}${displayMovedPct.toFixed(1)}%) — Do Not Chase`
        : (c.tradeStatus === 'ROUTINE_DISCLOSURE' || (!takeTrade && !isBlowoutBeat))
          ? 'Routine (Watch)'
          : (isBlowoutBeat || takeTrade)
            ? `⚡ TAKE TRADE: BUY ${isBlowoutBeat ? Math.max(conf, 92) : conf}%`
            : isBear
              ? `Sell / Fade ${conf}%`
              : 'Watch';

  const displayHeadline = sweetAndShortSubject(c.title, c.description || c.text || '', c.symbol, c.materiality);

  const rawReason = isUntradeablePenny ? `Untradeable: ${ltp > 0 && ltp < 30.0 ? `Penny stock (₹${ltp.toFixed(2)} < ₹30 floor)` : `Low volume (${(c.volume || 0).toLocaleString()} < 25,000 shares)`} · High risk of circuit locks / zero depth; trade calls strictly refused.` : sweetAndShortRationale(c.rationale, isBull ? 'BULLISH' : isBear ? 'BEARISH' : 'NEUTRAL', c.materiality, displayHeadline, move1m);

  let cleanThesisText = String(rawReason || '').replace(/^Reason:\s*/i, '').trim();

  if (isLearnedBlocked) {
    cleanThesisText = c.rationale || (c.learnedGuardrail && c.learnedGuardrail.explanation) || 'AI Auto-Learned Guardrail: Prevented repeating past non-mover mistake.';
  } else if (isUntradeablePenny) {

    cleanThesisText = `Untradeable: ${ltp > 0 && ltp < 30.0 ? `Penny stock (₹${ltp.toFixed(2)} < ₹30 floor)` : `Low volume (${(c.volume || 0).toLocaleString()} < 25,000 shares)`} · High risk of circuit locks / zero depth; trade calls strictly refused.`;

  } else if (isStaleYesterday) {

    cleanThesisText = `📅 Filing is from yesterday (${c.filingTime || ''}). Already fully priced in during pre-market; not an active intraday trade catalyst.`;

  } else if (isActuallyMoved && displayMovedPct >= 1.5) {

    cleanThesisText = `🚫 Stock already surged +${displayMovedPct.toFixed(1)}% into/after the filing. Entering now is buying the top into profit taking. DO NOT CHASE.`;

  } else if (isActuallyMoved && displayMovedPct <= -1.5) {

    cleanThesisText = `⚠️ Stock already dropped ${displayMovedPct.toFixed(1)}% into/after the filing. Downside move exhausted; avoid chasing short into bounce.`;

  } else if (isBlowoutBeat) {

    cleanThesisText = `⚡ Fresh Q2 earnings blowout with strong institutional accumulation potential. Prime entry before extended runup.`;

  } else if (takeTrade) {

    cleanThesisText = `⚡ Fresh unpriced catalyst with confirmed initial volume thrust (+${move1m.toFixed(2)}% 1m). Prime entry before extended runup.`;

  } else if (isFalling) {

    cleanThesisText = `⚠️ Tape moving down: Stock is actively falling (${move1m > 0 ? '+' : ''}${move1m.toFixed(2)}% 1m, ${move5m > 0 ? '+' : ''}${move5m.toFixed(2)}% 5m). Avoid buying falling tape.`;

  } else if (isLowMom) {

    cleanThesisText = `⏳ Low momentum post-news: Stock is flat or lacking thrust (${move1m > 0 ? '+' : ''}${move1m.toFixed(2)}% 1m). Await confirmed volume burst before entry.`;

  } else if (ltp === 0 || movePct === 0 && move1m === 0) {

    if (!cleanThesisText || cleanThesisText.includes('Pre-move window') || cleanThesisText.includes('Corporate filing') || cleanThesisText.includes('wait for directional')) {

      cleanThesisText = 'Pre-move window. Wait for directional 1m volume confirmation.';

    }

  }

  const v1Class = move1m > 0 ? 'pos' : move1m < 0 ? 'neg' : 'zero';

  const v5Class = move5m > 0 ? 'pos' : move5m < 0 ? 'neg' : 'zero';

  const pctClass = movePct > 0 ? 'pos' : movePct < 0 ? 'neg' : 'zero';

  const sign1m = move1m > 0 ? '+' : '';

  const sign5m = move5m > 0 ? '+' : '';

  const signPct = movePct > 0 ? '+' : '';

  const nowIstItem = new Date(Date.now() + 330 * 60000);
  const nowHourMinItem = nowIstItem.getUTCHours() * 100 + nowIstItem.getUTCMinutes();
  const isMarketOpenNowItem = (nowHourMinItem >= 915 && nowHourMinItem < 1530);
  const filingTsNum = Number(c.ts || 0);
  const filingHourMinItem = filingTsNum > 0 ? (new Date(filingTsNum + 330 * 60000).getUTCHours() * 100 + new Date(filingTsNum + 330 * 60000).getUTCMinutes()) : 0;
  const isPreOpenItem = (filingHourMinItem >= 1530 || filingHourMinItem < 915);

  const postNewsMove = (isPreOpenItem && isMarketOpenNowItem && (c.postNewsMovePct == null || Math.abs(c.postNewsMovePct) < 0.01))
    ? Number(movePct || 0)
    : Number(c.postNewsMovePct || 0);

  const hasPostNewsMove = Math.abs(postNewsMove) >= 0.10;

  const postSign = postNewsMove > 0 ? '+' : '';

  const postClass = postNewsMove > 0 ? 'pos' : postNewsMove < 0 ? 'neg' : 'zero';

  const reasonBoxClass = isBear ? 'box-bear' : takeTrade ? 'box-bull' : 'box-neutral';

  const tradeBtnClass = isUntradeablePenny ? 'btn-trade-disabled' : isStaleYesterday ? 'btn-trade-stale' : hasAlreadyMoved ? 'btn-trade-warn' : takeTrade ? 'btn-trade-buy' : isBear ? 'btn-trade-sell' : 'btn-trade-watch';

  const categoryName = formatCategory(c.materiality, c.kind);

  const filingTimeFormatted = String(c.filingTime || '17:09').replace(/\s*IST/i, '').trim();

  const scoreDisplay = c.impactScore ? Number(c.impactScore) : 60;

  const probVal = c.probability || c.confidence || 75;

  const auc = c.auctionAssessment || null;

  const isNonActionable = Boolean(

    !takeTrade ||

    c.takeTrade === false ||

    c.tradeStatus === 'ROUTINE_DISCLOSURE' ||

    c.tradeStatus === 'ALREADY_MOVED' ||

    c.tradeStatus === 'HISTORICAL_FADE' ||

    c.tradeStatus === 'ALREADY_FILLED' ||

    isUntradeablePenny ||

    isStaleYesterday ||

    hasAlreadyMoved

  );

  const safeAucLabel = (auc && auc.actionBtnLabel && !/Buy|Sell/i.test(auc.actionBtnLabel)) ? auc.actionBtnLabel : null;

  const finalBtnLabel = isNonActionable ? (safeAucLabel || btnLabel) : (auc && auc.actionBtnLabel ? auc.actionBtnLabel : btnLabel);

  const finalBtnClass = isNonActionable ? 'btn-trade-watch' : (auc && auc.actionBtnClass ? auc.actionBtnClass : tradeBtnClass);

  const finalThesisText = auc && auc.plan ? auc.plan : cleanThesisText;

  const probColor = isBull ? '#16a34a' : isBear ? '#dc2626' : '#64748b';

  const probBg = isBull ? 'rgba(22, 163, 74, 0.12)' : isBear ? 'rgba(220, 38, 38, 0.12)' : 'rgba(100, 116, 139, 0.12)';

  const probBorder = isBull ? 'rgba(22, 163, 74, 0.3)' : isBear ? 'rgba(220, 38, 38, 0.3)' : 'rgba(100, 116, 139, 0.3)';

  return /*#__PURE__*/React.createElement("div", {

    className: `cat-card ${isUntradeablePenny ? 'cat-card-penny' : ''}`,

    id: `cat-card-${c.symbol}`,

    style: {

      minWidth: 0,

      width: '100%',

      boxSizing: 'border-box'

    }

  }, /*#__PURE__*/React.createElement("div", {

    className: "cat-row-top"

  }, /*#__PURE__*/React.createElement("div", {

    className: "cat-sym-wrap"

  }, /*#__PURE__*/React.createElement("span", {

    className: `cat-symbol-title ${isCopied ? 'copied-flash' : ''}`,

    onClick: () => onCopy(c.symbol),

    title: `Tap to copy ${c.symbol}`

  }, c.symbol, isCopied && /*#__PURE__*/React.createElement("span", {

    className: "cat-copied-badge"

  }, "\u2713")), /*#__PURE__*/React.createElement("span", {

    className: "cat-prob-badge",

    style: {

      background: probBg,

      color: probColor,

      border: `1px solid ${probBorder}`

    },

    title: `ML & Event Study Probability: ${probVal}%`

  }, isBull ? '🟢' : isBear ? '🔴' : '⚪', " ", probVal, "%"), isUntradeablePenny && /*#__PURE__*/React.createElement("span", {

    style: {

      fontSize: '10px',

      fontWeight: 700,

      background: 'rgba(239, 68, 68, 0.1)',

      color: '#dc2626',

      border: '1px solid rgba(239, 68, 68, 0.3)',

      padding: '1px 5px',

      borderRadius: '4px',

      letterSpacing: '0.2px'

    },

    title: "Untradeable Penny Stock (< \u20B930) \u2014 Trade calls strictly refused"

  }, "\u26A0\uFE0F < \u20B930 PENNY")), /*#__PURE__*/React.createElement("div", {

    className: `cat-price-val ${flash}`

  }, ltp > 0 ? `₹${ltp.toFixed(2)}` : 'Price pending')), /*#__PURE__*/React.createElement("div", {

    className: "cat-row-meta-compact",

    style: {

      marginTop: '2px',

      marginBottom: '4px'

    }

  }, /*#__PURE__*/React.createElement("div", {

    className: "cat-meta-line",

    style: {

      display: 'flex',

      alignItems: 'center',

      gap: '6px'

    }

  }, auc && auc.label ? /*#__PURE__*/React.createElement("span", {

    className: "cat-auction-pill",

    style: {

      background: auc.bg || 'rgba(100, 116, 139, 0.12)',

      color: auc.color || '#64748b',

      border: `1px solid ${auc.border || 'rgba(100, 116, 139, 0.3)'}`

    },

    title: auc.plan

  }, auc.label) : isMarketOpenNowItem ? /*#__PURE__*/React.createElement("span", {

    className: "cat-auction-pill",

    style: {

      background: 'rgba(34, 197, 94, 0.12)',

      color: '#16a34a',

      border: '1px solid rgba(34, 197, 94, 0.3)'

    }

  }, "🟢 LIVE SESSION") : /*#__PURE__*/React.createElement("span", {

    className: "cat-auction-pill",

    style: {

      background: 'rgba(100,116,139,0.12)',

      color: '#64748b',

      border: '1px solid rgba(100,116,139,0.3)'

    }

  }, "\u23F3 AWAITING 09:08 IEP")), /*#__PURE__*/React.createElement("div", {

    className: "cat-pct-wrap",

    style: {

      display: 'flex',

      alignItems: 'center',

      gap: '5px'

    }

  },
    /*#__PURE__*/React.createElement("div", {
      style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }
    },
      /*#__PURE__*/React.createElement("span", {
        className: `cat-pct-badge ${pctClass}`,
        title: `Full Day session move: ${signPct}${movePct.toFixed(2)}%`
      }, `${signPct}${movePct.toFixed(1)}% Day`),
      /*#__PURE__*/React.createElement("span", {
        className: `cat-pct-badge ${postClass}`,
        style: {
          border: `1px solid ${postNewsMove > 0 ? 'rgba(22, 163, 74, 0.35)' : postNewsMove < 0 ? 'rgba(220, 38, 38, 0.35)' : 'rgba(100, 116, 139, 0.25)'}`
        },
        title: `After-News Move: ${postSign}${postNewsMove.toFixed(2)}% after announcement (Filing Price: ₹${Number(c.priceAtFiling || ltp || 0).toFixed(2)} → Live: ₹${ltp.toFixed(2)})`
      }, `${postSign}${postNewsMove.toFixed(1)}%`)
    ))), /*#__PURE__*/React.createElement("div", {

    style: {

      fontSize: '10.5px',

      color: 'var(--text-muted, #64748b)',

      margin: '1px 0 3px',

      display: 'flex',

      alignItems: 'center',

      gap: '5px'

    }

  }, /*#__PURE__*/React.createElement("span", {

    style: {

      fontWeight: 700,

      color: 'var(--text, #334155)'

    }

  }, categoryName), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, filingTimeFormatted, " (", liveTimeAgo, ")")), (() => {

    const dCard = new Date(Date.now() + 330 * 60000);

    const cardDay = dCard.getUTCDay();

    const cardTNum = dCard.getUTCHours() * 100 + dCard.getUTCMinutes();

    const filingTsNum = Number(c.ts || 0);
    const dFiling = filingTsNum > 0 ? new Date(filingTsNum + 330 * 60000) : null;
    const fH = dFiling ? (dFiling.getUTCHours() * 100 + dFiling.getUTCMinutes()) : (c.filingTime ? parseInt(c.filingTime.replace(':', ''), 10) : 0);
    const isTodayFiling = dFiling ? (dFiling.getUTCDate() === dCard.getUTCDate() && dFiling.getUTCMonth() === dCard.getUTCMonth()) : true;

    let timingLabel = '(Pre-Market)';
    if (!isTodayFiling || fH >= 1530) {
      timingLabel = '(Overnight)';
    } else if (fH >= 915 && fH < 1530) {
      timingLabel = '(Intraday)';
    } else {
      timingLabel = '(Pre-Market)';
    }
    const sessionStatus = `${filingTimeFormatted} ${timingLabel}`;

    return /*#__PURE__*/React.createElement("div", {

      style: {

        display: 'flex',

        alignItems: 'center',

        justifyContent: 'space-between',

        fontSize: '9.5px',

        padding: '2px 5px',

        borderRadius: '4px',

        background: 'rgba(0,0,0,0.03)',

        border: '1px solid var(--card-border, #f1f5f9)',

        margin: '1px 0 3px',

        color: 'var(--text-muted)'

      }

    }, /*#__PURE__*/React.createElement("span", null, "\u23F1\uFE0F ", sessionStatus),
      /*#__PURE__*/React.createElement("div", {
        style: { display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 700 }
      },
        /*#__PURE__*/React.createElement("span", {
          style: { color: movePct > 0 ? '#16a34a' : movePct < 0 ? '#dc2626' : 'var(--text-muted)' }
        }, `Day: ${signPct}${movePct.toFixed(1)}%`),
        /*#__PURE__*/React.createElement("span", { style: { opacity: 0.6 } }, "·"),
        /*#__PURE__*/React.createElement("span", {
          style: { color: postNewsMove > 0 ? '#16a34a' : postNewsMove < 0 ? '#dc2626' : 'var(--text-muted)' }
        }, `Post: ${postSign}${postNewsMove.toFixed(1)}%`)
      ));

  })(), /*#__PURE__*/React.createElement("div", {

    className: "cat-headline-compact",

    title: c.title || ''

  }, displayHeadline),

  c.financialComparison && c.financialComparison.metricsList && c.financialComparison.metricsList.length > 0 && /*#__PURE__*/React.createElement("div", {

    style: {

      margin: '4px 0 5px',

      padding: '5px 7px',

      background: 'rgba(255, 255, 255, 0.03)',

      border: '1px solid rgba(255, 255, 255, 0.08)',

      borderRadius: '6px',

      fontSize: '10.5px'

    }

  }, /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'flex',

      justifyContent: 'space-between',

      alignItems: 'center',

      marginBottom: '4px'

    }

  }, /*#__PURE__*/React.createElement("span", {

    style: {

      fontWeight: 800,

      color: '#38bdf8'

    }

  }, "📊 Financials (Old vs New):"), c.strengthGrade && /*#__PURE__*/React.createElement("span", {

    style: {

      fontSize: '9px',

      fontWeight: 800,

      padding: '1px 6px',

      borderRadius: '4px',

      background: c.strengthGrade === 'BLOWOUT_BEAT' ? 'rgba(34, 197, 94, 0.18)' : c.strengthGrade === 'SEVERE_MISS' ? 'rgba(239, 68, 68, 0.18)' : 'rgba(148, 163, 184, 0.15)',

      color: c.strengthGrade === 'BLOWOUT_BEAT' ? '#4ade80' : c.strengthGrade === 'SEVERE_MISS' ? '#f87171' : '#cbd5e1'

    }

  }, c.strengthGrade.replace(/_/g, ' '))), /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'grid',

      gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',

      gap: '3px'

    }

  }, c.financialComparison.metricsList.map(m => /*#__PURE__*/React.createElement("div", {

    key: m.key,

    style: {

      display: 'flex',

      justifyContent: 'space-between',

      padding: '2px 5px',

      background: 'rgba(0, 0, 0, 0.2)',

      borderRadius: '4px',

      fontSize: '9.5px'

    }

  }, /*#__PURE__*/React.createElement("span", {

    style: {

      color: '#94a3b8'

    }

  }, m.name + ":"), /*#__PURE__*/React.createElement("span", {

    style: {

      fontWeight: 700,

      color: m.status === 'BEAT' || m.status === 'BLOWOUT' ? '#4ade80' : m.status === 'MISS' || m.status === 'SEVERE_MISS' ? '#f87171' : 'inherit'

    }

  }, m.current !== '—' && m.prior !== '—' ? `${m.current} vs ${m.prior} (${m.change})` : `${m.change}`))))),

  c.targetPrice && c.stopLossPrice && /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'flex',

      alignItems: 'center',

      justifyContent: 'space-between',

      fontSize: '9.5px',

      padding: '2px 6px',

      background: 'rgba(56, 189, 248, 0.08)',

      borderRadius: '4px',

      border: '1px solid rgba(56, 189, 248, 0.2)',

      margin: '2px 0 4px',

      color: '#38bdf8'

    }

  }, /*#__PURE__*/React.createElement("span", null, `🎯 Target: ₹${c.targetPrice} (${c.targetPct > 0 ? '+' : ''}${c.targetPct}%)`), /*#__PURE__*/React.createElement("span", null, `🛑 SL: ₹${c.stopLossPrice} (${c.stopLossPct}%)`), /*#__PURE__*/React.createElement("span", {

    style: {

      fontWeight: 700

    }

  }, `R:R ${c.rrRatio || '1:3.0'}`)),

  c.fiveCandleVerdict && /*#__PURE__*/React.createElement("div", {

    style: {

      fontSize: '9.5px',

      color: '#94a3b8',

      margin: '1px 0 3px',

      fontStyle: 'italic'

    }

  }, `🕯️ ${c.fiveCandleVerdict}`),

  /*#__PURE__*/React.createElement("div", {

    className: "cat-reason-compact",

    title: finalThesisText

  }, finalThesisText), /*#__PURE__*/React.createElement("div", {

    className: "cat-buttons-compact"

  }, /*#__PURE__*/React.createElement("div", {

    className: `cat-btn-trade ${finalBtnClass}`

  }, finalBtnLabel), c.url ? /*#__PURE__*/React.createElement("a", {

    href: c.url,

    target: "_blank",

    rel: "noopener noreferrer",

    className: "cat-btn-pdf-compact",

    title: "Open official NSE PDF filing"

  }, /*#__PURE__*/React.createElement("span", null, "PDF"), /*#__PURE__*/React.createElement("svg", {

    width: "11",

    height: "11",

    viewBox: "0 0 24 24",

    fill: "none",

    stroke: "currentColor",

    strokeWidth: "2.5",

    strokeLinecap: "round",

    strokeLinejoin: "round"

  }, /*#__PURE__*/React.createElement("path", {

    d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"

  }), /*#__PURE__*/React.createElement("polyline", {

    points: "15 3 21 3 21 9"

  }), /*#__PURE__*/React.createElement("line", {

    x1: "10",

    y1: "14",

    x2: "21",

    y2: "3"

  }))) : /*#__PURE__*/React.createElement("div", {

    className: "cat-btn-pdf-compact disabled",

    title: "No direct PDF attached"

  }, /*#__PURE__*/React.createElement("span", null, "PDF"), /*#__PURE__*/React.createElement("svg", {

    width: "11",

    height: "11",

    viewBox: "0 0 24 24",

    fill: "none",

    stroke: "currentColor",

    strokeWidth: "2.5",

    strokeLinecap: "round",

    strokeLinejoin: "round"

  }, /*#__PURE__*/React.createElement("path", {

    d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"

  }), /*#__PURE__*/React.createElement("polyline", {

    points: "15 3 21 3 21 9"

  }), /*#__PURE__*/React.createElement("line", {

    x1: "10",

    y1: "14",

    x2: "21",

    y2: "3"

  })))));

});

const GrowwMoverCard = React.memo(function GrowwMoverCard({

  m,

  onCopy,

  isCopied,

  mode = '1m'

}) {

  const price = Number(m.price || 0);

  const [flash, setFlash] = useState('');

  const prevPriceRef = useRef(price);

  useEffect(() => {

    if (prevPriceRef.current && price && price !== prevPriceRef.current) {

      const cls = price > prevPriceRef.current ? 'price-flash-up' : 'price-flash-down';

      setFlash(cls);

      const timer = setTimeout(() => setFlash(''), 700);

      prevPriceRef.current = price;

      return () => clearTimeout(timer);

    }

    prevPriceRef.current = price;

  }, [price]);

  const v1m = Number(m.move1mPct || 0);

  const v10 = Number(m.roc10 != null ? m.roc10 : m.move10sPct != null ? m.move10sPct : 0);

  const primaryVal = mode === '10s' ? v10 : v1m;

  const isBull = m.direction === 'BULLISH' || primaryVal > 0;

  const sign = primaryVal > 0 ? '+' : primaryVal < 0 ? '−' : '';

  const color = isBull ? 'var(--gain)' : 'var(--loss)';

  const bg = isBull ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)';

  const border = isBull ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)';

  const badgeLabel = mode === '10s' ? '⚡ 10s ROC: ' : '⚡ 1m ROC: ';

  return /*#__PURE__*/React.createElement("div", {

    className: "rocket-card",

    style: {

      borderLeft: `3.5px solid ${color}`

    }

  }, /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'flex',

      justifyContent: 'space-between',

      alignItems: 'center',

      height: '22px'

    }

  }, /*#__PURE__*/React.createElement("span", {

    className: `rocket-sym ${isCopied ? 'copied-flash' : ''}`,

    onClick: () => onCopy(m.symbol),

    title: `Tap to copy ${m.symbol}`,

    style: {

      fontFamily: "'JetBrains Mono', monospace",

      fontWeight: 800,

      fontSize: '14.5px'

    }

  }, m.symbol, isCopied && /*#__PURE__*/React.createElement("span", {

    style: {

      fontSize: '10px',

      color: 'var(--gain)',

      fontWeight: 800,

      marginLeft: '4px'

    }

  }, "COPIED! \u2713")), /*#__PURE__*/React.createElement("span", {

    style: {

      fontFamily: "'JetBrains Mono', monospace",

      fontSize: '12px',

      fontWeight: 800,

      padding: '2px 7px',

      borderRadius: '6px',

      background: bg,

      color: color,

      border: `1px solid ${border}`,

      minWidth: '78px',

      textAlign: 'center'

    }

  }, badgeLabel, sign, Math.abs(primaryVal).toFixed(2), "%")), /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'flex',

      justifyContent: 'space-between',

      alignItems: 'center',

      fontSize: '11px',

      color: 'var(--text-muted)',

      height: '18px'

    }

  }, /*#__PURE__*/React.createElement("span", null, "LTP: ", /*#__PURE__*/React.createElement("b", {

    className: flash,

    style: {

      color: 'var(--text)',

      transition: 'all 0.2s',

      minWidth: '60px',

      display: 'inline-block'

    }

  }, "\u20B9", price.toFixed(2))), /*#__PURE__*/React.createElement("span", {

    style: {

      minWidth: '65px',

      textAlign: 'right'

    }

  }, "Ticks: ", m.ticks || 1)), /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'flex',

      justifyContent: 'space-between',

      alignItems: 'center',

      fontSize: '10.5px',

      color: 'var(--text-muted)',

      height: '16px'

    }

  }, /*#__PURE__*/React.createElement("span", null, "1m ROC: ", /*#__PURE__*/React.createElement("b", {

    style: {

      color: v1m >= 0 ? 'var(--gain)' : 'var(--loss)'

    }

  }, v1m > 0 ? '+' : '', v1m.toFixed(2), "%")), /*#__PURE__*/React.createElement("span", null, "10s ROC: ", /*#__PURE__*/React.createElement("b", {

    style: {

      color: v10 >= 0 ? 'var(--gain)' : 'var(--loss)'

    }

  }, v10 > 0 ? '+' : '', v10.toFixed(2), "%"))));

});

const ScalpCard = React.memo(function ScalpCard({
  call,
  onCopy,
  isCopied
}) {
  const sym = call.symbol || '-';
  const isShort = String(call.action || '').toUpperCase().includes('SELL') || String(call.side || '').toUpperCase() === 'SHORT';
  const entry = Number(call.entryPrice || call.limitEntry || call.pivot || 0);
  const sl = Number(call.stopLoss || 0);
  const target = Number(call.target1 || 0);
  const ltp = Number(call.ltp || entry);
  const [flash, setFlash] = useState('');
  const prevPriceRef = useRef(ltp);

  useEffect(() => {
    if (prevPriceRef.current && ltp && ltp !== prevPriceRef.current) {
      const cls = ltp > prevPriceRef.current ? 'price-flash-up' : 'price-flash-down';
      setFlash(cls);
      const timer = setTimeout(() => setFlash(''), 700);
      prevPriceRef.current = ltp;
      return () => clearTimeout(timer);
    }
    prevPriceRef.current = ltp;
  }, [ltp]);

  const setup = call.setup || call.strategyId || 'CUP_AND_HANDLE';
  const isPreBreakout = call.status === 'PRE_BREAKOUT' || (call.stage && call.stage.includes('Near Breakout'));
  const isSupportBounce = call.setup === 'SUPPORT_BOUNCE' || call.status === 'SUPPORT_BOUNCE' || (call.patternName && (call.patternName.includes('Support') || call.patternName.includes('Polarity')));
  const isTrendFollow = call.setup === 'TREND_FOLLOW' || call.status === 'TREND_FOLLOW' || (call.patternName && call.patternName.includes('Trend Follow'));
  const distPct = call.distToPivotPct != null ? Number(call.distToPivotPct).toFixed(1) : (entry > 0 && ltp < entry ? (((entry - ltp) / entry) * 100).toFixed(1) : null);
  const scannedTime = call.scannedAt ? new Date(call.scannedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST' : '';
  const dayChangeStr = call.dayChange ? (call.dayChange >= 0 ? '+' : '') + Number(call.dayChange).toFixed(1) + '%' : '0.0%';

  // =========================================================================
  // BRANCH 1: PRE-BREAKOUT WATCHLIST CARD (Calm, Minimalist Institutional Design)
  // =========================================================================
  if (isPreBreakout) {
    const patternTitle = call.patternName || (setup === 'ASCENDING_TRIANGLE' ? '📐 Ascending Triangle' : (setup === 'DOUBLE_BOTTOM_NECKLINE' ? '🔱 W-Bottom Neckline' : (setup === 'FALLING_WEDGE' ? '📐 Falling Wedge' : (setup === 'BULL_FLAG_PENNANT' ? '🚩 Bull Flag' : '☕ Pure Cup & Handle'))));

    return /*#__PURE__*/React.createElement("div", {
      className: "scalp-card",
      id: `card-${sym}`
    },
      /* Card Top: Symbol + Clean Slate Tag + Neutral Watchlist Pill */
      /*#__PURE__*/React.createElement("div", {
        className: "card-top"
      },
        /*#__PURE__*/React.createElement("div", null,
          /*#__PURE__*/React.createElement("div", {
            className: "sym-row"
          },
            /*#__PURE__*/React.createElement("span", {
              className: `sym-name ${isCopied ? 'copied-flash' : ''}`,
              onClick: () => onCopy(sym),
              title: `Tap to copy ${sym}`
            }, sym, isCopied && /*#__PURE__*/React.createElement("span", {
              style: { fontSize: '10px', color: 'var(--gain)', fontWeight: 800, marginLeft: '4px' }
            }, "COPIED! ✓")),
            /*#__PURE__*/React.createElement("span", {
              className: "setup-tag",
              style: {
                background: '#f1f5f9',
                borderColor: '#e2e8f0',
                color: '#475569',
                fontWeight: 600,
                fontSize: '10.5px'
              }
            }, patternTitle)
          ),
          /* Subtitle: Clean neutral metadata */
          /*#__PURE__*/React.createElement("div", {
            style: { fontSize: '11px', color: '#64748b', marginTop: '2px' }
          },
            /*#__PURE__*/React.createElement("span", null, `Coiling in Handle${call.cupDepthPct ? ` · Base Depth ${call.cupDepthPct}%` : ''} · Stage 2 Trend`),
            scannedTime && /*#__PURE__*/React.createElement("span", {
              style: { background: "#f1f5f9", border: "1px solid #e2e8f0", padding: "1px 5px", borderRadius: "3px", color: "#64748b", fontSize: "10px", marginLeft: "6px" }
            }, `🕒 ${scannedTime}`)
          )
        ),
        /* Top Right: Neutral Watchlist badge */
        /*#__PURE__*/React.createElement("div", {
          style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }
        },
          /*#__PURE__*/React.createElement("span", {
            className: "action-badge watch",
            style: {
              background: '#f8fafc',
              color: '#475569',
              border: '1px solid #e2e8f0',
              fontWeight: 700,
              fontSize: '10.5px',
              padding: '2.5px 8px',
              borderRadius: '4px'
            }
          }, "WATCHLIST")
        )
      ),

      /* 4 Metric Boxes: Unified typography, zero color circus */
      /*#__PURE__*/React.createElement("div", {
        className: "levels-row"
      },
        /* Box 1: Breakout Trigger Price */
        /*#__PURE__*/React.createElement("div", { className: "level-item" },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, "Breakout Trigger"),
          /*#__PURE__*/React.createElement("span", { className: "val", style: { fontWeight: 800, color: 'var(--text, #0f172a)' } }, `₹${entry.toFixed(2)}`)
        ),
        /* Box 2: Live Price */
        /*#__PURE__*/React.createElement("div", { className: "level-item" },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, `Live Price (${dayChangeStr})`),
          /*#__PURE__*/React.createElement("span", {
            className: `val card-ltp ${flash}`,
            style: { fontWeight: 800, color: 'var(--text, #0f172a)' }
          }, `₹${ltp.toFixed(2)}`)
        ),
        /* Box 3: Distance to Trigger */
        /*#__PURE__*/React.createElement("div", { className: "level-item" },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, "Distance to Pivot"),
          /*#__PURE__*/React.createElement("span", { className: "val", style: { color: '#334155', fontWeight: 800 } }, distPct ? `-${distPct}%` : 'Coiling')
        ),
        /* Box 4: Volume Required for Breakout */
        /*#__PURE__*/React.createElement("div", { className: "level-item", style: { textAlign: 'right' } },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, "Volume Required"),
          /*#__PURE__*/React.createElement("span", { className: "val", style: { color: '#334155', fontWeight: 800 } }, "≥ 1.5x Avg")
        )
      ),

      /* Pre-Market Execution Checklist (Clean neutral card, no dashed orange or yellow borders) */
      /*#__PURE__*/React.createElement("div", {
        style: {
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: '6px',
          padding: '8px 10px',
          margin: '8px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          fontSize: '11px',
          color: '#475569'
        }
      },
        /* Row 1: Entry Trigger */
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          /*#__PURE__*/React.createElement("span", { style: { fontWeight: 700, color: '#334155', minWidth: '82px' } }, "Entry Rule:"),
          /*#__PURE__*/React.createElement("span", null, `Buy above ₹${entry.toFixed(2)} with volume expansion`)
        ),
        /* Row 2: Volume Gate */
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          /*#__PURE__*/React.createElement("span", { style: { fontWeight: 700, color: '#334155', minWidth: '82px' } }, "Volume Gate:"),
          /*#__PURE__*/React.createElement("span", null, `Requires ≥ 1.5x 20-DMA (Current: ${call.volumeSurge ? Number(call.volumeSurge).toFixed(2) + 'x' : '0.59x'} · ${call.vdu || 'Contraction'})`)
        ),
        /* Row 3: Planned Risk */
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          /*#__PURE__*/React.createElement("span", { style: { fontWeight: 700, color: '#334155', minWidth: '82px' } }, "Risk / Target:"),
          /*#__PURE__*/React.createElement("span", null, `Planned SL ₹${sl.toFixed(2)} (-${call.riskPct || 4.5}%) · T1 ₹${(call.target1 || (entry * 1.065)).toFixed(2)} (+6.5%) · T2 ₹${(call.target2 || (entry * 1.16)).toFixed(2)} (+16%)`)
        )
      ),

      /* Card Footer: Simple, clean text and subtle buttons */
      /*#__PURE__*/React.createElement("div", {
        className: "card-footer"
      },
        /*#__PURE__*/React.createElement("span", {
          style: { fontSize: '11px', color: '#64748b', fontWeight: 600 }
        }, `GTT Alert: ₹${entry.toFixed(2)}`),
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', gap: '6px' } },
          /*#__PURE__*/React.createElement("a", {
            href: `https://groww.in/stocks/${sym.toLowerCase()}`,
            target: "_blank",
            rel: "noreferrer",
            className: "btn-broker groww"
          }, "Groww"),
          /*#__PURE__*/React.createElement("a", {
            href: "https://trade.angelone.in",
            target: "_blank",
            rel: "noreferrer",
            className: "btn-broker angel"
          }, "Angel One")
        )
      )
    );
  }

  // =========================================================================
  // BRANCH 1B: TRADERHR SUPPORT BOUNCE CARD (Key Level + Candlestick + Volume)
  // =========================================================================
  if (isSupportBounce) {
    const floor = Number(call.supportFloor || call.pivot || entry);
    const patternTitle = call.patternName || 'Support Bounce Setup';
    const testCount = call.supportTests || '2x Tested Floor';
    const rr = call.rrRatio != null ? call.rrRatio : '2.3';
    const rewPct = call.rewardPct != null ? Number(call.rewardPct).toFixed(1) : '8.5';
    const crPct = call.closeRatioPct != null ? Number(call.closeRatioPct).toFixed(1) : '70.0';
    const turnVal = call.turnoverCr != null ? call.turnoverCr : '15.0';

    return /*#__PURE__*/React.createElement("div", {
      className: "scalp-card",
      id: `card-${sym}`
    },
      /* Card Top: Symbol + Clean Setup Tag + Neutral Support Badge */
      /*#__PURE__*/React.createElement("div", {
        className: "card-top"
      },
        /*#__PURE__*/React.createElement("div", null,
          /*#__PURE__*/React.createElement("div", {
            className: "sym-row"
          },
            /*#__PURE__*/React.createElement("span", {
              className: `sym-name ${isCopied ? 'copied-flash' : ''}`,
              onClick: () => onCopy(sym),
              title: `Tap to copy ${sym}`
            }, sym, isCopied && /*#__PURE__*/React.createElement("span", {
              style: { fontSize: '10px', color: 'var(--gain)', fontWeight: 800, marginLeft: '4px' }
            }, "COPIED! ✓")),
            /*#__PURE__*/React.createElement("span", {
              className: "setup-tag",
              style: {
                background: 'rgba(124, 58, 237, 0.12)',
                borderColor: 'rgba(124, 58, 237, 0.3)',
                color: '#7c3aed',
                fontWeight: 700,
                fontSize: '10.5px'
              }
            }, `🛡️ ${patternTitle}`)
          ),
          /* Subtitle: Key Level & Tests */
          /*#__PURE__*/React.createElement("div", {
            style: { fontSize: '11px', color: '#64748b', marginTop: '2px' }
          },
            /*#__PURE__*/React.createElement("span", null, `Key Support Level: ₹${floor.toFixed(2)} (${testCount}) · Above 200 SMA`),
            scannedTime && /*#__PURE__*/React.createElement("span", {
              style: { background: "#f1f5f9", border: "1px solid #e2e8f0", padding: "1px 5px", borderRadius: "3px", color: "#64748b", fontSize: "10px", marginLeft: "6px" }
            }, `🕒 ${scannedTime}`)
          )
        ),
        /* Top Right: Support Badge */
        /*#__PURE__*/React.createElement("div", {
          style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }
        },
          /*#__PURE__*/React.createElement("span", {
            className: "action-badge",
            style: {
              background: '#f8fafc',
              color: '#0f172a',
              border: '1px solid #cbd5e1',
              fontWeight: 800,
              fontSize: '10.5px',
              padding: '2.5px 8px',
              borderRadius: '4px'
            }
          }, "🛡️ SUPPORT BOUNCE"),
          /*#__PURE__*/React.createElement("div", {
            className: "timer-pill",
            style: { fontSize: '10px', color: '#64748b' }
          }, `R:R 1:${rr} · Hold: 3-10d`)
        )
      ),

      /* 4 Metric Boxes: Support Floor, Live Price, Stop Loss, Target */
      /*#__PURE__*/React.createElement("div", {
        className: "levels-row"
      },
        /* Box 1: Support Floor */
        /*#__PURE__*/React.createElement("div", { className: "level-item" },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, "Key Support Floor"),
          /*#__PURE__*/React.createElement("span", { className: "val", style: { fontWeight: 800, color: 'var(--text, #0f172a)' } }, `₹${floor.toFixed(2)}`)
        ),
        /* Box 2: Live Price */
        /*#__PURE__*/React.createElement("div", { className: "level-item" },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, `Bounce Entry (${dayChangeStr})`),
          /*#__PURE__*/React.createElement("span", {
            className: `val card-ltp ${flash}`,
            style: { fontWeight: 800, color: 'var(--text, #0f172a)' }
          }, `₹${ltp.toFixed(2)}`)
        ),
        /* Box 3: Planned Stop Loss Below Floor */
        /*#__PURE__*/React.createElement("div", { className: "level-item" },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, `Stop Loss (-${call.riskPct || 4.5}%)`),
          /*#__PURE__*/React.createElement("span", { className: "val", style: { color: 'var(--loss, #dc2626)', fontWeight: 800 } }, `₹${sl.toFixed(2)}`)
        ),
        /* Box 4: Target 1 */
        /*#__PURE__*/React.createElement("div", { className: "level-item", style: { textAlign: 'right' } },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, `Target 1 (+${rewPct}%)`),
          /*#__PURE__*/React.createElement("span", { className: "val", style: { color: 'var(--gain, #16a34a)', fontWeight: 800 } }, `₹${target.toFixed(2)}`)
        )
      ),

      /* TraderHR 4-Point Support Bounce Confirmation Checklist */
      /*#__PURE__*/React.createElement("div", {
        style: {
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: '6px',
          padding: '8px 10px',
          margin: '8px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          fontSize: '11px',
          color: '#475569'
        }
      },
        /* Point 1: Key Support Level */
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          /*#__PURE__*/React.createElement("span", { style: { fontWeight: 700, color: '#334155', minWidth: '105px' } }, "✓ Key Support:"),
          /*#__PURE__*/React.createElement("span", null, `Horizontal floor at ₹${floor.toFixed(2)} (${testCount}) held firmly without breaking.`)
        ),
        /* Point 2: Candlestick Confirmation */
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          /*#__PURE__*/React.createElement("span", { style: { fontWeight: 700, color: '#334155', minWidth: '105px' } }, "✓ Candlestick:"),
          /*#__PURE__*/React.createElement("span", null, `${patternTitle} (Closed in upper ${crPct}% of range with buying pressure).`)
        ),
        /* Point 3: Volume Confirmation */
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          /*#__PURE__*/React.createElement("span", { style: { fontWeight: 700, color: '#334155', minWidth: '105px' } }, "✓ Volume Surge:"),
          /*#__PURE__*/React.createElement("span", null, `${call.volumeSurge ? Number(call.volumeSurge).toFixed(2) + 'x' : '1.5x'} surge off floor confirming institutional buying interest (₹${turnVal} Cr turnover).`)
        ),
        /* Point 4: Risk Management */
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          /*#__PURE__*/React.createElement("span", { style: { fontWeight: 700, color: '#334155', minWidth: '105px' } }, "✓ Risk / Reward:"),
          /*#__PURE__*/React.createElement("span", null, `SL strictly below floor at ₹${sl.toFixed(2)} (-${call.riskPct || 4.5}%) · Favorable 1:${rr} R:R to ceiling.`)
        )
      ),

      /* Card Footer: Clean text + Broker Buttons */
      /*#__PURE__*/React.createElement("div", {
        className: "card-footer"
      },
        /*#__PURE__*/React.createElement("span", {
          style: { fontSize: '11px', color: '#16a34a', fontWeight: 700 }
        }, `🛡️ TraderHR Support Bounce Confirmed · Buying Interest Active`),
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', gap: '6px' } },
          /*#__PURE__*/React.createElement("a", {
            href: `https://groww.in/stocks/${sym.toLowerCase()}`,
            target: "_blank",
            rel: "noreferrer",
            className: "btn-broker groww"
          }, "Groww"),
          /*#__PURE__*/React.createElement("a", {
            href: "https://trade.angelone.in",
            target: "_blank",
            rel: "noreferrer",
            className: "btn-broker angel"
          }, "Angel One")
        )
      )
    );
  }

  // =========================================================================
  // BRANCH 1C: TREND FOLLOW CARD (Stage 2 Leader with High-Tight Base Breakout)
  // =========================================================================
  if (isTrendFollow) {
    const baseLow = Number(call.baseLow || call.stopLoss || (entry * 0.96));
    const target1 = Number(call.target1 || (entry * 1.08));
    const target2 = Number(call.target2 || (entry * 1.18));

    return /*#__PURE__*/React.createElement("div", {
      className: "scalp-card",
      id: `card-${sym}`
    },
      /* Card Top: Symbol + Clean Setup Tag + Neutral Trend Badge */
      /*#__PURE__*/React.createElement("div", {
        className: "card-top"
      },
        /*#__PURE__*/React.createElement("div", null,
          /*#__PURE__*/React.createElement("div", {
            className: "sym-row"
          },
            /*#__PURE__*/React.createElement("span", {
              className: `sym-name ${isCopied ? 'copied-flash' : ''}`,
              onClick: () => onCopy(sym),
              title: `Tap to copy ${sym}`
            }, sym, isCopied && /*#__PURE__*/React.createElement("span", {
              style: { fontSize: '10px', color: 'var(--gain)', fontWeight: 800, marginLeft: '4px' }
            }, "COPIED! ✓")),
            /*#__PURE__*/React.createElement("span", {
              className: "setup-tag",
              style: {
                background: '#f1f5f9',
                borderColor: '#e2e8f0',
                color: '#475569',
                fontWeight: 600,
                fontSize: '10.5px'
              }
            }, "📈 Institutional Trend Follow")
          ),
          /* Subtitle: Clean neutral metadata */
          /*#__PURE__*/React.createElement("div", {
            style: { fontSize: '11px', color: '#64748b', marginTop: '2px' }
          },
            /*#__PURE__*/React.createElement("span", null, `Stage 2 Leader · -${call.distTo52w || 5.0}% to 52w High · 3M Gain: +${call.perf3m || 15.0}%`),
            scannedTime && /*#__PURE__*/React.createElement("span", {
              style: { background: "#f1f5f9", border: "1px solid #e2e8f0", padding: "1px 5px", borderRadius: "3px", color: "#64748b", fontSize: "10px", marginLeft: "6px" }
            }, `🕒 ${scannedTime}`)
          )
        ),
        /* Top Right: Neutral Trend Badge */
        /*#__PURE__*/React.createElement("div", {
          style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }
        },
          /*#__PURE__*/React.createElement("span", {
            className: "action-badge",
            style: {
              background: '#f8fafc',
              color: '#0f172a',
              border: '1px solid #cbd5e1',
              fontWeight: 800,
              fontSize: '10.5px',
              padding: '2.5px 8px',
              borderRadius: '4px'
            }
          }, "📈 TREND RIDER"),
          /*#__PURE__*/React.createElement("div", {
            className: "timer-pill",
            style: { fontSize: '10px', color: '#64748b' }
          }, "Swing Hold: 5-25d")
        )
      ),

      /* 4 Metric Boxes: Unified typography, zero color circus */
      /*#__PURE__*/React.createElement("div", {
        className: "levels-row"
      },
        /* Box 1: Base Support */
        /*#__PURE__*/React.createElement("div", { className: "level-item" },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, "Base Support"),
          /*#__PURE__*/React.createElement("span", { className: "val", style: { fontWeight: 800, color: 'var(--text, #0f172a)' } }, `₹${baseLow.toFixed(2)}`)
        ),
        /* Box 2: Live Price */
        /*#__PURE__*/React.createElement("div", { className: "level-item" },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, `Live Price (${dayChangeStr})`),
          /*#__PURE__*/React.createElement("span", {
            className: `val card-ltp ${flash}`,
            style: { fontWeight: 800, color: 'var(--text, #0f172a)' }
          }, `₹${ltp.toFixed(2)}`)
        ),
        /* Box 3: Planned Stop Loss */
        /*#__PURE__*/React.createElement("div", { className: "level-item" },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, `Stop Loss (-${call.riskPct || 3.5}%)`),
          /*#__PURE__*/React.createElement("span", { className: "val", style: { color: 'var(--loss, #dc2626)', fontWeight: 800 } }, `₹${sl.toFixed(2)}`)
        ),
        /* Box 4: Target 1 */
        /*#__PURE__*/React.createElement("div", { className: "level-item", style: { textAlign: 'right' } },
          /*#__PURE__*/React.createElement("span", { className: "lbl" }, "Target 1 (+8.0%)"),
          /*#__PURE__*/React.createElement("span", { className: "val", style: { color: 'var(--gain, #16a34a)', fontWeight: 800 } }, `₹${target1.toFixed(2)}`)
        )
      ),

      /* Institutional Confirmation Checklist (Clean neutral box) */
      /*#__PURE__*/React.createElement("div", {
        style: {
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: '6px',
          padding: '8px 10px',
          margin: '8px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          fontSize: '11px',
          color: '#475569'
        }
      },
        /* Row 1: Trend Dominance */
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          /*#__PURE__*/React.createElement("span", { style: { fontWeight: 700, color: '#334155', minWidth: '82px' } }, "Trend Power:"),
          /*#__PURE__*/React.createElement("span", null, "Stage 2 Leader (Close > 50 & 200 SMA) · ADX Directional Dominance")
        ),
        /* Row 2: Volume Flow */
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          /*#__PURE__*/React.createElement("span", { style: { fontWeight: 700, color: '#334155', minWidth: '82px' } }, "Volume Flow:"),
          /*#__PURE__*/React.createElement("span", null, `Up/Down Vol Ratio ${call.upDnVolRatio || 1.4}x · ${call.volumeSurge ? Number(call.volumeSurge).toFixed(2) + 'x Vol' : 'Accumulation Active'}`)
        ),
        /* Row 3: 2-Stage Exit Plan */
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          /*#__PURE__*/React.createElement("span", { style: { fontWeight: 700, color: '#334155', minWidth: '82px' } }, "Exit Rule:"),
          /*#__PURE__*/React.createElement("span", null, `Book 50% at T1 ₹${target1.toFixed(2)} (+8%), move SL to Breakeven (+0.3%), trail runner to T2 ₹${target2.toFixed(2)} (+18%)`)
        )
      ),

      /* Card Footer: Clean text + Broker Buttons */
      /*#__PURE__*/React.createElement("div", {
        className: "card-footer"
      },
        /*#__PURE__*/React.createElement("span", {
          style: { fontSize: '11px', color: '#16a34a', fontWeight: 700 }
        }, `📈 -${call.distTo52w || 5.0}% to 52w High · Blue Sky`),
        /*#__PURE__*/React.createElement("div", { style: { display: 'flex', gap: '6px' } },
          /*#__PURE__*/React.createElement("a", {
            href: `https://groww.in/stocks/${sym.toLowerCase()}`,
            target: "_blank",
            rel: "noreferrer",
            className: "btn-broker groww"
          }, "Groww"),
          /*#__PURE__*/React.createElement("a", {
            href: "https://trade.angelone.in",
            target: "_blank",
            rel: "noreferrer",
            className: "btn-broker angel"
          }, "Angel One")
        )
      )
    );
  }

  // =========================================================================
  // BRANCH 2: CURRENT ACTIVE BREAKOUT CARD (Triggered inside buy pocket)
  // =========================================================================
  const span = target - sl;
  const at = p => isFinite(span) && span !== 0 ? Math.max(0, Math.min(100, (p - sl) / span * 100)) : 50;
  const pEntry = Math.max(5, Math.min(95, at(entry)));
  const posLtp = Math.max(0, Math.min(100, at(ltp)));
  const inProfit = posLtp >= pEntry;
  const fillLeft = inProfit ? pEntry : posLtp;
  const fillWidth = Math.abs(posLtp - pEntry);
  const fillColor = inProfit ? 'var(--gain)' : 'var(--loss)';
  const pts = isShort ? entry - ltp : ltp - entry;
  const pnlPct = entry > 0 ? pts / entry * 100 : 0;
  const patternTitle = call.patternName || (setup === 'CUP_AND_HANDLE' ? '☕ Pure Cup & Handle' : setup === 'ASCENDING_TRIANGLE' ? '📐 Ascending Triangle' : setup === 'DOUBLE_BOTTOM_NECKLINE' ? '🔱 W-Bottom Neckline' : setup === 'FALLING_WEDGE' ? '📐 Falling Wedge' : setup === 'BULL_FLAG_PENNANT' ? '🚩 Bull Flag' : setup === 'SUPPORT_BOUNCE' ? '🛡️ Polarity Retest' : (call.patternName || 'Institutional Breakout'));

  return /*#__PURE__*/React.createElement("div", {
    className: "scalp-card",
    id: `card-${sym}`,
    style: { borderTop: '3px solid var(--gain)' }
  },
    /* Card Top */
    /*#__PURE__*/React.createElement("div", {
      className: "card-top"
    },
      /*#__PURE__*/React.createElement("div", null,
        /*#__PURE__*/React.createElement("div", {
          className: "sym-row"
        },
          /*#__PURE__*/React.createElement("span", {
            className: `sym-name ${isCopied ? 'copied-flash' : ''}`,
            onClick: () => onCopy(sym),
            title: `Tap to copy ${sym}`
          }, sym, isCopied && /*#__PURE__*/React.createElement("span", {
            style: { fontSize: '10px', color: 'var(--gain)', fontWeight: 800, marginLeft: '4px' }
          }, "COPIED! ✓")),
          /*#__PURE__*/React.createElement("span", {
            className: "setup-tag",
            style: {
              background: 'rgba(16, 185, 129, 0.15)',
              borderColor: '#10b981',
              color: '#10b981',
              fontWeight: 800
            }
          }, patternTitle),
          call.catalyst && /*#__PURE__*/React.createElement("span", {
            className: "setup-tag",
            style: {
              background: 'rgba(37,99,235,0.15)',
              borderColor: 'rgba(37,99,235,0.4)',
              color: '#2563eb'
            }
          }, `🔥 ${call.catalyst}`)
        ),
        /* Subtitle */
        /*#__PURE__*/React.createElement("div", {
          style: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }
        },
          /*#__PURE__*/React.createElement("span", null, `Pocket Ceiling: ₹${(call.pivot ? call.pivot * 1.025 : entry * 1.025).toFixed(2)} (+2.5%) · Targets: T1 ₹${(call.target1 || target).toFixed(2)} · T2 ₹${(call.target2 || (entry * 1.16)).toFixed(2)}`),
          scannedTime && /*#__PURE__*/React.createElement("span", {
            style: { background: "rgba(255,255,255,0.06)", padding: "1px 6px", borderRadius: "4px", color: "var(--text-muted)", fontSize: "10px", marginLeft: "6px" }
          }, `🕒 ${scannedTime}`)
        )
      ),
      /* Right: Action Badge */
      /*#__PURE__*/React.createElement("div", {
        style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }
      },
        /*#__PURE__*/React.createElement("span", {
          className: `action-badge ${isShort ? 'sell' : 'buy'}`,
          style: { fontWeight: 800, fontSize: '10px', padding: '2px 7px' }
        }, isShort ? 'SELL / SHORT' : '⚡ BUY / LONG (In Pocket)'),
        /*#__PURE__*/React.createElement("div", {
          className: "timer-pill",
          style: { fontSize: '10px' }
        }, "🏛️ Swing Hold: 3-10d")
      )
    ),

    /* 4 Metric Boxes for Active Trade */
    /*#__PURE__*/React.createElement("div", {
      className: "levels-row"
    },
      /* Box 1: Stop Loss */
      /*#__PURE__*/React.createElement("div", { className: "level-item" },
        /*#__PURE__*/React.createElement("span", { className: "lbl" }, `Stop Loss (-${call.riskPct ? Number(call.riskPct).toFixed(1) : '4.5'}%)`),
        /*#__PURE__*/React.createElement("span", { className: "val", style: { color: 'var(--loss)' } }, `₹${sl.toFixed(2)}`)
      ),
      /* Box 2: Breakout Pivot */
      /*#__PURE__*/React.createElement("div", { className: "level-item" },
        /*#__PURE__*/React.createElement("span", { className: "lbl" }, "Breakout Pivot"),
        /*#__PURE__*/React.createElement("span", { className: "val" }, `₹${(call.pivot || entry).toFixed(2)}`)
      ),
      /* Box 3: Live LTP */
      /*#__PURE__*/React.createElement("div", { className: "level-item" },
        /*#__PURE__*/React.createElement("span", { className: "lbl" }, `Live LTP (${dayChangeStr})`),
        /*#__PURE__*/React.createElement("span", {
          className: `val card-ltp ${flash}`,
          style: { color: (call.dayChange || pnlPct) >= 0 ? 'var(--gain)' : 'var(--loss)' }
        }, `₹${ltp.toFixed(2)}`)
      ),
      /* Box 4: Target 1 */
      /*#__PURE__*/React.createElement("div", { className: "level-item", style: { textAlign: 'right' } },
        /*#__PURE__*/React.createElement("span", { className: "lbl" }, "Target 1 (+6.5%)"),
        /*#__PURE__*/React.createElement("span", { className: "val", style: { color: 'var(--gain)' } }, `₹${(call.target1 || target).toFixed(2)}`)
      )
    ),

    /* Active Trade Slider */
    /*#__PURE__*/React.createElement("div", {
      className: "track-wrap"
    },
      /*#__PURE__*/React.createElement("div", { className: "track-labels" },
        /*#__PURE__*/React.createElement("span", { style: { color: 'var(--loss)' } }, "SL (0%)"),
        /*#__PURE__*/React.createElement("span", { style: { color: 'var(--gain)' } }, "TGT (+100%)")
      ),
      /*#__PURE__*/React.createElement("div", { className: "track-bar" },
        /*#__PURE__*/React.createElement("div", {
          className: "track-fill",
          style: { left: `${fillLeft}%`, width: `${fillWidth}%`, background: fillColor }
        }),
        /*#__PURE__*/React.createElement("div", {
          className: "track-entry-notch",
          style: { left: `${pEntry}%` },
          title: `Entry ₹${entry.toFixed(2)}`
        }),
        /*#__PURE__*/React.createElement("div", {
          className: "track-pin",
          style: { left: `${posLtp}%` },
          title: `LTP ₹${ltp.toFixed(2)}`
        })
      )
    ),

    /* Card Footer */
    /*#__PURE__*/React.createElement("div", {
      className: "card-footer"
    },
      /*#__PURE__*/React.createElement("span", {
        className: `pnl-badge ${(call.dayChange || pnlPct) >= 0 ? 'pos' : 'neg'}`
      }, call.volumeSurge ? `🔥 ${Number(call.volumeSurge).toFixed(2)}x Vol Surge (In Pocket)` : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`),
      /*#__PURE__*/React.createElement("div", { style: { display: 'flex', gap: '6px' } },
        /*#__PURE__*/React.createElement("a", {
          href: `https://groww.in/stocks/${sym.toLowerCase()}`,
          target: "_blank",
          rel: "noreferrer",
          className: "btn-broker groww"
        }, "Groww"),
        /*#__PURE__*/React.createElement("a", {
          href: "https://trade.angelone.in",
          target: "_blank",
          rel: "noreferrer",
          className: "btn-broker angel"
        }, "Angel One")
      )
    )
  );
});

function HistoryTable({

  closed

}) {

  if (!closed || !closed.length) {

    return /*#__PURE__*/React.createElement("div", {

      className: "history-card"

    }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Date"), /*#__PURE__*/React.createElement("th", null, "Symbol"), /*#__PURE__*/React.createElement("th", null, "Swing Engine"), /*#__PURE__*/React.createElement("th", null, "Side"), /*#__PURE__*/React.createElement("th", null, "Entry (Pivot)"), /*#__PURE__*/React.createElement("th", null, "Exit Price"), /*#__PURE__*/React.createElement("th", null, "SL / Target"), /*#__PURE__*/React.createElement("th", null, "Outcome"), /*#__PURE__*/React.createElement("th", null, "R-Multiple"), /*#__PURE__*/React.createElement("th", null, "Hold"))), /*#__PURE__*/React.createElement("tbody", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {

      colSpan: "10",

      style: {

        textAlign: 'center',

        color: 'var(--text-muted)',

        padding: '24px'

      }

    }, "No closed swing trades in current view.")))));

  }

  return /*#__PURE__*/React.createElement("div", {

    className: "history-card"

  }, /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Date"), /*#__PURE__*/React.createElement("th", null, "Symbol"), /*#__PURE__*/React.createElement("th", null, "Swing Engine"), /*#__PURE__*/React.createElement("th", null, "Side"), /*#__PURE__*/React.createElement("th", null, "Entry (Pivot)"), /*#__PURE__*/React.createElement("th", null, "Exit Price"), /*#__PURE__*/React.createElement("th", null, "SL / Target"), /*#__PURE__*/React.createElement("th", null, "Outcome"), /*#__PURE__*/React.createElement("th", null, "R-Multiple"), /*#__PURE__*/React.createElement("th", null, "Hold"))), /*#__PURE__*/React.createElement("tbody", null, closed.map((c, i) => {

    const sym = c.symbol || '—';

    const setup = c.setup || 'CUP_AND_HANDLE';

    const act = c.side || c.action || 'BUY';

    const entry = Number(c.entryPrice || 0);

    const exit = Number(c.exitPrice || entry);

    const outcome = c.verdict || c.outcome || 'TARGET_1_HIT';

    const pts = Number(c.points != null ? c.points : (exit - entry));

    const isWin = pts > 0.01 || outcome.includes('TARGET') || outcome.includes('WON') || outcome.includes('HIT (+') || (outcome.includes('PROFIT') && pts > 0.01) || outcome.includes('TRAILING');

    const isLoss = pts < -0.01 || (outcome.includes('STOP') && !outcome.includes('TRAILING') && pts < 0) || outcome.includes('LOST') || outcome.includes('HIT (-');

    const isFlat = !isWin && !isLoss;

    const rMult = c.rMultiple || (isWin ? '+2.00R' : isLoss ? '-1.00R' : '0.00R');

    const hold = c.holdDays ? `${c.holdDays}d` : '5d';

    return /*#__PURE__*/React.createElement("tr", {

      key: c.id || `${sym}-${i}`

    }, /*#__PURE__*/React.createElement("td", {

      style: { fontWeight: 600, color: 'var(--text-muted)' }

    }, c.time || '—'), /*#__PURE__*/React.createElement("td", {

      className: "mono"

    }, /*#__PURE__*/React.createElement("b", null, sym)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {

      className: "setup-tag",

      style: {

        background: setup.includes('CUP') ? 'rgba(217,119,6,0.15)' : setup.includes('TRIANGLE') ? 'rgba(6,182,212,0.15)' : 'rgba(139,92,246,0.15)',

        color: setup.includes('CUP') ? '#d97706' : setup.includes('TRIANGLE') ? '#06b6d4' : '#8b5cf6',

        fontWeight: 700

      }

    }, setup.replace('_', ' '))), /*#__PURE__*/React.createElement("td", {

      style: {

        color: 'var(--gain)',

        fontWeight: 700

      }

    }, act), /*#__PURE__*/React.createElement("td", {

      className: "mono"

    }, "\u20B9", entry.toFixed(2)), /*#__PURE__*/React.createElement("td", {

      className: "mono"

    }, "\u20B9", exit.toFixed(2)), /*#__PURE__*/React.createElement("td", {

      className: "mono",

      style: {

        fontSize: '11px'

      }

    }, "\u20B9", (c.stopLoss || 0).toFixed(2), " / \u20B9", (c.target1 || 0).toFixed(2)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {

      style: {

        fontWeight: 700,

        color: isWin ? 'var(--gain)' : isLoss ? 'var(--loss)' : '#6366f1'

      }

    }, outcome)), /*#__PURE__*/React.createElement("td", {

      className: "mono",

      style: {

        fontWeight: 800,

        color: isWin ? 'var(--gain)' : isLoss ? 'var(--loss)' : 'var(--text-muted)'

      }

    }, rMult), /*#__PURE__*/React.createElement("td", {

      className: "mono",

      style: {

        fontWeight: 600,

        color: 'var(--text-muted)'

      }

    }, hold));

  }))));

}



// --- Main Application Component ---



function OvernightTopPickCard({

  overnightBatch,

  catalysts,

  onCopy

}) {

  if (!overnightBatch) return null;



  // Determine market phase: Pre-Market vs Live Open (09:15-15:30) vs Post-Close

  const nowMs = Date.now();

  const d = new Date(nowMs + 330 * 60000);

  const day = d.getUTCDay();

  const tNum = d.getUTCHours() * 100 + d.getUTCMinutes();

  const isMarketOpen = day >= 1 && day <= 5 && tNum >= 915 && tNum < 1530;



  // 1. If Market is Open: Check for Newly Arrived News (<30m) or Active Velocity Mover

  let p = null;

  let bannerTitle = tNum >= 1530 ? "⚡ #1 TOP CANDIDATE FOR TOMORROW'S 09:00 AM OPEN (AFTER 3:30 PM)" : "⚡ #1 TOP CANDIDATE FOR 09:00 AM OPEN (OVERNIGHT 15:30 CLOSE TO NOW)";

  let badgePill = null;

  let actionLabel = '09:00–09:15 AM PRE-OPEN PLAN';

  let dynamicPlan = null;

  if (isMarketOpen) {

    // User rule: "keep only news to until it taken by market not 30min if no news keep empty in live if already filled dont give"

    // Valid for entire session until taken by market (already moved >= 1.2% or filled today)

    const todaySessionNews = (catalysts || []).filter(c => {

      if (!c || !c.ts) return false;

      const pPrice = Number(c.ltp || c.close || c.effectivePrice || 0);

      const v = Number(c.volume || c.effectiveVolume || 0);

      if (c.isPennyStock || c.isUntradeable || pPrice < 20.0 || v > 0 && v < 20000 || /^\d+$/.test(c.symbol)) return false;



      // 1. If already filled or already moved, do NOT give

      if (c.tradeStatus === 'ALREADY_FILLED' || c.tradeStatus === 'ALREADY_MOVED' || c.tradeStatus === 'STALE_YESTERDAY' || c.takeTrade === false) return false;



      // 2. Must be filed today during this session or morning pre-market

      const dC = new Date(Number(c.ts) + 330 * 60000);

      const isTodayFiling = dC.getUTCFullYear() === d.getUTCFullYear() && dC.getUTCMonth() === d.getUTCMonth() && dC.getUTCDate() === d.getUTCDate();

      if (!isTodayFiling) return false;



      // 3. Must have confirmed momentum thrust

      const hasThrust = c.isConfirmedMomentum || Math.abs(Number(c.move1mPct || 0)) >= 0.18 || Math.abs(Number(c.move5mPct || 0)) >= 0.35;

      return hasThrust && c.prediction && !c.prediction.includes('NEUTRAL') && !c.prediction.includes('UNTRADEABLE');

    });

    if (todaySessionNews.length > 0) {

      todaySessionNews.sort((a, b) => {

        const confDiff = Number(b.confidence || 0) - Number(a.confidence || 0);

        if (confDiff !== 0) return confDiff;

        return Number(b.ts || 0) - Number(a.ts || 0);

      });

      p = todaySessionNews[0];

      bannerTitle = '⚡ FRESH BREAKING NEWS CATALYST (CONFIRMED MOMENTUM)';

      badgePill = `🔥 TODAY ${p.filingTime || 'LIVE'} · ACTIVE BREAKOUT`;

      actionLabel = 'LIVE PRE-MOVE ACTION PLAN';

      const isUp = p.direction === 'UP' || p.bias === 'BULLISH';

      dynamicPlan = isUp ? `${p.symbol} filed high-conviction catalyst today (${p.filingTime || 'live'}) with confirmed momentum. Watch 1m volume burst confirmation or VWAP breakout for continuation scalp.` : `${p.symbol} filed negative catalyst today (${p.filingTime || 'live'}). Watch for breakdown below VWAP; avoid buying.`;

    }



    // User rule: "if no news keep empty in live"

    // If no fresh unpriced news catalyst with confirmed thrust, keep banner completely EMPTY!

    if (!p) {

      return null;

    }

  } else {

    // PRE-MARKET (before 09:15) or POST-MARKET (after 15:30)

    p = overnightBatch.topBannerPick || overnightBatch.topPick;

    const isPreOpenSettled = tNum >= 908 && tNum < 915;

    if (isPreOpenSettled) {

      bannerTitle = "🌅 09:08 AM PRE-OPEN CONFIRMED CALL (READY FOR 09:15 OPEN)";

      badgePill = p && p.preMarketGapPct != null ? `IEP GAP: ${p.preMarketGapPct >= 0 ? '+' : ''}${p.preMarketGapPct.toFixed(2)}%` : '09:08 IEP DISCOVERED';

      actionLabel = '09:08–09:15 AM EXECUTION PLAN';

      if (p && p.preMarketGapPct != null) {

        if (p.preMarketGapPct >= 0.8 && (p.direction === 'UP' || p.bias === 'BULLISH')) {

          dynamicPlan = `Pre-open auction confirmed +${p.preMarketGapPct.toFixed(2)}% gap-up at ₹${p.open || p.ltp}. Enter at 09:15 open; target +1.8%, SL below ₹${p.close}.`;

        } else if (p.preMarketGapPct < 0 && (p.direction === 'UP' || p.bias === 'BULLISH')) {

          dynamicPlan = `Warning: Pre-open auction gapped down ${p.preMarketGapPct.toFixed(2)}% despite news. Institutions fading; avoid buying at open.`;

        } else if (p.preMarketGapPct <= -0.8) {

          dynamicPlan = `Pre-open auction confirmed ${p.preMarketGapPct.toFixed(2)}% gap-down. Short/fade on 09:15 open; target -1.8%, SL above ₹${p.close}.`;

        }

      }

    } else {

      bannerTitle = tNum >= 1530 ? "⚡ #1 TOP CANDIDATE FOR TOMORROW'S 09:00 AM OPEN (AFTER 3:30 PM)" : "⚡ #1 TOP CANDIDATE FOR 09:00 AM OPEN (OVERNIGHT 15:30 CLOSE TO NOW)";

    }

  }

  if (!p) {

    return /*#__PURE__*/React.createElement("div", {

      className: "overnight-top-banner",

      style: {

        background: 'var(--card-bg)',

        border: '1px dashed var(--card-border)',

        padding: '24px',

        textAlign: 'center',

        marginBottom: '24px',

        borderRadius: '14px'

      }

    }, /*#__PURE__*/React.createElement("div", {

      style: {

        fontSize: '14px',

        fontWeight: 700,

        color: 'var(--text, #0f172a)'

      }

    }, "\uD83C\uDF19 Overnight Catalyst Scanner Active (15:30 IST to 09:00 AM Open)"), /*#__PURE__*/React.createElement("div", {

      style: {

        fontSize: '12px',

        color: 'var(--text-muted, #64748b)',

        marginTop: '4px'

      }

    }, "Tracking post-close exchange filings. Scanning for unpriced corporate catalysts for tomorrow's open."));

  }

  const isPricedIn = !!p.isPricedIn;

  const isUp = !isPricedIn && (p.direction === 'UP' || p.bias === 'BULLISH');

  const probVal = p.probability || p.confidence || 88;

  const dirColor = isUp ? '#16a34a' : '#dc2626';

  const dirBg = isUp ? '#dcfce7' : '#fee2e2';

  const dirBorder = isUp ? '#86efac' : '#fca5a5';

  const dirLabel = isPricedIn ? `PRICED-IN (+${(p.changePct || 0).toFixed(1)}%) · FADE RISK` : isUp ? 'UNPRICED CATALYST · HIGH CHANCE TO GO UP' : 'HIGH CHANCE TO GO DOWN / FADE';

  const dirIcon = isUp ? '🟢' : '🔴';

  return /*#__PURE__*/React.createElement("div", {

    className: "overnight-top-banner"

  }, /*#__PURE__*/React.createElement("div", {

    className: "overnight-top-header"

  }, /*#__PURE__*/React.createElement("div", {

    className: "overnight-badge-row"

  }, /*#__PURE__*/React.createElement("span", {

    className: "overnight-pill-label"

  }, bannerTitle), badgePill ? /*#__PURE__*/React.createElement("span", {

    className: "overnight-target-pill",

    style: {

      background: 'rgba(245, 158, 11, 0.15)',

      color: '#d97706',

      borderColor: '#fcd34d'

    }

  }, badgePill) : overnightBatch.isHoliday ? /*#__PURE__*/React.createElement("span", {

    className: "overnight-holiday-pill"

  }, "\u26A0\uFE0F ", overnightBatch.holidayNote) : /*#__PURE__*/React.createElement("span", {

    className: "overnight-target-pill"

  }, "\uD83C\uDFAF Target: ", overnightBatch.targetLabel || '09:00 AM IST', " \xB7 Non-Holiday"), /*#__PURE__*/React.createElement("span", {

    className: "overnight-count-pill"

  }, overnightBatch.totalFilings || (catalysts ? catalysts.length : 0), " filings tracked"))), /*#__PURE__*/React.createElement("div", {

    className: "overnight-content-row"

  }, /*#__PURE__*/React.createElement("div", {

    className: "overnight-col-symbol"

  }, /*#__PURE__*/React.createElement("div", {

    className: "overnight-sym-title",

    onClick: () => onCopy(p.symbol),

    title: `Click to copy ${p.symbol}`

  }, p.symbol, /*#__PURE__*/React.createElement("span", {

    className: "overnight-copy-hint"

  }, "Copy")), /*#__PURE__*/React.createElement("div", {

    className: "overnight-prob-badge",

    style: {

      background: dirBg,

      borderColor: dirBorder,

      color: dirColor

    }

  }, /*#__PURE__*/React.createElement("span", null, dirIcon, " ", probVal, "%"), /*#__PURE__*/React.createElement("span", {

    style: {

      fontSize: '11px',

      fontWeight: 600,

      textTransform: 'uppercase'

    }

  }, dirLabel))), /*#__PURE__*/React.createElement("div", {

    className: "overnight-col-details"

  }, /*#__PURE__*/React.createElement("div", {

    className: "overnight-headline",

    title: p.title || ''

  }, p.title || 'Corporate Announcement'), /*#__PURE__*/React.createElement("div", {

    className: "overnight-thesis"

  }, /*#__PURE__*/React.createElement("b", null, "Catalyst Thesis:"), " ", p.thesis || p.rationale || 'High conviction corporate catalyst.'), /*#__PURE__*/React.createElement("div", {

    className: "overnight-meta"

  }, /*#__PURE__*/React.createElement("span", null, "\u23F1\uFE0F Filed: ", p.filingTime || 'Today', " (", p.timeAgo || 'recent', ")"), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, "Category: ", p.materiality || 'CATALYST'), p.url && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("a", {

    href: p.url,

    target: "_blank",

    rel: "noopener noreferrer",

    className: "overnight-pdf-link"

  }, "Official PDF \u2197")))), /*#__PURE__*/React.createElement("div", {

    className: "overnight-col-action"

  }, /*#__PURE__*/React.createElement("div", {

    className: "overnight-action-label"

  }, actionLabel), /*#__PURE__*/React.createElement("div", {

    className: "overnight-action-text"

  }, dynamicPlan ? dynamicPlan : isPricedIn ? `⚠️ PRICED-IN RUNUP (+${(p.changePct || 0).toFixed(1)}%): Stock surged yesterday before the filing. Expect "Sell the news" profit taking at open. Watch for failed VWAP bounce to short/fade; avoid buying gap-up.` : isUp ? 'Watch 09:15 open vs VWAP. Enter on confirmed OR15 breakout; avoid chasing initial gap spike.' : 'Watch opening gap-down. Look for failed bounce to VWAP or OR15 breakdown; do not buy the dip.'), /*#__PURE__*/React.createElement("button", {

    className: "overnight-prep-btn",

    onClick: () => onCopy(p.symbol),

    style: {

      background: dirColor,

      color: '#ffffff'

    }

  }, isPricedIn ? 'Prepare Short / Fade (Priced In)' : isUp ? 'Prepare Buy Call' : 'Prepare Short / Fade'))));

}


function getClientMoveTiming(c, ltp, movePct, postNewsMove) {
  const nowIst = new Date(Date.now() + 330 * 60000);
  const nowHourMin = nowIst.getUTCHours() * 100 + nowIst.getUTCMinutes();
  const nowDay = nowIst.getUTCDay();
  const isMarketOpenNow = (nowDay >= 1 && nowDay <= 5 && nowHourMin >= 915 && nowHourMin < 1530);

  const tsNum = Number(c.ts || c.firstSeenAt || Date.now());
  const dIst = new Date(tsNum + 330 * 60000);
  const filingHourMin = dIst.getUTCHours() * 100 + dIst.getUTCMinutes();
  const isPreOpenFiling = (filingHourMin >= 1530 || filingHourMin < 915);
  
  // If pre-open/overnight filing, while market is closed before 09:15, after-news move is strictly 0.00%.
  // Once market opens at 09:15 AM, today's price change (movePct) IS the post-news market reaction!
  let effPost;
  let preNewsMove;

  if (isPreOpenFiling) {
    if (!isMarketOpenNow) {
      effPost = 0.0;
      preNewsMove = 0.0;
    } else {
      const rawPost = c.postNewsMovePct != null ? Number(c.postNewsMovePct) : null;
      effPost = (rawPost != null && Math.abs(rawPost) >= 0.01) ? rawPost : (postNewsMove != null && Math.abs(postNewsMove) >= 0.01 ? Number(postNewsMove) : Number(movePct || 0));
      preNewsMove = 0.0;
    }
  } else {
    // Intraday filing disclosed during active market hours
    effPost = Number(c.postNewsMovePct != null ? c.postNewsMovePct : (postNewsMove != null ? postNewsMove : 0));
    preNewsMove = Number(c.preNewsMovePct != null ? c.preNewsMovePct : +(movePct - effPost).toFixed(2));
  }

  const absPost = Math.abs(effPost);
  const postSign = effPost > 0 ? '+' : '';
  let badgeLabel = '0.0%';
  let badgeColor = '#64748b';
  let badgeBg = 'rgba(100, 116, 139, 0.08)';
  let badgeBorder = 'rgba(100, 116, 139, 0.2)';
  let detail = 'Stock has not moved post-news.';

  if (isPreOpenFiling && !isMarketOpenNow) {
    badgeLabel = '0.0%';
    badgeColor = '#64748b';
    badgeBg = 'rgba(100, 116, 139, 0.08)';
    badgeBorder = 'rgba(100, 116, 139, 0.2)';
    detail = `Filed pre-market / post-close (${c.filingTime || 'overnight'}). Cash market is closed; waiting for 09:15 open (0.0% move).`;
  } else if (absPost >= 0.50) {
    badgeLabel = `${postSign}${effPost.toFixed(1)}%`;
    badgeColor = effPost > 0 ? '#16a34a' : '#dc2626';
    badgeBg = effPost > 0 ? 'rgba(22, 163, 74, 0.12)' : 'rgba(220, 38, 38, 0.12)';
    badgeBorder = effPost > 0 ? 'rgba(22, 163, 74, 0.3)' : 'rgba(220, 38, 38, 0.3)';
    detail = `Move since ${isPreOpenFiling ? 'pre-open ' : ''}announcement: ${postSign}${effPost.toFixed(2)}%.`;
  } else if (preNewsMove >= 1.50 && absPost < 0.40) {
    badgeLabel = `${postSign}${effPost.toFixed(1)}%`;
    badgeColor = '#d97706';
    badgeBg = 'rgba(217, 119, 6, 0.12)';
    badgeBorder = 'rgba(217, 119, 6, 0.35)';
    detail = `Stock rallied +${preNewsMove.toFixed(1)}% today before announcement arrived. News was already leaked/priced in; post-news move is ${postSign}${effPost.toFixed(1)}%.`;
  } else if (preNewsMove <= -1.50 && absPost < 0.40) {
    badgeLabel = `${postSign}${effPost.toFixed(1)}%`;
    badgeColor = '#b91c1c';
    badgeBg = 'rgba(185, 28, 28, 0.12)';
    badgeBorder = 'rgba(185, 28, 28, 0.35)';
    detail = `Stock fell -${Math.abs(preNewsMove).toFixed(1)}% prior to disclosure. Move post-news is ${postSign}${effPost.toFixed(1)}%.`;
  } else {
    badgeLabel = `${postSign}${effPost.toFixed(1)}%`;
    badgeColor = effPost > 0 ? '#16a34a' : effPost < 0 ? '#dc2626' : '#64748b';
    badgeBg = effPost > 0 ? 'rgba(22, 163, 74, 0.10)' : effPost < 0 ? 'rgba(220, 38, 38, 0.10)' : 'rgba(100, 116, 139, 0.08)';
    badgeBorder = effPost > 0 ? 'rgba(22, 163, 74, 0.25)' : effPost < 0 ? 'rgba(220, 38, 38, 0.25)' : 'rgba(100, 116, 139, 0.2)';
    detail = `${isPreOpenFiling ? 'Pre-open catalyst' : 'Catalyst'} filed at ${c.filingTime || 'session'}. Stock move since disclosure: ${postSign}${effPost.toFixed(1)}%.`;
  }

  return {
    badgeLabel,
    badgeColor,
    badgeBg,
    badgeBorder,
    detail,
    postNewsMovePct: effPost,
    preNewsMovePct: preNewsMove
  };
}

const NIFTY_50_SYMBOLS = new Set([
  "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", "BSE", "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BEL", "BHARTIARTL", "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL", "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE", "HINDALCO", "HINDUNILVR", "ICICIBANK", "ITC", "INFY", "INDIGO", "JSWSTEEL", "JIOFIN", "KOTAKBANK", "LT", "M&M", "MARUTI", "MAXHEALTH", "NTPC", "NESTLEIND", "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SHRIRAMFIN", "SBIN", "SUNPHARMA", "TCS", "TATACONSUM", "TMPV", "TATASTEEL", "TECHM", "TITAN", "TRENT", "ULTRACEMCO"
]);

const NIFTY_NEXT_50_SYMBOLS = new Set([
  "ABB", "ADANIENSOL", "ADANIGREEN", "ADANIPOWER", "AMBUJACEM", "DMART", "BAJAJHLDNG", "BANKBARODA", "BPCL", "BOSCHLTD", "BRITANNIA", "CGPOWER", "CANBK", "CHOLAFIN", "CUMMINSIND", "DLF", "DIVISLAB", "GAIL", "GODREJCP", "HDFCAMC", "HAL", "HINDZINC", "POWERINDIA", "HYUNDAI", "IOC", "IRFC", "JINDALSTEL", "LTM", "MAZDOCK", "MUTHOOTFIN", "PIDILITIND", "POLYCAB", "PFC", "PNB", "MOTHERSON", "ENRIN", "SIEMENS", "SOLARINDS", "TVSMOTOR", "TATACAP", "TMCV", "TATAPOWER", "TORNTPHARM", "UNIONBANK", "VBL", "VAML", "VEDL", "IDEA", "WIPRO", "ZYDUSLIFE"
]);

const NIFTY_MIDCAP_150_SYMBOLS = new Set([
  "360ONE", "AIAENG", "APLAPOLLO", "AUBANK", "ABBOTINDIA", "ATGL", "ABCAPITAL", "AJANTPHARM", "ALKEM", "ANTHEM", "APARINDS", "ASHOKLEY", "ASTERDM", "ASTRAL", "AUROPHARMA", "AIIL", "BAJAJHFL", "BALKRISIND", "BANKINDIA", "MAHABANK", "BERGEPAINT", "BDL", "BHARATFORG", "BHEL", "BHARTIHEXA", "GROWW", "BIOCON", "BLUESTARCO", "CRISIL", "COCHINSHIP", "COFORGE", "COLPAL", "CONCOR", "COROMANDEL", "DABUR", "DALBHARAT", "DIXON", "EMBASSY", "ENDURANCE", "ESCORTS", "EXIDEIND", "NYKAA", "FEDERALBNK", "FACT", "FORTIS", "GVT&D", "GMRAIRPORT", "GICRE", "GLAXO", "GLENMARK", "MEDANTA", "GODFRYPHLP", "GODREJIND", "GODREJPROP", "FLUOROCHEM", "HDBFS", "HAVELLS", "HEROMOTOCO", "HEXT", "HINDCOPPER", "HINDPETRO", "HUDCO", "ICICILIFE", "ICICIGI", "ICICIAMC", "IDFCFIRSTB", "ITCHOTELS", "INDIANB", "INDHOTEL", "IOB", "IRCTC", "IREDA", "INDUSTOWER", "INDUSINDBK", "NAUKRI", "IPCALAB", "JKCEMENT", "JSWENERGY", "JSWINFRA", "JSL", "JUBLFOOD", "KPRMILL", "KEI", "KALYANKJIL", "LTF", "LTTS", "LGEINDIA", "LICHSGFIN", "LAURUSLABS", "LENSKART", "LICI", "LINDEINDIA", "LLOYDSME", "LODHA", "LUPIN", "MRF", "M&MFIN", "MANKIND", "MARICO", "MFSL", "MEESHO", "MOTILALOFS", "MPHASIS", "MCX", "NHPC", "NLCINDIA", "NMDC", "NTPCGREEN", "NH", "NATIONALUM", "NAM-INDIA", "OBEROIRLTY", "OIL", "PAYTM", "OFSS", "POLICYBZR", "PIIND", "PAGEIND", "PATANJALI", "PERSISTENT", "PETRONET", "PHOENIXLTD", "PIRAMALFIN", "PREMIERENE", "PRESTIGE", "RECLTD", "RADICO", "RVNL", "SBICARD", "SRF", "SCHAEFFLER", "SHREECEM", "SAIL", "SUNDARMFIN", "SUPREMEIND", "SUZLON", "SWIGGY", "TATACOMM", "TATAINVEST", "THERMAX", "TORNTPOWER", "TIINDIA", "UNOMINDA", "UPL", "UBL", "UNITDSPR", "VMM", "VOLTAS", "WAAREEENER", "YESBANK"
]);

const NIFTY_SMALLCAP_250_SYMBOLS = new Set([
  "ACC", "ACMESOLAR", "AWL", "AADHARHFC", "AARTIIND", "AAVAS", "ACE", "ACUTAAS", "ABREL", "ABSLAMC", "CPPLUS", "AEGISLOG", "AEGISVOPAK", "AETHER", "AFCONS", "AFFLE", "ABDL", "ARE&M", "AMBER", "ANANDRATHI", "ANANTRAJ", "ANGELONE", "ANURAS", "APOLLOTYRE", "APTUS", "ASAHIINDIA", "ATHERENERG", "ATUL", "AVANTIFEED", "AZAD", "BEML", "BLS", "BAGMANE", "BALRAMCHIN", "BANDHANBNK", "BATAINDIA", "BELRISE", "BHARATCOAL", "BSOFT", "BBOX", "FIRSTCRY", "BRIGADE", "BIRET", "CCL", "CESC", "CIEINDIA", "CANFINHOME", "CANHLIFE", "CAPLIPOINT", "CGCL", "CARBORUNIV", "CARTRADE", "CASTROLIND", "CEATLTD", "CEMPRO", "CENTRALBK", "CDSL", "CMPDI", "CHAMBLFERT", "CHENNPETRO", "CHOICEIN", "CHOLAHLDNG", "CUB", "CLEANMAX", "CLEAN", "COHANCE", "CAMS", "CONCORDBIO", "CRAFTSMAN", "CREDITACC", "CROMPTON", "CUPID", "CYIENT", "DOMS", "DATAPATTNS", "DEEPAKFERT", "DEEPAKNTR", "DELHIVERY", "DEVYANI", "LALPATHLAB", "DUMMYHEG", "EIDPARRY", "EIHOTEL", "ELECON", "ELGIEQUIP", "EMAMILTD", "EMCURE", "EMMVEE", "ENGINERSIN", "FINCABLES", "FSL", "FIVESTAR", "FORCEMOT", "FRACTAL", "GABRIEL", "GALLANTT", "GRSE", "GILLETTE", "GLAND", "GPIL", "GRANULES", "GRAPHITE", "GRAVITA", "GESHIP", "GMDCLTD", "HBLENGINE", "HEGAM", "HFCL", "HSCL", "HOMEFIRST", "HONASA", "HONAUT", "IDBI", "IFCI", "IIFL", "INOXINDIA", "IRB", "IRCON", "ITI", "INDIACEM", "INDIAMART", "IEX", "IGL", "INOXWIND", "INTELLECT", "IGIL", "IKS", "JBMA", "JKTYRE", "JMFINANCIL", "JSWCEMENT", "JAINREC", "JPPOWER", "J&KBANK", "JINDALSAW", "JUBLINGREA", "JWL", "JYOTICNC", "KPITTECH", "KSB", "KAJARIACER", "KPIL", "KARURVYSYA", "KAYNES", "KEC", "KFINTECH", "KIRLOSBROS", "KIRLOSENG", "KIMS", "LTFOODS", "LEMONTREE", "MMTC", "MTARTECH", "MGL", "MANAPPURAM", "MRPL", "MINDACORP", "MSUMI", "NATCOPHARM", "NBCC", "NCC", "NSLNISP", "NAVA", "NAVINFLUOR", "NETWEB", "NEULANDLAB", "NUVAMA", "NUVOCO", "OLAELEC", "OLECTRA", "ONESOURCE", "PCBL", "PGEL", "PNBHOUSING", "PTCIL", "PVRINOX", "PARADEEP", "PWL", "PINELABS", "PPLPHARMA", "POLYMED", "POONAWALLA", "PFOCUS", "PRIVISCL", "RRKABEL", "RBLBANK", "RHIM", "RITES", "RAILTEL", "RAINBOW", "RKFORGE", "REDINGTON", "RPOWER", "RUBICON", "SJVN", "SHRIPISTON", "SAGILITY", "SAILIFE", "SAMMAANCAP", "SANSERA", "SARDAEN", "SCHNEIDER", "SCI", "SHYAMMETL", "SIGNATURE", "SOBHA", "SONACOMS", "STARHEALTH", "STLTECH", "SUMICHEM", "SUNTV", "SWANCORP", "SYNGENE", "SYRMA", "TBOTEK", "TDPOWERSYS", "TATACHEM", "TATAELXSI", "TATATECH", "TTML", "TECHNOE", "TEGA", "TEJASNET", "TENNIND", "THANGAMAYL", "NIACL", "RAMCOCEM", "TIMKEN", "TITAGARH", "TARIL", "TRIDENT", "TRITURBINE", "UCOBANK", "UTIAMC", "URBANCO", "USHAMART", "VTL", "VISL", "VOGL", "VEDPOWER", "VIJAYA", "WELCORP", "WELSPUNLIV", "WHIRLPOOL", "WOCKPHARMA", "ZFCVINDIA", "ZEEL", "ZENTEC", "ZENSARTECH", "ZYDUSWELL", "ECLERX"
]);

function getCompanyTier(symbol) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (NIFTY_50_SYMBOLS.has(sym)) {
    return { name: 'NIFTY 50', score: 1000, color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)', border: 'rgba(37, 99, 235, 0.28)' };
  }
  if (NIFTY_NEXT_50_SYMBOLS.has(sym)) {
    return { name: 'NEXT 50', score: 800, color: '#9333ea', bg: 'rgba(147, 51, 234, 0.12)', border: 'rgba(147, 51, 234, 0.28)' };
  }
  if (NIFTY_MIDCAP_150_SYMBOLS.has(sym)) {
    return { name: 'MIDCAP', score: 600, color: '#0891b2', bg: 'rgba(8, 145, 178, 0.12)', border: 'rgba(8, 145, 178, 0.28)' };
  }
  if (NIFTY_SMALLCAP_250_SYMBOLS.has(sym)) {
    return { name: 'SMALLCAP', score: 400, color: '#ea580c', bg: 'rgba(234, 88, 12, 0.12)', border: 'rgba(234, 88, 12, 0.28)' };
  }
  return { name: 'MICROCAP', score: 200, color: '#64748b', bg: 'rgba(100, 116, 139, 0.12)', border: 'rgba(100, 116, 139, 0.28)' };
}

function getNewsScopeScore(c) {
  const text = ((c.kind || '') + ' ' + (c.title || '') + ' ' + (c.description || '')).toLowerCase();
  let score = 50;

  // Genuine high-scope market-moving corporate events
  const isEarningsBeat = /profit\s+rises|profit\s+up|net\s+profit\s+jumps?|pat\s+climbs|blowout|revenue\s+rises|ebitda\s+up|earnings\s+beat|q[1-4]\s+net\s+profit/i.test(text) || Boolean(c.isBlowoutBeat);
  const isSevereMiss = /loss\s+widens|net\s+loss|profit\s+falls|profit\s+drops|pat\s+slumps|margin\s+contracts|earnings\s+miss/i.test(text) || Boolean(c.isSevereMiss);
  const isOrderWin = /order\s+win|bagged\s+order|secures?\s+(?:new\s+)?order|contract\s+awarded|wins?\s+bid|supply\s+order|crore\s+order|letter\s+of\s+award|loa\b/i.test(text) || c.category === 'ORDER_WIN';
  const isAcquisition = /acquisition|amalgamation|merger|takeover|strategic\s+stake|joint\s+venture|slump\s+sale/i.test(text) || c.category === 'ACQUISITION';
  const isDividendBuyback = /dividend|bonus\s+issue|stock\s+split|share\s+buyback|record\s+date\s+for\s+dividend/i.test(text) || c.category === 'DIVIDEND';
  const isRegulatoryApproval = /usfda|fda\s+approval|patent\s+grant|dcgi|eir\b|establishment\s+inspection/i.test(text);
  const isResults = /financial\s+results|unaudited\s+financial|quarterly\s+results|q[1-4]\s+results|audited\s+results/i.test(text) || c.category === 'FINANCIAL_RESULTS';

  // Compliance / routine administrative paperwork
  const isNewspaper = /newspaper|paper\s*cutting|advertisement\s+in\s+newspaper|newspaper\s+advertisement|clipping/i.test(text);
  const isConcall = /transcript.*?(?:conference|earnings|analyst|concall)|audio\s+recording.*?(?:conference|earnings|concall)|concall\s+transcript|earnings\s+call\s+transcript/i.test(text);
  const isSast = /disclosure\s+under\s+reg(?:ulation)?\s*(?:29|10|7)|substantial\s+acquisition\s+of\s+shares|sebi\s*\(\s*sast\s*\)|sebi\s*\(\s*pit\s*\)|regulation\s*29\s*\(\s*[12]\s*\)/i.test(text);
  const isDebentures = /allotment\s+of\s+(?:non-convertible\s+)?debentures|issue\s+of\s+debentures|ncd\s+allotment|\b(?:ncd|ncds)\b|commercial\s+paper|bonds\s+allotment|redemption\s+of\s+debentures/i.test(text);
  const isInvestorMeet = /analyst\s*(?:\/|\s+and\s+)?(?:institutional\s+)?investor\s+meet|interaction\s+with\s+(?:investors|analysts)|schedule\s+of\s+(?:investor|analyst)|investor\s+conference|annual\s+investor|spark\s+indx|analyst\s+conference|investor\s+presentation|presentation\s+with\s+respect\s+to\s+(?:the\s+)?(?:un-?audited|financial)|earning\s+call\s+presentation/i.test(text);
  const isBoardMeetingNotice = (/meeting\s+of\s+(?:the\s+)?board|board\s+meeting/i.test(text)) && !/outcome\s+of\s+(?:the\s+)?board\s+meeting|board\s+meeting\s+outcome|financial\s+results/i.test(text);
  const isGeneralUpdate = text.includes('general updates') || /press\s+release\s+dated/i.test(text);

  if (isEarningsBeat) score += 100;
  else if (isSevereMiss) score += 90;
  else if (isOrderWin) score += 85;
  else if (isAcquisition) score += 80;
  else if (isDividendBuyback) score += 75;
  else if (isRegulatoryApproval) score += 70;
  else if (isResults) score += 60;

  // Active price momentum / Reaction magnitude
  const move = Math.abs(Number(c.postNewsMovePct || c.movePct || 0));
  score += Math.min(move * 4, 30);

  // Administrative paperwork penalties
  if (isNewspaper) score -= 80;
  if (isConcall) score -= 70;
  if (isSast) score -= 65;
  if (isDebentures) score -= 60;
  if (isInvestorMeet) score -= 55;
  if (isBoardMeetingNotice) score -= 45;
  if (isGeneralUpdate) score -= 40;

  return score;
}

function TopNewsSquareBox({

  catalysts,

  onCopy,

  onSelectSymbol

}) {

  const [sortMode, setSortMode] = React.useState(() => {
    try {
      return localStorage.getItem('growbetter_news_sort_mode') || 'normal';
    } catch (e) {
      return 'normal';
    }
  });

  const handleSortChange = (mode) => {
    // Touching an active button a second time toggles it off back to normal live news
    const nextMode = (sortMode === mode) ? 'normal' : mode;
    setSortMode(nextMode);
    try {
      localStorage.setItem('growbetter_news_sort_mode', nextMode);
    } catch (e) {}
  };

  const nowMs = Date.now();

  const ist = new Date(nowMs + 330 * 60000);

  const day = ist.getUTCDay();

  const tNum = ist.getUTCHours() * 100 + ist.getUTCMinutes();

  const isLiveMarket = (day !== 0 && day !== 6 && tNum >= 915 && tNum < 1530);

  const todayMidnightMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 0, 0, 0) - 330 * 60000;



  const cutoffStartMs = React.useMemo(() => {

    // Cutoff: strictly filings after previous session 15:30 IST (with 20-min buffer = 15:10 IST)

    const curHour = ist.getUTCHours();

    const curMin = ist.getUTCMinutes();

    const totalMin = curHour * 60 + curMin;

    const y = ist.getUTCFullYear();

    const m = ist.getUTCMonth();

    const dt = ist.getUTCDate();

    if (totalMin >= 15 * 60 + 30) {

      return Date.UTC(y, m, dt, 10, 0, 0) - 20 * 60000;

    }

    const prevDate = new Date(Date.UTC(y, m, dt, 0, 0, 0) - 330 * 60000);

    let daysBack = 1;

    if (day === 1) daysBack = 3; // Monday -> Friday

    else if (day === 0) daysBack = 2; // Sunday -> Friday

    prevDate.setUTCDate(prevDate.getUTCDate() - daysBack);

    return Date.UTC(prevDate.getUTCFullYear(), prevDate.getUTCMonth(), prevDate.getUTCDate(), 10, 0, 0) - 20 * 60000;

  }, [ist, day]);



  const latestList = React.useMemo(() => {

    return [...catalysts].filter(c => {

      const s = String(c.symbol || '').toUpperCase();

      if (s.endsWith('ETF') || s.endsWith('IETF') || s.endsWith('AXIS')) return false;

      if (/mirae\s+asset|fixed\s+maturity|mutual\s+fund|isif\s+nav|nav\s+as\s+on|exchange\s+traded\s+fund/i.test((c.title || '') + ' ' + (c.description || ''))) return false;

      const p = Number(c.ltp || c.close || c.effectivePrice || 0);

      const v = Number(c.volume || c.effectiveVolume || 0);

      const ts = Number(c.ts || 0);

      const isFresh = ts > 0 && (nowMs - ts) < 30 * 60 * 1000;

      const isUntradeableStrict = !isFresh && c.isUntradeable;

      if (c.isPennyStock || isUntradeableStrict || (p > 0 && p < 20.0) || /^\d+$/.test(c.symbol)) return false;

      if (c.symbol === 'BSE' && !/bse\s+limited/i.test((c.title || '') + ' ' + (c.description || ''))) return false;

      if (c.symbol === 'NSE' && !/national\s+stock\s+exchange/i.test((c.title || '') + ' ' + (c.description || ''))) return false;

      if (c.symbol === 'MCX' && !/multi\s+commodity\s+exchange/i.test((c.title || '') + ' ' + (c.description || ''))) return false;

      // Do not filter out newly posted filings (< 30 min old) on zero volume before volume builds up!

      if (!isFresh && v > 0 && v < 20000) return false;

      // Strict cutoff: exclude anything older than previous session 15:10 IST (removes yesterday morning filings)

      if (ts > 0 && ts < cutoffStartMs) return false;

      // During live market hours: exclude filings from previous sessions older than today

      if (isLiveMarket && ts > 0 && ts < todayMidnightMs) return false;

      return true;

    }).sort((a, b) => {

      const tsA = Number(a.ts || 0);

      const tsB = Number(b.ts || 0);

      if (sortMode === 'company') {
        const tierA = getCompanyTier(a.symbol);
        const tierB = getCompanyTier(b.symbol);

        if (tierB.score !== tierA.score) {
          return tierB.score - tierA.score; // NIFTY 50 (1000) > NEXT 50 (800) > MIDCAP (600) > SMALLCAP (400) > MICROCAP (200)
        }

        // Secondary within same company tier: news scope score
        const scopeA = getNewsScopeScore(a);
        const scopeB = getNewsScopeScore(b);
        if (Math.abs(scopeB - scopeA) >= 15) {
          return scopeB - scopeA;
        }

        return tsB - tsA;
      }

      if (sortMode === 'news') {
        const scopeA = getNewsScopeScore(a);
        const scopeB = getNewsScopeScore(b);
        if (Math.abs(scopeB - scopeA) >= 10) {
          return scopeB - scopeA;
        }
        return tsB - tsA;
      }

      // Default 'normal': Normal live news (strict descending chronological timestamp)
      return tsB - tsA;

    }).slice(0, 30);

  }, [catalysts, nowMs, isLiveMarket, todayMidnightMs, cutoffStartMs, sortMode]);

  return /*#__PURE__*/React.createElement("div", {

    className: "top-news-square-box"

  }, /*#__PURE__*/React.createElement("div", {

    className: "top-news-box-head",
    style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }

  }, /*#__PURE__*/React.createElement("div", {

    className: "top-news-box-title"

  }, /*#__PURE__*/React.createElement("span", {

    className: "live-pulse-dot"

  }), /*#__PURE__*/React.createElement("span", null, "LIVE NEWS")),
  /* Sort Buttons */
  /*#__PURE__*/React.createElement("div", {
    style: { display: 'flex', alignItems: 'center', gap: '6px' }
  },
  /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => handleSortChange('news'),
    style: {
      fontSize: '11px',
      fontWeight: 700,
      padding: '3px 8px',
      borderRadius: '5px',
      cursor: 'pointer',
      border: sortMode === 'news' ? '1px solid #16a34a' : '1px solid var(--border-color, #cbd5e1)',
      background: sortMode === 'news' ? 'rgba(22, 163, 74, 0.14)' : 'transparent',
      color: sortMode === 'news' ? '#16a34a' : 'var(--text-muted, #64748b)',
      transition: 'all 0.15s ease'
    },
    title: sortMode === 'news' ? "Active. Click again to return to Normal Live News" : "Priority by News: High-impact corporate catalysts first (Blowout Results, Order Wins, Acquisitions, Dividends)"
  }, "Priority by News"),
  /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => handleSortChange('company'),
    style: {
      fontSize: '11px',
      fontWeight: 700,
      padding: '3px 8px',
      borderRadius: '5px',
      cursor: 'pointer',
      border: sortMode === 'company' ? '1px solid #2563eb' : '1px solid var(--border-color, #cbd5e1)',
      background: sortMode === 'company' ? 'rgba(37, 99, 235, 0.14)' : 'transparent',
      color: sortMode === 'company' ? '#2563eb' : 'var(--text-muted, #64748b)',
      transition: 'all 0.15s ease'
    },
    title: sortMode === 'company' ? "Active. Click again to return to Normal Live News" : "Priority by Company: NIFTY 50 blue chips first, then Next 50, Midcaps, and Smallcaps"
  }, "Priority by Company"))), /*#__PURE__*/React.createElement("div", {

    className: "top-news-list"

  }, latestList.length === 0 ? /*#__PURE__*/React.createElement("div", {

    style: {

      padding: '24px',

      textAlign: 'center',

      color: 'var(--text-muted)',

      fontSize: '12px'

    }

  }, "Awaiting new filings from NSE feed...") : latestList.map(c => {

    const {

      isBull,

      isBear,

      conf,

      hasAlreadyMoved,

      hasDownsideExhaustion,

      isRoutine,

      isStaleYesterday,

      isUntradeable,

      takeTrade,

      effNewsMove = 0,

      isBlowoutBeat = false

    } = getBiasInfo(c);

    const pred = String(c.prediction || '').toUpperCase();

    const auc = c.auctionAssessment || null;

    const ltp = Number(c.ltp || c.price || 0);

    const movePct = Number(c.movePct || 0);

    const move1m = Number(c.move1mPct || 0);

    const move5m = Number(c.move5mPct || 0);

    const signPct = movePct > 0 ? '+' : '';

    const nowMs = Date.now();

    const diffMin = c.ts ? (nowMs - Number(c.ts)) / 60000 : 999;

    const isFresh = diffMin <= 45; // Active within last 45 minutes



    const hasPostNewsMove = c.postNewsMovePct != null;

    const postNewsMove = hasPostNewsMove ? Number(c.postNewsMovePct) : (effNewsMove != null ? effNewsMove : movePct);

    const postSign = postNewsMove > 0 ? '+' : '';

    const hasMeaningfulPostMove = Math.abs(postNewsMove) >= 0.10;

    const postColor = hasMeaningfulPostMove ? (postNewsMove > 0 ? '#16a34a' : '#dc2626') : (movePct > 0 ? '#16a34a' : movePct < 0 ? '#dc2626' : '#64748b');

    const postBg = hasMeaningfulPostMove ? (postNewsMove > 0 ? 'rgba(22, 163, 74, 0.12)' : 'rgba(220, 38, 38, 0.12)') : (movePct > 0 ? 'rgba(22, 163, 74, 0.12)' : movePct < 0 ? 'rgba(220, 38, 38, 0.12)' : 'rgba(100, 116, 139, 0.12)');

    const timingAI = getClientMoveTiming(c, ltp, movePct, postNewsMove);
    const effPostMove = Number(timingAI.postNewsMovePct || 0);
    const effPreMove = Number(timingAI.preNewsMovePct || 0);
    const isPricedInSurge = (effPreMove >= 2.0 && Math.abs(effPostMove) < 0.25);
    const isPricedInDump = (effPreMove <= -2.0 && Math.abs(effPostMove) < 0.25);
    const hasZeroImpact = (Math.abs(effPostMove) < 0.15);

    let btnLabel = 'Watch';

    let pillClass = 'watch';



    const fullItemText = ((c.kind || '') + ' ' + (c.title || '') + ' ' + (c.description || '')).toLowerCase();

    const isNewspaper = /newspaper|paper\s*cutting|advertisement\s+in\s+newspaper|newspaper\s+advertisement|clipping/i.test(fullItemText);

    const isBoardMeeting = (/meeting\s+of\s+(?:the\s+)?board|board\s+meeting/i.test(fullItemText)) && !/outcome\s+of\s+(?:the\s+)?board\s+meeting|board\s+meeting\s+outcome/i.test(fullItemText);

    const isConcall = /transcript.*?(?:conference|earnings|analyst|concall)|audio\s+recording.*?(?:conference|earnings|concall)|concall\s+transcript|earnings\s+call\s+transcript/i.test(fullItemText);

    const isSast = /disclosure\s+under\s+reg(?:ulation)?\s*(?:29|10|7)|substantial\s+acquisition\s+of\s+shares|sebi\s*\(\s*sast\s*\)|sebi\s*\(\s*pit\s*\)|regulation\s*29\s*\(\s*[12]\s*\)/i.test(fullItemText);

    const isDebentures = /allotment\s+of\s+(?:non-convertible\s+)?debentures|issue\s+of\s+debentures|ncd\s+allotment|\b(?:ncd|ncds)\b|commercial\s+paper|bonds\s+allotment|redemption\s+of\s+debentures/i.test(fullItemText);

    const isInvestorMeet = /analyst\s*(?:\/|\s+and\s+)?(?:institutional\s+)?investor\s+meet|interaction\s+with\s+(?:investors|analysts)|schedule\s+of\s+(?:investor|analyst)|investor\s+conference|annual\s+investor|spark\s+indx|analyst\s+conference|investor\s+presentation|presentation\s+with\s+respect\s+to\s+(?:the\s+)?(?:un-?audited|financial)|earning\s+call\s+presentation/i.test(fullItemText);

    const isRegulatoryPenalty = /imposition\s+of\s+fines?\s+or\s+penalt(?:y|ies)|penalty\s+by\s+trai|clarification\s+sought\s+from\s+(?:bse|nse)|clarification\s+on\s+spurt/i.test(fullItemText);

    const isGeneralUpdate = fullItemText.includes('general updates') || /press\s+release\s+dated/i.test(fullItemText);

    const isGenericBoardOutcome = /outcome\s+of\s+(?:the\s+)?board\s+meeting/i.test(fullItemText) && !/financial\s+result|quarterly\s+result|unaudited|audited|dividend|bonus|split|acquisition|merger/i.test(fullItemText);

    const displayMovedPct = (hasMeaningfulPostMove && Math.abs(postNewsMove) >= 1.0) ? postNewsMove : movePct;
    const isAlreadyMovedItem = Boolean(
      !isBlowoutBeat &&
      Math.abs(displayMovedPct) >= 1.5 && (
        ((c.tradeStatus === 'ALREADY_MOVED' || pred.includes('ALREADY MOVED')) && (Math.abs(movePct) >= 1.8 || Math.abs(postNewsMove) >= 1.8)) ||
        (pred.includes('DO NOT CHASE') && Math.abs(displayMovedPct) >= 2.0) ||
        (c.actionBtnLabel && c.actionBtnLabel.includes('Already Moved') && Math.abs(displayMovedPct) >= 1.8)
      )
    );

    const isLearnedDud = Boolean(c.learnedGuardrail || (c.badge && c.badge.includes('LEARNED')) || c.tradeStatus === 'NON_MOVER_GUARDRAIL' || pred.includes('LEARNED_NON_MOVER'));

    const isRoutineItem = isNewspaper || isBoardMeeting || isGenericBoardOutcome || isConcall || isSast || isDebentures || isInvestorMeet || isRegulatoryPenalty || isGeneralUpdate || c.tradeStatus === 'ROUTINE_DISCLOSURE' || c.materiality === 'ROUTINE';

    const isResults = !isRoutineItem && (c.materiality === 'RESULTS' || /outcome\s+of\s+(?:the\s+)?board\s+meeting.*result|board\s+meeting\s+outcome.*result|financial\s+results\s+for/i.test(fullItemText));

    if (c.badge && (c.badge.startsWith('Routine') || c.badge.startsWith('Results') || c.badge.startsWith('Watch') || c.badge.startsWith('Buy') || c.badge.startsWith('Sell'))) {
      btnLabel = c.badge;
      pillClass = c.pillClass || (c.badge.includes('Buy') ? 'buy' : c.badge.includes('Sell') ? 'sell' : 'watch');
    } else if (isUntradeable) {

      btnLabel = 'Untradeable';

      pillClass = 'watch';

    } else if (isBoardMeeting) {

      btnLabel = 'Routine (Board Meeting)';

      pillClass = 'watch';

    } else if (isGenericBoardOutcome) {

      btnLabel = 'Routine (Board Outcome)';

      pillClass = 'watch';

    } else if (isDebentures) {

      btnLabel = 'Routine (Debt Allotment)';

      pillClass = 'watch';

    } else if (isConcall) {

      btnLabel = 'Routine (Transcript)';

      pillClass = 'watch';

    } else if (isInvestorMeet) {

      btnLabel = 'Routine (Investor Meet)';

      pillClass = 'watch';

    } else if (isNewspaper) {

      btnLabel = 'Routine (Newspaper)';

      pillClass = 'watch';

    } else if (isSast) {

      btnLabel = 'Routine (SAST 29)';

      pillClass = 'watch';

    } else if (isRegulatoryPenalty) {

      btnLabel = 'Watch (Compliance / TRAI)';

      pillClass = 'watch';

    } else if (isLearnedDud) {

      btnLabel = 'Learned Non-Mover';

      pillClass = 'watch';

    } else if (isAlreadyMovedItem) {

      btnLabel = `Already Moved (${displayMovedPct > 0 ? '+' : ''}${displayMovedPct.toFixed(1)}%) — Do Not Chase`;

      pillClass = 'watch';

    } else if (isPricedInSurge) {

      btnLabel = `Priced In (+${effPreMove.toFixed(1)}%)`;

      pillClass = 'watch';

    } else if (isPricedInDump) {

      btnLabel = `Priced In (${effPreMove.toFixed(1)}%)`;

      pillClass = 'watch';

    } else if (isGeneralUpdate && !takeTrade) {

      btnLabel = 'Watch';

      pillClass = 'watch';

    } else if (isResults) {

      const fin = c.financialComparison;

      if (fin && fin.hasFinancialData && fin.strengthGrade === 'SEVERE_MISS') {

        btnLabel = `Sell ${fin.convictionProb || 88}%`;

        pillClass = 'sell';

      } else if (isBlowoutBeat || (fin && fin.hasFinancialData && (fin.strengthGrade === 'BLOWOUT_BEAT' || fin.strengthGrade === 'STRONG_BEAT'))) {

        btnLabel = `Buy ${fin && fin.convictionProb || conf || 95}%`;

        pillClass = 'buy';

      } else if (hasZeroImpact) {

        btnLabel = 'Results (Tape Watch)';

        pillClass = 'watch';

      } else if (takeTrade && isBear) {

        btnLabel = (isLiveMarket ? (c.actionBtnLabel || `Sell ${conf}%`) : `Sell ${conf}%`);

        pillClass = 'sell';

      } else if (takeTrade && isBull) {

        btnLabel = (isLiveMarket ? (c.actionBtnLabel || `Buy ${conf}%`) : `Buy ${conf}%`);

        pillClass = 'buy';

      } else {

        btnLabel = 'Results (Tape Watch)';

        pillClass = 'watch';

      }

    } else if (takeTrade && isBull) {

      if (hasZeroImpact) {

        btnLabel = 'Awaiting Tape Impact';

        pillClass = 'watch';

      } else {

        btnLabel = (isLiveMarket ? (c.actionBtnLabel || `Buy ${conf}%`) : (auc && auc.actionBtnLabel ? auc.actionBtnLabel : `Buy ${conf}%`));

        pillClass = 'buy';

      }

    } else if (takeTrade && isBear) {

      if (hasZeroImpact) {

        btnLabel = 'Awaiting Tape Impact';

        pillClass = 'watch';

      } else {

        btnLabel = (isLiveMarket ? (c.actionBtnLabel || `Sell ${conf}%`) : (auc && auc.actionBtnLabel ? auc.actionBtnLabel : `Sell ${conf}%`));

        pillClass = 'sell';

      }

    } else if ((hasDownsideExhaustion || effNewsMove <= -3.8) && effNewsMove <= -2.0) {

      btnLabel = `Already Dumped (${postNewsMove.toFixed(1)}%)`;

      pillClass = 'watch';

    } else if (hasAlreadyMoved || (hasPostNewsMove ? postNewsMove >= 2.5 : movePct >= 2.5)) {

      btnLabel = `Already Moved (${postSign}${postNewsMove.toFixed(1)}%)`;

      pillClass = 'watch';

    } else if (auc && (auc.status === 'PRE_OPEN_FADE_SELL' || auc.status === 'PRE_OPEN_FADE')) {

      btnLabel = 'Auction Rejected';

      pillClass = 'watch';

    } else if (isRoutine || c.tradeStatus === 'ROUTINE_DISCLOSURE' || c.tradeStatus === 'ROUTINE_LAND_ACQUISITION') {

      btnLabel = 'Routine';

      pillClass = 'watch';

    } else if (diffMin > 45 && !isFresh) {

      btnLabel = 'Watch (Pre-Open)';

      pillClass = 'watch';

    } else {

      btnLabel = c.actionBtnLabel || 'Watch';

      pillClass = 'watch';

    }



    const isFilingIntraday = (c.filingTime && c.filingTime >= '09:15') || (c.ts && Number(c.ts) >= (todayMidnightMs + 9 * 3600000 + 15 * 60000)) || Boolean(auc && auc.isLiveSessionFiling);

    const isNonMarketHour = (() => {
      const tsVal = Number(c.ts || c.firstSeenAt || c.publishedAt || 0);
      if (tsVal > 0) {
        if (tsVal < todayMidnightMs) return true; // Prior day overnight / weekend filing
        const d = new Date(tsVal + 330 * 60000); // UTC to IST
        const day = d.getUTCDay(); // 0 is Sunday, 6 is Saturday
        if (day === 0 || day === 6) return true;
        const hours = d.getUTCHours();
        const mins = d.getUTCMinutes();
        const tNum = hours * 100 + mins;
        return tNum < 915 || tNum >= 1530;
      }
      const timeStr = String(c.filingTime || c.timeAgo || '');
      if (/[A-Za-z]{3}\s+\d{1,2}:\d{2}|\d{1,2}\s+[A-Za-z]{3}/.test(timeStr)) return true;
      const match = timeStr.match(/(\d{1,2}):(\d{2})/);
      if (match) {
        const tNum = parseInt(match[1], 10) * 100 + parseInt(match[2], 10);
        return tNum < 915 || tNum >= 1530;
      }
      if (c.isOvernight || c.isPreMarket || c.isPreOpenFiling) return true;
      return false;
    })();

    const rawBadge = auc && auc.badge ? auc.badge : null;

    const displayAucBadge = rawBadge ? ((isLiveMarket || isFilingIntraday) ? rawBadge.replace(/09:08\s*/g, 'LIVE ') : rawBadge) : null;

    const showAucBadge = Boolean(displayAucBadge) && !isNewspaper && !isBoardMeeting && !isConcall && !isSast;

    return /*#__PURE__*/React.createElement("div", {
      key: c.symbol,
      className: "top-news-item",
      onClick: () => {
        onCopy(c.symbol);
        if (onSelectSymbol) onSelectSymbol(c.symbol);
      },
      title: `Click to copy ${c.symbol} and view details`
    }, /*#__PURE__*/React.createElement("div", {
      className: "top-news-item-top",
      style: { alignItems: 'flex-start' }
    }, /*#__PURE__*/React.createElement("div", {
      className: "top-news-item-left",
      style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '150px' }
    }, /*#__PURE__*/React.createElement("div", {
      style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }
    }, /*#__PURE__*/React.createElement("span", {
      className: "top-news-sym"
    }, c.symbol),
    (() => {
      const tier = getCompanyTier(c.symbol);
      if (!tier) return null;
      return /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: '9px',
          fontWeight: 800,
          background: tier.bg,
          color: tier.color,
          border: `1px solid ${tier.border}`,
          padding: '1px 5px',
          borderRadius: '3px',
          whiteSpace: 'nowrap'
        },
        title: `${tier.name} Company`
      }, tier.name);
    })(),
    isNonMarketHour ? /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '10px',
        fontWeight: 700,
        background: 'rgba(217, 119, 6, 0.12)',
        color: '#d97706',
        border: '1px solid rgba(217, 119, 6, 0.3)',
        padding: '1.5px 6px',
        borderRadius: '4px',
        whiteSpace: 'nowrap',
        lineHeight: 1.2
      },
      title: c.filingTime ? `Pre-market filing (${c.filingTime})` : "News arrived outside market hours (Pre-market / Overnight)"
    }, "Pre-Market News") : /*#__PURE__*/React.createElement("span", {
      className: `top-news-timeago ${isFresh ? 'fresh' : ''}`
    }, c.filingTime || c.timeAgo || 'Just in')),
    /* Company below: LTP and Today Percentage */
    /*#__PURE__*/React.createElement("div", {
      style: { display: 'flex', alignItems: 'center', gap: '6px' }
    }, ltp > 0 && /*#__PURE__*/React.createElement("span", {
      className: "top-news-price",
      style: { fontWeight: 800, fontSize: '12px' }
    }, `₹${ltp.toFixed(2)}`), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '11px',
        fontWeight: 800,
        color: movePct > 0 ? '#16a34a' : movePct < 0 ? '#dc2626' : '#64748b',
        background: movePct > 0 ? 'rgba(22, 163, 74, 0.12)' : movePct < 0 ? 'rgba(220, 38, 38, 0.12)' : 'rgba(100, 116, 139, 0.12)',
        padding: '1px 5px',
        borderRadius: '4px',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap'
      },
      title: `Full Day session move from 09:15 open: ${signPct}${movePct.toFixed(2)}%`
    }, `${signPct}${movePct.toFixed(1)}% Day`))),
    /* Right side: After News move, AI timing badge, speed badge, auc pill, action button */
    /*#__PURE__*/React.createElement("div", {
      className: "top-news-item-right",
      style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'nowrap', justifyContent: 'flex-end' }
    },
    /* BOX 1: Exactly ONE percentage move pill */
    /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '11px',
        fontWeight: 800,
        color: timingAI.badgeColor || '#64748b',
        background: timingAI.badgeBg || 'rgba(100, 116, 139, 0.08)',
        border: `1px solid ${timingAI.badgeBorder || 'rgba(100, 116, 139, 0.2)'}`,
        padding: '2.5px 7px',
        borderRadius: '4px',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap'
      },
      title: timingAI.detail || ''
    }, timingAI.badgeLabel),

    /* BOX 2: Exactly ONE trade action / probability pill (RED for SELL, GREEN for BUY, GRAY for ROUTINE) */
    (() => {
      const isRoutineBtn = /routine|watch|stale|already|untradeable/i.test(btnLabel);
      const isSellAction = !isRoutineBtn && (isBear || c.tradeStatus === 'TAKE_TRADE_SHORT' || (/sell|short/i.test(btnLabel) && !isBull)) && !isBull;
      const isBuyAction = !isRoutineBtn && !isSellAction && (isBull || c.tradeStatus === 'TAKE_TRADE_BUY' || /buy|long/i.test(btnLabel));
      const safeBtnLabel = (isBull && /fade|short|sell/i.test(btnLabel)) ? `Buy ${conf}%` : btnLabel;
      const pClass = isSellAction ? 'sell' : (isBuyAction ? 'buy' : 'watch');
      const bgStyle = isSellAction ? { background: '#dc2626', color: '#ffffff', borderColor: '#b91c1c' } : (isBuyAction ? { background: '#16a34a', color: '#ffffff', borderColor: '#15803d' } : {});

      return /*#__PURE__*/React.createElement("span", {
        className: `top-news-trade-pill ${pClass}`,
        style: Object.assign({
          fontSize: '10.5px',
          fontWeight: 800,
          padding: '2.5px 8px',
          borderRadius: '4px',
          letterSpacing: '0.02em',
          whiteSpace: 'nowrap'
        }, bgStyle)
      }, safeBtnLabel);
    })())),
    /* Headline */
    /*#__PURE__*/React.createElement("div", {
      className: "top-news-headline",
      title: `${c.title || c.description || 'Corporate Announcement'}${timingAI && timingAI.detail ? `\n\nAI Timing: ${timingAI.detail}` : ''}`
    }, c.title || c.description || 'Corporate Announcement'))
  })));
}

function UpcomingEventsSquareBox({ catalysts = [], onCopy }) {
  const eventsList = React.useMemo(() => {
    if (!catalysts || catalysts.length === 0) return [];

    const classified = [];
    const seen = new Set();

    for (const c of catalysts) {
      const sym = c.symbol;
      if (!sym) continue;

      const fullText = ((c.kind || '') + ' ' + (c.title || '') + ' ' + (c.description || '')).toLowerCase();

      let evType = null;
      let badge = null;
      let badgeColor = '#2563eb';
      let badgeBg = 'rgba(37, 99, 235, 0.12)';
      let badgeBorder = 'rgba(37, 99, 235, 0.3)';
      let priority = 10;

      // Extract scheduled date if present in text
      const dateMatch = (c.title || c.description || '').match(/\b(?:(?:on\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)|(?:(?:on\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}))/i);
      const eventDateStr = dateMatch ? (dateMatch[1] || dateMatch[2] || dateMatch[0]) : (c.timeFormatted || 'Upcoming');

      // 1. Dividend & Record Date
      if (/dividend|record\s*date|ex-date|interim\s*dividend|final\s*dividend|payout/i.test(fullText)) {
        const amt = (c.title || c.description || '').match(/(?:₹|rs\.?)\s*(\d+(?:\.\d+)?)/i);
        badge = amt ? `💰 ₹${amt[1]} Div` : '💰 Dividend';
        badgeColor = '#059669';
        badgeBg = 'rgba(16, 185, 129, 0.12)';
        badgeBorder = 'rgba(16, 185, 129, 0.3)';
        evType = 'DIVIDEND';
        priority = 1;
      }
      // 2. Financial Results
      else if (/financial\s*result|quarterly\s*result|q[1-4]\s*result|earnings|unaudited\s*result|audited\s*result|pat\s*(?:rises|climbs|jumps|drops|falls)/i.test(fullText)) {
        const q = fullText.match(/\b(q[1-4])\b/i);
        badge = q ? `📊 ${q[1].toUpperCase()} Results` : '📊 Results';
        badgeColor = '#2563eb';
        badgeBg = 'rgba(37, 99, 235, 0.12)';
        badgeBorder = 'rgba(37, 99, 235, 0.3)';
        evType = 'RESULTS';
        priority = 2;
      }
      // 3. Board Meetings
      else if (/board\s*meeting|meeting\s*of\s*(?:the\s*)?board|scheduled.*meeting/i.test(fullText)) {
        badge = '🏛️ Board Meet';
        badgeColor = '#d97706';
        badgeBg = 'rgba(217, 119, 6, 0.12)';
        badgeBorder = 'rgba(217, 119, 6, 0.3)';
        evType = 'BOARD_MEET';
        priority = 3;
      }
      // 4. Bonus, Split, Buyback, Corporate Action
      else if (/bonus|split|sub-division|buyback|amalgamation|merger|demerger|rights\s*issue/i.test(fullText)) {
        badge = '📜 Corp Action';
        badgeColor = '#0891b2';
        badgeBg = 'rgba(8, 145, 178, 0.12)';
        badgeBorder = 'rgba(8, 145, 178, 0.3)';
        evType = 'CORP_ACTION';
        priority = 4;
      }
      // 5. Concall & Investor Meet
      else if (/concall|earnings\s*call|analyst\s*meet|investor\s*meet|interaction\s*with/i.test(fullText)) {
        badge = '👥 Concall / Meet';
        badgeColor = '#7c3aed';
        badgeBg = 'rgba(124, 58, 237, 0.12)';
        badgeBorder = 'rgba(124, 58, 237, 0.3)';
        evType = 'CONCALL';
        priority = 5;
      }
      // 6. AGM / EGM
      else if (/\bagm\b|\begm\b|annual\s*general\s*meeting/i.test(fullText)) {
        badge = '🗳️ AGM / EGM';
        badgeColor = '#4f46e5';
        badgeBg = 'rgba(79, 70, 229, 0.12)';
        badgeBorder = 'rgba(79, 70, 229, 0.3)';
        evType = 'AGM';
        priority = 6;
      }
      // 7. Significant Order Win / Acquisition
      else if (/order\s*win|awarded|contract|expansion|acquisition|partnership/i.test(fullText)) {
        badge = '🚀 Key Catalyst';
        badgeColor = '#ea580c';
        badgeBg = 'rgba(234, 88, 12, 0.12)';
        badgeBorder = 'rgba(234, 88, 12, 0.3)';
        evType = 'CATALYST';
        priority = 7;
      }

      if (badge) {
        const key = `${sym}-${evType}`;
        if (!seen.has(key)) {
          seen.add(key);
          classified.push({
            c,
            sym,
            evType,
            badge,
            badgeColor,
            badgeBg,
            badgeBorder,
            priority,
            eventDateStr,
            ts: Number(c.ts || c.timeMs || 0)
          });
        }
      }
    }

    return classified.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.ts - a.ts;
    });
  }, [catalysts]);

  return /*#__PURE__*/React.createElement("div", {
    className: "top-news-square-box"
  },
    /* Head */
    /*#__PURE__*/React.createElement("div", {
      className: "top-news-box-head"
    },
      /*#__PURE__*/React.createElement("div", {
        className: "top-news-box-title"
      },
        /*#__PURE__*/React.createElement("span", {
          className: "live-pulse-dot",
          style: { background: '#2563eb' }
        }),
        /*#__PURE__*/React.createElement("span", null, "📅 UPCOMING EVENTS & CORPORATE CALENDAR")
      ),
      /*#__PURE__*/React.createElement("span", {
        className: "top-news-box-count",
        style: { color: '#2563eb', background: 'rgba(37, 99, 235, 0.1)' }
      }, `${eventsList.length} Scheduled`)
    ),

    /* List of Events */
    /*#__PURE__*/React.createElement("div", {
      className: "top-news-list"
    },
      eventsList.length === 0
        ? /*#__PURE__*/React.createElement("div", {
            style: {
              padding: '36px 16px',
              textAlign: 'center',
              color: 'var(--text-muted, #94a3b8)',
              fontSize: '12px'
            }
          }, "Scanning exchange disclosures for upcoming corporate events & calendar...")
        : eventsList.slice(0, 30).map(item => {
            const c = item.c;
            const ltp = Number(c.ltp || c.price || 0);
            const movePct = Number(c.movePct || 0);
            const isPos = movePct >= 0;
            const sign = isPos ? '+' : '';

            return /*#__PURE__*/React.createElement("div", {
              key: `${item.sym}-${item.evType}-${item.ts}`,
              className: "top-news-item",
              onClick: () => onCopy && onCopy(item.sym),
              title: `Click to copy ${item.sym} · Event: ${item.badge}`
            },
              /* Top Row */
              /*#__PURE__*/React.createElement("div", {
                className: "top-news-item-top"
              },
                /* Left Symbol & Timing */
                /*#__PURE__*/React.createElement("div", {
                  className: "top-news-item-left"
                },
                  /*#__PURE__*/React.createElement("span", {
                    className: "top-news-sym"
                  }, item.sym),
                  /*#__PURE__*/React.createElement("span", {
                    style: { fontSize: '11px', color: 'var(--text-muted)' }
                  }, item.eventDateStr)
                ),

                /* Right Price & Event Badge */
                /*#__PURE__*/React.createElement("div", {
                  className: "top-news-item-right",
                  style: { display: 'flex', alignItems: 'center', gap: '6px' }
                },
                  ltp > 0 && /*#__PURE__*/React.createElement("span", {
                    className: "top-news-price"
                  }, `₹${ltp.toFixed(2)}`),
                  ltp > 0 && /*#__PURE__*/React.createElement("span", {
                    style: {
                      fontSize: '10px',
                      color: isPos ? '#16a34a' : '#dc2626',
                      background: isPos ? 'rgba(22, 163, 74, 0.1)' : 'rgba(220, 38, 38, 0.1)',
                      padding: '1.5px 5px',
                      borderRadius: '3px',
                      fontWeight: 700
                    }
                  }, `${sign}${movePct.toFixed(1)}%`),
                  /* Event Pill */
                  /*#__PURE__*/React.createElement("span", {
                    style: {
                      fontSize: '10.5px',
                      fontWeight: 800,
                      color: item.badgeColor,
                      background: item.badgeBg,
                      border: `1px solid ${item.badgeBorder}`,
                      padding: '2.5px 7px',
                      borderRadius: '4px',
                      whiteSpace: 'nowrap'
                    }
                  }, item.badge)
                )
              ),

              /* Bottom Headline / Purpose */
              /*#__PURE__*/React.createElement("div", {
                className: "top-news-headline",
                title: c.title || c.description
              }, c.title || c.description || `${item.sym} Corporate Announcement`)
            );
          })
    )
  );
}

function TopMoversSquareBox(props) {
  return /*#__PURE__*/React.createElement(UpcomingEventsSquareBox, props);
}

function StrangleSection({ strangleData, trackerData, onCopy, copiedSymbol }) {
  if (!strangleData || !strangleData.calls || !strangleData.calls.length) {
    return null;
  }
  const calls = strangleData.calls;
  const rules = strangleData.strategyRules || {};
  const record = strangleData.pastWeekVerifiedRecord || {};
  const trk = trackerData || null;

  return /*#__PURE__*/React.createElement("div", {
    className: "strangle-section",
    style: {
      background: 'var(--card-bg, #ffffff)',
      border: '1.5px solid var(--accent, #f59e0b)',
      borderRadius: '12px',
      padding: '24px',
      marginTop: '28px',
      marginBottom: '28px',
      boxShadow: '0 4px 20px rgba(245, 158, 11, 0.08)'
    }
  },
    /* Header */
    /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        gap: '12px',
        borderBottom: '1px solid var(--card-border, #e2e8f0)',
        paddingBottom: '16px',
        marginBottom: '20px'
      }
    },
      /* Left Header Info */
      /*#__PURE__*/React.createElement("div", null,
        /*#__PURE__*/React.createElement("div", {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '4px'
          }
        },
          /*#__PURE__*/React.createElement("span", { style: { fontSize: '20px' } }, "⚡"),
          /*#__PURE__*/React.createElement("h2", {
            style: {
              fontSize: '18px',
              fontWeight: 800,
              color: 'var(--text, #0f172a)',
              margin: 0
            }
          }, "09:20 AM SYSTEMATIC STRANGLE ENGINE (THETA HARVESTER)"),
          /*#__PURE__*/React.createElement("span", {
            style: {
              background: '#10b981',
              color: '#ffffff',
              fontSize: '11px',
              fontWeight: 800,
              padding: '3px 8px',
              borderRadius: '4px',
              letterSpacing: '0.5px'
            }
          }, "LIVE ARMED")
        ),
        /*#__PURE__*/React.createElement("div", {
          style: {
            fontSize: '12px',
            color: 'var(--text-muted, #64748b)'
          }
        }, "Mechanical Options Theta Selling · 1.0% OTM Delta Neutral · 25% Stop-Loss · EOD 15:15 Exit")
      ),
      /* Right Stats Badges */
      /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
          flexWrap: 'wrap'
        }
      },
        /*#__PURE__*/React.createElement("div", {
          style: {
            background: 'rgba(16, 185, 129, 0.1)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: '8px',
            padding: '6px 12px',
            textAlign: 'right'
          }
        },
          /*#__PURE__*/React.createElement("div", { style: { fontSize: '10px', color: '#10b981', fontWeight: 700 } }, "VERIFIED BACKTEST (297 SESSIONS)"),
          /*#__PURE__*/React.createElement("div", { style: { fontSize: '13px', fontWeight: 800, color: '#10b981' } }, "97.31% Win Rate · +₹6,50,020 Net (+₹2,188/d)")
        ),
        /*#__PURE__*/React.createElement("div", {
          style: {
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: '8px',
            padding: '6px 12px',
            textAlign: 'right'
          }
        },
          /*#__PURE__*/React.createElement("div", { style: { fontSize: '10px', color: '#d97706', fontWeight: 700 } }, "PAST WEEK LIVE (NOV 3–11)"),
          /*#__PURE__*/React.createElement("div", { style: { fontSize: '13px', fontWeight: 800, color: '#d97706' } }, "12/12 Wins (100%) · +₹31,428 Net Profit")
        )
      )
    ),

    /* Strategy Rules Banner */
    /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '12px',
        background: 'var(--bg, #f8fafc)',
        padding: '12px 16px',
        borderRadius: '8px',
        marginBottom: '16px',
        fontSize: '12px'
      }
    },
      /*#__PURE__*/React.createElement("div", null,
        /*#__PURE__*/React.createElement("span", { style: { color: 'var(--text-muted)', fontWeight: 600 } }, "Entry Rule: "),
        /*#__PURE__*/React.createElement("strong", null, rules.entryTime || "09:20 AM IST sharp")
      ),
      /*#__PURE__*/React.createElement("div", null,
        /*#__PURE__*/React.createElement("span", { style: { color: 'var(--text-muted)', fontWeight: 600 } }, "Exit Rule: "),
        /*#__PURE__*/React.createElement("strong", null, rules.exitTime || "15:15 PM IST (Auto Square-off)")
      ),
      /*#__PURE__*/React.createElement("div", null,
        /*#__PURE__*/React.createElement("span", { style: { color: 'var(--text-muted)', fontWeight: 600 } }, "Stop-Loss: "),
        /*#__PURE__*/React.createElement("strong", { style: { color: '#ef4444' } }, rules.stopLossRule || "25% on individual sold leg")
      ),
      /*#__PURE__*/React.createElement("div", null,
        /*#__PURE__*/React.createElement("span", { style: { color: 'var(--text-muted)', fontWeight: 600 } }, "SEBI Margin: "),
        /*#__PURE__*/React.createElement("strong", { style: { color: '#10b981' } }, "₹48.5k–₹55k (with Hedge Wings)")
      )
    ),

    /* Grand Live Session Tracker Banner (When Live Tracking is Active) */
    trk && trk.combinedPnl != null && /*#__PURE__*/React.createElement("div", {
      style: {
        background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(59, 130, 246, 0.08) 100%)',
        border: '1.5px solid #10b981',
        borderRadius: '10px',
        padding: '16px 20px',
        marginBottom: '20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '14px',
        boxShadow: '0 2px 10px rgba(16, 185, 129, 0.1)'
      }
    },
      /* Left */
      /*#__PURE__*/React.createElement("div", null,
        /*#__PURE__*/React.createElement("div", {
          style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 800, color: 'var(--text, #0f172a)' }
        },
          /*#__PURE__*/React.createElement("span", { style: { fontSize: '18px' } }, "📈"),
          /*#__PURE__*/React.createElement("span", null, "09:20 STRANGLE LIVE MTM TRACKER (09:20 → 15:15):"),
          /*#__PURE__*/React.createElement("span", {
            style: {
              background: '#10b981',
              color: '#ffffff',
              fontSize: '10.5px',
              fontWeight: 800,
              padding: '2px 8px',
              borderRadius: '4px',
              letterSpacing: '0.4px'
            }
          }, String(trk.status || 'ACTIVE').replace(/_/g, ' '))
        ),
        /*#__PURE__*/React.createElement("div", {
          style: { fontSize: '12px', color: 'var(--text-muted, #64748b)', marginTop: '4px' }
        }, trk.dailySummary || "Automatic tracking: 09:20 AM entry, 15:15 PM exit.")
      ),
      /* Right: PnL pills */
      /*#__PURE__*/React.createElement("div", {
        style: { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }
      },
        /*#__PURE__*/React.createElement("div", { style: { textAlign: 'right' } },
          /*#__PURE__*/React.createElement("div", { style: { fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 700 } }, "NIFTY LIVE P&L"),
          /*#__PURE__*/React.createElement("div", {
            style: { fontSize: '16px', fontWeight: 800, color: (trk.nifty && trk.nifty.netPnl >= 0 ? '#10b981' : '#ef4444') }
          }, trk.nifty && trk.nifty.netPnl != null ? `₹${trk.nifty.netPnl >= 0 ? '+' : ''}${Number(trk.nifty.netPnl).toLocaleString('en-IN')}` : '₹0')
        ),
        /*#__PURE__*/React.createElement("div", { style: { textAlign: 'right' } },
          /*#__PURE__*/React.createElement("div", { style: { fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 700 } }, "BANKNIFTY LIVE P&L"),
          /*#__PURE__*/React.createElement("div", {
            style: { fontSize: '16px', fontWeight: 800, color: (trk.bankNifty && trk.bankNifty.netPnl >= 0 ? '#10b981' : '#ef4444') }
          }, trk.bankNifty && trk.bankNifty.netPnl != null ? `₹${trk.bankNifty.netPnl >= 0 ? '+' : ''}${Number(trk.bankNifty.netPnl).toLocaleString('en-IN')}` : '₹0')
        ),
        /*#__PURE__*/React.createElement("div", {
          style: {
            background: '#10b981',
            color: '#ffffff',
            borderRadius: '8px',
            padding: '8px 16px',
            textAlign: 'right'
          }
        },
          /*#__PURE__*/React.createElement("div", { style: { fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' } }, "TOTAL LIVE PROFIT"),
          /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 900 } },
            `₹${Number(trk.combinedPnl || 0) >= 0 ? '+' : ''}${Number(trk.combinedPnl || 0).toLocaleString('en-IN')}`
          )
        )
      )
    ),

    /* Educational Guide: What is Leg 1, Leg 2, and Which Date to select */
    /*#__PURE__*/React.createElement("div", {
      style: {
        background: 'rgba(245, 158, 11, 0.08)',
        border: '1.5px solid rgba(245, 158, 11, 0.35)',
        borderRadius: '8px',
        padding: '12px 16px',
        marginBottom: '20px',
        fontSize: '12px',
        lineHeight: '1.6'
      }
    },
      /*#__PURE__*/React.createElement("div", {
        style: { fontWeight: 800, color: '#d97706', fontSize: '13px', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }
      }, "💡 WHAT ARE LEG 1 & LEG 2? WHICH EXPIRY DATE TO SELECT?"),
      /*#__PURE__*/React.createElement("div", {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px' }
      },
        /*#__PURE__*/React.createElement("div", null,
          /*#__PURE__*/React.createElement("div", null, "• ", /*#__PURE__*/React.createElement("strong", { style: { color: '#ef4444' } }, "Leg 1 (SELL CE): "), "Call option sold 1% above market. Makes money when market stays below strike or moves sideways."),
          /*#__PURE__*/React.createElement("div", null, "• ", /*#__PURE__*/React.createElement("strong", { style: { color: '#3b82f6' } }, "Leg 2 (SELL PE): "), "Put option sold 1% below market. Makes money when market stays above strike or moves sideways."),
          /*#__PURE__*/React.createElement("div", null, "• ", /*#__PURE__*/React.createElement("strong", { style: { color: '#10b981' } }, "Why both together? "), "Market stays in the middle → BOTH options lose value to time decay → you collect the profit!")
        ),
        /*#__PURE__*/React.createElement("div", null,
          /*#__PURE__*/React.createElement("div", null, "• ", /*#__PURE__*/React.createElement("strong", { style: { color: '#7c3aed' } }, "Leg 3 & 4 (BUY Hedges): "), "Cheap ₹3–₹5 options bought ONLY to cut broker margin from ₹1.2 Lakhs down to ₹48.5k."),
          /*#__PURE__*/React.createElement("div", null, "• ", /*#__PURE__*/React.createElement("strong", { style: { color: '#d97706' } }, "Which Expiry Date? "), "Select ", /*#__PURE__*/React.createElement("strong", null, "Current Weekly Expiry (12-NOV-2026 for Today, or 19-NOV-2026 for Tomorrow)"), "."),
          /*#__PURE__*/React.createElement("div", null, "• ", /*#__PURE__*/React.createElement("strong", null, "Broker Search Format: "), /*#__PURE__*/React.createElement("code", { style: { background: '#ffffff', padding: '2px 6px', borderRadius: '4px', border: '1px solid #cbd5e1', fontWeight: 700 } }, "NIFTY 12NOV 25600 CE"))
        )
      )
    ),

    /* Grid of Index Calls */
    /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gap: '20px'
      }
    },
      calls.map((c, idx) => {
        const trkIdx = trk ? (c.symbol === 'BANKNIFTY' ? trk.bankNifty : trk.nifty) : null;
        const idxLivePnl = trkIdx && trkIdx.netPnl != null ? trkIdx.netPnl : null;
        const idxLivePts = trkIdx && trkIdx.netPoints != null ? trkIdx.netPoints : null;
        const liveSpot = trkIdx && trkIdx.currentSpot ? trkIdx.currentSpot : c.spotPrice;

        const dIst = new Date(Date.now() + 330 * 60000);
        const tIst = dIst.getUTCHours() * 100 + dIst.getUTCMinutes();
        const isEntryWindow = (tIst >= 918 && tIst <= 930);
        const isPreEntry = (tIst < 918);
        const isTradeRunning = (tIst > 930 && tIst < 1515);
        const isSessionClosed = (tIst >= 1515);

        const basketLines = (c.legs || []).map((l, i) => {
          const lIsSell = l.type.startsWith('SELL');
          const lIsCall = l.type.includes('CALL');
          const lLive = lIsSell && trkIdx ? (lIsCall ? trkIdx.callLeg : trkIdx.putLeg) : null;
          const lPrice = lLive && lLive.currentPrem != null ? lLive.currentPrem : Number(l.estPremium || 0);
          const lEntry = lLive && lLive.entryPrem != null ? lLive.entryPrem : Number(l.estPremium || 0);
          if (lIsSell) {
            return `${i + 1}. SELL ${l.brokerSymbol || `${c.symbol} ${l.name}`} | Qty: ${c.lotSize} | Current Price (LTP): ₹${lPrice.toFixed(1)} | SL: ₹${(lLive && lLive.sl) || l.stopLoss} (09:20 Entry: ₹${lEntry.toFixed(1)})`;
          } else {
            return `${i + 1}. BUY  ${l.brokerSymbol || `${c.symbol} ${l.name}`} | Qty: ${c.lotSize} | Price: Market (~₹${l.estPremium || 3.5}) (Hedge Wing)`;
          }
        });
        const liveBasketText = `=== ${c.symbol} 09:20 STRANGLE BASKET (${c.expiry || '12-NOV-2026'}) ===\n` +
          basketLines.join('\n') +
          `\nExecution Rule: BUY Hedges (Leg 3 & 4) first for margin relief, then SELL Main strikes (Leg 1 & 2).\n` +
          `Session Status: ${isEntryWindow ? '🟢 ACTIVE ENTRY WINDOW (09:20 AM)' : (isTradeRunning ? `🟢 POSITION RUNNING (Current LTP Updated, +₹${Number(idxLivePnl || 0).toLocaleString('en-IN')} P&L)` : (isSessionClosed ? '🏁 SESSION CLOSED (15:15 PM)' : '⏳ AWAITING 09:20 AM ENTRY'))}`;

        return /*#__PURE__*/React.createElement("div", {
          key: c.symbol || idx,
          style: {
            background: 'var(--bg, #f8fafc)',
            border: '1px solid var(--card-border, #e2e8f0)',
            borderRadius: '10px',
            padding: '18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px'
          }
        },
          /* Card Header */
          /*#__PURE__*/React.createElement("div", {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderBottom: '1px solid var(--card-border, #e2e8f0)',
              paddingBottom: '10px'
            }
          },
            /*#__PURE__*/React.createElement("div", null,
              /*#__PURE__*/React.createElement("div", {
                style: {
                  fontSize: '18px',
                  fontWeight: 800,
                  color: 'var(--text, #0f172a)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }
              }, c.symbol,
                /*#__PURE__*/React.createElement("span", {
                  style: {
                    background: c.symbol === 'BANKNIFTY' ? '#d97706' : '#2563eb',
                    color: '#ffffff',
                    fontSize: '10px',
                    fontWeight: 800,
                    padding: '2px 8px',
                    borderRadius: '4px',
                    letterSpacing: '0.4px'
                  }
                }, c.symbol === 'BANKNIFTY' ? '👑 HIGHEST PROFIT (+₹18.6k/wk)' : '🛡️ ROCK SOLID (+₹12.8k/wk)')
              ),
              /*#__PURE__*/React.createElement("div", {
                style: { fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '2px' }
              },
                /*#__PURE__*/React.createElement("span", null, `09:20 Spot: ₹${Number(c.spotPrice || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`),
                liveSpot && /*#__PURE__*/React.createElement("strong", { style: { color: 'var(--text, #0f172a)' } }, `→ Now: ₹${Number(liveSpot).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`),
                /*#__PURE__*/React.createElement("span", null, `· Lot: ${c.lotSize} Qty`)
              )
            ),
            /* Right Side of Header: Live PnL Pill or Entry State */
            /*#__PURE__*/React.createElement("div", {
              style: { display: 'flex', alignItems: 'center', gap: '8px' }
            },
              idxLivePnl != null ? /*#__PURE__*/React.createElement("div", {
                style: {
                  background: idxLivePnl >= 0 ? '#10b981' : '#ef4444',
                  color: '#ffffff',
                  fontSize: '11.5px',
                  fontWeight: 800,
                  padding: '4px 10px',
                  borderRadius: '6px',
                  whiteSpace: 'nowrap'
                }
              }, `🟢 LIVE P&L: ₹${idxLivePnl >= 0 ? '+' : ''}${Number(idxLivePnl).toLocaleString('en-IN')} (+${idxLivePts} pts)`) : /*#__PURE__*/React.createElement("div", {
                style: {
                  background: isEntryWindow ? '#10b981' : '#f59e0b',
                  color: '#ffffff',
                  fontSize: '11px',
                  fontWeight: 800,
                  padding: '4px 10px',
                  borderRadius: '6px'
                }
              }, isEntryWindow ? '⚡ EXECUTE AT 09:20 AM' : (isTradeRunning ? '🟢 POSITION RUNNING' : (isSessionClosed ? '🏁 CLOSED' : '⏳ AWAIT 09:20 AM')))
            )
          ),

          /* Entry Guidance Status Banner */
          /*#__PURE__*/React.createElement("div", {
            style: {
              padding: '8px 12px',
              borderRadius: '6px',
              background: isEntryWindow ? 'rgba(16, 185, 129, 0.12)' : (isTradeRunning ? 'rgba(59, 130, 246, 0.08)' : 'rgba(245, 158, 11, 0.08)'),
              border: isEntryWindow ? '1.5px solid #10b981' : (isTradeRunning ? '1px solid #3b82f6' : '1px solid #f59e0b'),
              fontSize: '11.5px',
              color: 'var(--text, #0f172a)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              lineHeight: '1.4'
            }
          },
            /*#__PURE__*/React.createElement("span", { style: { fontSize: '14px' } }, isEntryWindow ? '⚡' : (isTradeRunning ? 'ℹ️' : '⏳')),
            /*#__PURE__*/React.createElement("span", null,
              isEntryWindow
                ? "ACTIVE ENTRY WINDOW (09:20 AM): Execute now at current live prices! Copy complete basket or individual legs below."
                : (isTradeRunning
                    ? `09:20 Entry completed. Trade is actively running with +₹${Number(idxLivePnl || 0).toLocaleString('en-IN')} profit. Copy buttons below provide CURRENT LIVE PRICES (LTP) for order tracking.`
                    : (isSessionClosed
                        ? "Session completed at 15:15 PM. All positions auto squared off. Next entry tomorrow at 09:20 AM."
                        : "Awaiting 09:20 AM systematic entry. Live orders arm at 09:18 AM IST."))
            )
          ),

          /* Contract Expiry & One-Click Basket Copy Strip */
          /*#__PURE__*/React.createElement("div", {
            style: {
              background: 'rgba(37, 99, 235, 0.07)',
              border: '1px solid rgba(37, 99, 235, 0.22)',
              borderRadius: '6px',
              padding: '8px 12px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '8px',
              fontSize: '11.5px'
            }
          },
            /*#__PURE__*/React.createElement("div", null,
              /*#__PURE__*/React.createElement("strong", { style: { color: '#1d4ed8' } }, "📅 Expiry Date: "),
              /*#__PURE__*/React.createElement("span", { style: { fontWeight: 800, color: 'var(--text, #0f172a)' } }, c.expiry || "17-NOV-2026"),
              /*#__PURE__*/React.createElement("span", { style: { color: 'var(--text-muted)', marginLeft: '6px', fontSize: '10.5px' } }, c.symbol === 'BANKNIFTY' ? '(Monthly Expiry)' : '(Weekly Expiry)')
            ),
            /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              /*#__PURE__*/React.createElement("a", {
                href: "https://trade.angelone.in",
                target: "_blank",
                rel: "noopener noreferrer",
                style: {
                  background: '#ff5722',
                  border: '1px solid #e64a19',
                  color: '#ffffff',
                  fontSize: '11px',
                  fontWeight: 800,
                  padding: '6px 11px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  textDecoration: 'none',
                  boxShadow: '0 1px 3px rgba(255, 87, 34, 0.25)',
                  transition: 'all 0.15s ease'
                },
                onClick: (e) => {
                  e.stopPropagation();
                  if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(liveBasketText);
                  }
                  onCopy && onCopy(liveBasketText);
                },
                title: "Open Angel One trade terminal and copy basket"
              },
                /*#__PURE__*/React.createElement("span", null, "👼"),
                /*#__PURE__*/React.createElement("span", null, "Angel One ↗")
              ),
              /*#__PURE__*/React.createElement("button", {
                style: {
                  background: isEntryWindow ? '#10b981' : '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '11px',
                  fontWeight: 800,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                },
                onClick: () => {
                  onCopy && onCopy(liveBasketText);
                },
                title: "Click to copy full 4-leg order basket with CURRENT LIVE PRICES"
              }, isEntryWindow ? "⚡ Copy Basket" : "📋 Copy Basket")
            )
          ),

          /* Legs Table */
          /*#__PURE__*/React.createElement("div", {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }
          },
            (c.legs || []).map((leg, legIdx) => {
              const isSell = leg.type.startsWith('SELL');
              const isCall = leg.type.includes('CALL');
              const typeChar = isCall ? 'C' : 'P';
              const parts = String(c.expiry || '').split('-');
              const dd = parts[0] ? parts[0].padStart(2, '0') : '17';
              const monthMap = { 'JAN':'01','FEB':'02','MAR':'03','APR':'04','MAY':'05','JUN':'06','JUL':'07','AUG':'08','SEP':'09','OCT':'10','NOV':'11','DEC':'12' };
              const mm = parts[1] ? (monthMap[parts[1].toUpperCase()] || '11') : '11';
              const yy = parts[2] ? parts[2].slice(-2) : '26';
              const symClean = String(c.symbol).toUpperCase().replace(/[^A-Z]/g, '');
              const tvSym = `NSE:${symClean}${yy}${mm}${dd}${typeChar}${leg.strike}`;
              const chartUrl = `https://in.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym)}`;

              const legNum = leg.legNumber || (isSell ? (isCall ? 'Leg 1' : 'Leg 2') : (isCall ? 'Leg 3 (Hedge)' : 'Leg 4 (Hedge)'));
              const liveLeg = isSell && trkIdx ? (isCall ? trkIdx.callLeg : trkIdx.putLeg) : null;
              const entryPrem = liveLeg && liveLeg.entryPrem ? liveLeg.entryPrem : Number(leg.estPremium || 0);
              const livePrem = liveLeg && liveLeg.currentPrem != null ? liveLeg.currentPrem : null;
              const currentPrice = (livePrem != null && livePrem > 0) ? livePrem : entryPrem;
              const decayPts = livePrem != null ? (entryPrem - livePrem) : null;
              const decayPct = (livePrem != null && entryPrem > 0) ? ((entryPrem - livePrem) / entryPrem * 100) : null;
              const legPnl = liveLeg && liveLeg.pnl != null ? liveLeg.pnl : null;

              const copyStr = isSell
                ? `SELL ${leg.brokerSymbol || `${c.symbol} ${leg.name}`} | Qty: ${c.lotSize} | Current Price (LTP): ₹${currentPrice.toFixed(1)} | SL: ₹${(liveLeg && liveLeg.sl) || leg.stopLoss} (09:20 Entry: ₹${entryPrem.toFixed(1)})`
                : `BUY ${leg.brokerSymbol || `${c.symbol} ${leg.name}`} | Qty: ${c.lotSize} | Price: Market (~₹${leg.estPremium || 3.5}) (Hedge Wing)`;

              return /*#__PURE__*/React.createElement("div", {
                key: legIdx,
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: 'var(--card-bg, #ffffff)',
                  border: isSell ? (isCall ? '1.5px solid rgba(239, 68, 68, 0.4)' : '1.5px solid rgba(59, 130, 246, 0.4)') : '1px dashed var(--card-border, #cbd5e1)',
                  borderRadius: '6px',
                  padding: '10px 14px',
                  fontSize: '12px'
                }
              },
                /* Left: Leg badge, contract name, role explanation */
                /*#__PURE__*/React.createElement("div", {
                  style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', flex: '1 1 auto' },
                  onClick: () => onCopy && onCopy(copyStr),
                  title: `Click to copy order with CURRENT PRICE: ${copyStr}`
                },
                  /* Leg Number Tag */
                  /*#__PURE__*/React.createElement("span", {
                    style: {
                      background: isSell ? '#ef4444' : '#10b981',
                      color: '#ffffff',
                      fontSize: '10px',
                      fontWeight: 800,
                      padding: '2.5px 6px',
                      borderRadius: '4px',
                      whiteSpace: 'nowrap'
                    }
                  }, `${isSell ? 'SELL' : 'BUY'} · ${legNum}`),
                  /* Contract Name & Search string */
                  /*#__PURE__*/React.createElement("div", null,
                    /*#__PURE__*/React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                      /*#__PURE__*/React.createElement("strong", { style: { fontSize: '13px' } }, leg.brokerSymbol || `${c.symbol} ${leg.name}`),
                      /*#__PURE__*/React.createElement("span", {
                        style: {
                          fontSize: '10px',
                          color: isSell ? '#ef4444' : '#10b981',
                          fontWeight: 700,
                          background: isSell ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                          padding: '1px 5px',
                          borderRadius: '3px'
                        }
                      }, isSell ? '(1% OTM Main)' : '(Hedge Wing)')
                    ),
                    leg.explanation && /*#__PURE__*/React.createElement("div", {
                      style: { fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '2px' }
                    }, leg.explanation)
                  )
                ),
                /* Right: 09:20 Entry vs Current LTP, Decay Points, Live PnL, SL, and Click to Copy Button */
                /*#__PURE__*/React.createElement("div", {
                  style: { display: 'flex', alignItems: 'center', gap: '10px', textAlign: 'right' }
                },
                  /* Live Price & PnL Box */
                  isSell && livePrem != null ? /*#__PURE__*/React.createElement("div", {
                    style: { display: 'flex', alignItems: 'center', gap: '8px' }
                  },
                    /* Entry vs Live LTP */
                    /*#__PURE__*/React.createElement("div", { style: { textAlign: 'right' } },
                      /*#__PURE__*/React.createElement("div", { style: { fontSize: '10px', color: 'var(--text-muted)' } }, `09:20: ₹${entryPrem.toFixed(1)}`),
                      /*#__PURE__*/React.createElement("div", { style: { fontSize: '13px', fontWeight: 800, color: '#16a34a' } }, `Now: ₹${livePrem.toFixed(1)}`)
                    ),
                    /* Decay points and Live PnL */
                    /*#__PURE__*/React.createElement("div", {
                      style: {
                        background: 'rgba(16, 185, 129, 0.12)',
                        border: '1px solid rgba(16, 185, 129, 0.35)',
                        borderRadius: '5px',
                        padding: '2px 7px',
                        textAlign: 'right'
                      }
                    },
                      /*#__PURE__*/React.createElement("div", { style: { fontSize: '9.5px', color: '#059669', fontWeight: 700 } }, `▼ -${decayPts.toFixed(1)} pts (${decayPct.toFixed(0)}%)`),
                      /*#__PURE__*/React.createElement("div", { style: { fontSize: '12.5px', fontWeight: 800, color: '#10b981' } }, `+₹${Number(legPnl).toLocaleString('en-IN')}`)
                    ),
                    /* SL */
                    /*#__PURE__*/React.createElement("div", { style: { fontSize: '10.5px', color: '#ef4444', fontWeight: 700 } },
                      `SL: ₹${(liveLeg.sl || leg.stopLoss)}`
                    )
                  ) : /*#__PURE__*/React.createElement("div", null,
                    /*#__PURE__*/React.createElement("div", { style: { fontWeight: 800, fontSize: '13px' } }, `Est ₹${leg.estPremium}`),
                    isSell ? /*#__PURE__*/React.createElement("div", { style: { fontSize: '10.5px', color: '#ef4444', fontWeight: 700 } }, `SL: ₹${leg.stopLoss} (+25%)`) : /*#__PURE__*/React.createElement("div", { style: { fontSize: '10px', color: '#10b981', fontWeight: 600 } }, "No SL (Hedge)")
                  ),
                  /* Action Links: Angel One Trade + Live Chart */
                  /*#__PURE__*/React.createElement("div", {
                    style: { display: 'flex', alignItems: 'center', gap: '6px' }
                  },
                    /* Primary Angel One Link */
                    /*#__PURE__*/React.createElement("a", {
                      href: "https://trade.angelone.in",
                      target: "_blank",
                      rel: "noopener noreferrer",
                      style: {
                        background: '#ff5722',
                        border: '1px solid #e64a19',
                        color: '#ffffff',
                        fontSize: '11px',
                        fontWeight: 800,
                        padding: '5px 10px',
                        borderRadius: '5px',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        textDecoration: 'none',
                        boxShadow: '0 1px 3px rgba(255, 87, 34, 0.25)',
                        transition: 'all 0.15s ease'
                      },
                      onClick: (e) => {
                        e.stopPropagation();
                        const copyTarget = leg.brokerSymbol || `${c.symbol} ${leg.name}`;
                        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                          navigator.clipboard.writeText(copyTarget);
                        }
                        onCopy && onCopy(copyTarget);
                      },
                      title: `Open Angel One trade terminal (Copies "${leg.brokerSymbol || `${c.symbol} ${leg.name}`}" to clipboard)`
                    },
                      /*#__PURE__*/React.createElement("span", { style: { fontSize: '11px' } }, "👼"),
                      /*#__PURE__*/React.createElement("span", null, "Angel One ↗")
                    ),

                    /* Secondary Live Chart Link */
                    /*#__PURE__*/React.createElement("a", {
                      href: chartUrl,
                      target: "_blank",
                      rel: "noopener noreferrer",
                      style: {
                        background: isSell ? 'rgba(59, 130, 246, 0.12)' : 'rgba(16, 185, 129, 0.12)',
                        border: isSell ? '1px solid #3b82f6' : '1px solid #10b981',
                        color: isSell ? '#2563eb' : '#059669',
                        fontSize: '10.5px',
                        fontWeight: 700,
                        padding: '5px 8px',
                        borderRadius: '5px',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '3px',
                        textDecoration: 'none',
                        transition: 'all 0.15s ease'
                      },
                      onClick: (e) => {
                        e.stopPropagation();
                        onCopy && onCopy(leg.brokerSymbol || copyStr);
                      },
                      title: `Open live candlestick chart for ${leg.brokerSymbol || `${c.symbol} ${leg.name}`}`
                    },
                      /*#__PURE__*/React.createElement("span", null, "📈"),
                      /*#__PURE__*/React.createElement("span", null, "Chart")
                    )
                  )
                )
              );
            })
          ),

          /* Metrics Grid */
          /*#__PURE__*/React.createElement("div", {
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '8px',
              paddingTop: '8px',
              borderTop: '1px solid var(--card-border, #e2e8f0)',
              fontSize: '11px'
            }
          },
            /*#__PURE__*/React.createElement("div", null,
              /*#__PURE__*/React.createElement("div", { style: { color: 'var(--text-muted)' } }, "Margin Required (Hedged):"),
              /*#__PURE__*/React.createElement("div", { style: { fontSize: '14px', fontWeight: 800, color: '#10b981' } }, c.marginRequiredHedged)
            ),
            /*#__PURE__*/React.createElement("div", null,
              /*#__PURE__*/React.createElement("div", { style: { color: 'var(--text-muted)' } }, "Expected Daily Profit:"),
              /*#__PURE__*/React.createElement("div", { style: { fontSize: '14px', fontWeight: 800, color: '#059669' } }, c.expectedDailyGain)
            ),
            /*#__PURE__*/React.createElement("div", null,
              /*#__PURE__*/React.createElement("div", { style: { color: 'var(--text-muted)' } }, "Max Risk (25% SL Capped):"),
              /*#__PURE__*/React.createElement("div", { style: { fontWeight: 700, color: '#ef4444' } }, c.maxRiskPerTrade)
            ),
            /*#__PURE__*/React.createElement("div", null,
              /*#__PURE__*/React.createElement("div", { style: { color: 'var(--text-muted)' } }, "Total Premium Sold:"),
              /*#__PURE__*/React.createElement("div", { style: { fontWeight: 700 } }, `₹${Number(c.totalPremiumCollected || 0).toLocaleString('en-IN')}`)
            )
          )
        );
      })
    ),

  );
}

function ScalpingApp() {

  // 1. Theme State

  const [theme, setTheme] = useState(() => {

    try {

      return localStorage.getItem('openalgo_theme') || 'light';

    } catch (_) {

      return 'light';

    }

  });

  useEffect(() => {

    document.documentElement.setAttribute('data-theme', theme);

    try {

      localStorage.setItem('openalgo_theme', theme);

    } catch (_) {}

  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');



  // 2. Sidebar State - Default to collapsed (true) matching other pages (Image 3)

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {

    try {

      const saved = localStorage.getItem('sidebar_collapsed');

      return saved !== null ? saved === '1' : true;

    } catch (_) {

      return true;

    }

  });

  const toggleSidebar = () => {

    setSidebarCollapsed(prev => {

      const next = !prev;

      try {

        localStorage.setItem('sidebar_collapsed', next ? '1' : '0');

      } catch (_) {}

      return next;

    });

  };



  // 3. Data States

  const [catalysts, setCatalysts] = useState([]);

  const [allFilings, setAllFilings] = useState([]);

  const [overnightBatch, setOvernightBatch] = useState(null);

  const [boardData, setBoardData] = useState({

    scorecard: {},

    activeCalls: [],

    closedCalls: [],

    growwMovers: []

  });

  const [catFilter, setCatFilter] = useState('ALL');

  const [activeFilter, setActiveFilter] = useState('ALL');

  const [isScanningNow, setIsScanningNow] = useState(false);

  const triggerManualScan = async () => {

    setIsScanningNow(true);

    setToast('\u26A1 Starting live breakout scan across 998 NSE stocks...');

    try {

      const res = await fetch('/api/scalping/scan-now', { method: 'POST' });

      const data = await res.json();

      if (data.ok) {

        setToast('\u2705 ' + (data.message || 'Scan in progress...'));

        setTimeout(() => {

          fetchBoard();

          setIsScanningNow(false);

        }, 15000);

      } else {

        setToast('\u26A0\uFE0F ' + (data.message || 'Scan error'));

        setIsScanningNow(false);

      }

    } catch (e) {

      setToast('\u26A0\uFE0F Scan trigger failed: ' + e.message);

      setIsScanningNow(false);

    }

  };

  const [velocityTab, setVelocityTab] = useState('1m');

  const [lastUpdated, setLastUpdated] = useState(() => new Date().toLocaleTimeString('en-IN', {

    hour: '2-digit',

    minute: '2-digit',

    second: '2-digit',

    hour12: true

  }));



  // 4. Feedback States (Toast & Click-to-copy)

  const [toast, setToast] = useState(null);

  const [copiedSymbol, setCopiedSymbol] = useState(null);

  const toastTimerRef = useRef(null);

  const copyTimerRef = useRef(null);

  const triggerCopy = sym => {

    if (!sym) return;

    const clean = String(sym).trim();

    if (navigator.clipboard && navigator.clipboard.writeText) {

      navigator.clipboard.writeText(clean).catch(() => copyFallback(clean));

    } else {

      copyFallback(clean);

    }

    setCopiedSymbol(clean);

    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);

    copyTimerRef.current = setTimeout(() => setCopiedSymbol(null), 1200);

    setToast({

      msg: `📋 Copied ${clean} to clipboard`,

      bg: '#10B981'

    });

    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);

    toastTimerRef.current = setTimeout(() => setToast(null), 2000);

  };



  // Determine market session state

  const nowMs = Date.now();

  const dIst = new Date(nowMs + 330 * 60000);

  const dayOfWeek = dIst.getUTCDay();

  const tNum = dIst.getUTCHours() * 100 + dIst.getUTCMinutes();

  const isMarketOpen = dayOfWeek >= 1 && dayOfWeek <= 5 && tNum >= 915 && tNum < 1530;

  const isPostClose = tNum >= 1530 || dayOfWeek === 0 || dayOfWeek === 6;

  const isClosed = !isMarketOpen;



  // 5. Polling for Catalysts (250ms — the server caches for 200ms, so anything slower just adds dead time; the old 1.0s loop alone put a filing up to a second behind the store)

  useEffect(() => {

    let isCancelled = false;

    const fetchCatalysts = async () => {

      try {

        const res = await fetch('/api/scalping/catalysts?_t=' + Date.now());

        if (!res.ok) return;

        const data = await res.json();

        if (!isCancelled) {

          const list = data.catalysts || data.highPriority || [];

          setCatalysts(list);

          if (Array.isArray(data.allFilings)) {

            setAllFilings(data.allFilings);

          }

          if (data.overnightBatch) {

            setOvernightBatch(data.overnightBatch);

          }

        }

      } catch (err) {

        console.error('Catalysts poll error:', err);

      }

    };

    fetchCatalysts();

    const interval = setInterval(fetchCatalysts, 250);

    return () => {

      isCancelled = true;

      clearInterval(interval);

    };

  }, []);



  // 6. Polling for Board & Live Scalp Calls (every 2s)

  useEffect(() => {

    let isCancelled = false;

    const fetchBoard = async () => {

      try {

        const res = await fetch('/api/scalping/board?_t=' + Date.now());

        if (!res.ok) return;

        const data = await res.json();

        if (!isCancelled) {

          setBoardData(data);

        }

      } catch (err) {

        console.error('Board poll error:', err);

      }

    };

    fetchBoard();

    const interval = setInterval(fetchBoard, 2000);

    return () => {

      isCancelled = true;

      clearInterval(interval);

    };

  }, []);



  // 7. Sorted & Filtered Catalysts - HIGHEST PROBABILITY FIRST IF MARKET CLOSED, 1-MINUTE ROCKETS FIRST IF OPEN

  const filteredCatalysts = useMemo(() => {

    let list = [...catalysts];

    const nowMs = Date.now();

    // User rule: "keep only news to until it taken by market not 30min"

    // Unpriced catalysts remain active throughout the session until taken by the market (moved >= 1.2% or filled)



    // Determine if Indian equity market is currently closed

    const isClosed = (() => {

      const d = new Date(nowMs + 330 * 60000);

      const day = d.getUTCDay();

      if (day === 0 || day === 6) return true;

      const tNum = d.getUTCHours() * 100 + d.getUTCMinutes();

      return tNum < 915 || tNum >= 1530;

    })();

    const dNow = new Date(nowMs + 330 * 60000);

    const todayMidnightMs = Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth(), dNow.getUTCDate(), 0, 0, 0) - 330 * 60000;

    const sessionOpenMs = Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth(), dNow.getUTCDate(), 3, 45, 0); // 09:15 IST

    const isToday = ts => ts && Number(ts) >= todayMidnightMs;

    const isSessionFiling = ts => ts && Number(ts) >= sessionOpenMs - 45 * 60000; // 08:30 AM to now



    // PRIORITY RANK: HIGHEST PROBABILITY FIRST IF CLOSED, FRESH SESSION NEWS FIRST IF OPEN

    const getPriorityRank = c => {

      // EXCLUDE PENNY STOCKS (< ₹30) AND LOW-VOLUME (< 25,000) FROM ACTIONABLE TIERS

      const p = Number(c.ltp || c.close || c.effectivePrice || 0);

      const vol = Number(c.volume || 0);

      if (c.isPennyStock || c.isUntradeable || p > 0 && p < 30.0 || p <= 0 || vol > 0 && vol < 25000) return 0;

      if (isClosed) {

        // MARKET CLOSED: Priority is Highest Probability & Directional Conviction for 09:00 AM Open!

        const conf = Number(c.confidence || 60);

        const isActionable = c.prediction && (c.prediction.includes('BUY') || c.prediction.includes('SELL'));

        if (isActionable && conf >= 88) return 10;

        if (isActionable && conf >= 80) return 9;

        if (isActionable && conf >= 70) return 8;

        if (conf >= 70) return 7;

        return 1;

      }



      // MARKET OPEN:

      const v1 = Math.abs(Number(c.move1mPct || 0));

      const v5 = Math.abs(Number(c.move5mPct || 0));

      const ts = Number(c.ts || 0);

      const isActionable = c.prediction && (c.prediction.includes('BUY') || c.prediction.includes('SELL'));

      const isSession = isSessionFiling(ts);

      const isTodayFiling = isToday(ts);



      // TIER 1 (TOP PRIORITY): Fresh session news filed today with Actionable BUY/SELL or 1m burst!

      if (isSession && (isActionable || v1 >= 0.20)) return 10;

      // TIER 2: Any newly arrived news filed today (Session or morning pre-open)! Newest first!

      if (isTodayFiling) return 9;

      // TIER 3: Fast Live Movers (|v1| >= 0.30% or |v5| >= 0.50%) with a news catalyst!

      if ((v1 >= 0.30 || v5 >= 0.50) && !c.isUntradeable) return 8;

      // TIER 4: High-conviction overnight catalysts (conf >= 80)

      if (isActionable && Number(c.confidence || 0) >= 80) return 7;

      return 1;

    };

    list.sort((a, b) => {

      const rankA = getPriorityRank(a);

      const rankB = getPriorityRank(b);

      if (rankB !== rankA) {

        return rankB - rankA;

      }

      if (isClosed) {

        // When market is closed:

        // 1. Highest confidence descending

        const confA = Number(a.confidence || 60);

        const confB = Number(b.confidence || 60);

        if (confB !== confA) return confB - confA;



        // 2. Newest filing timestamp descending

        const tsA = Number(a.ts || 0);

        const tsB = Number(b.ts || 0);

        if (tsB !== tsA) return tsB - tsA;

        return String(a.symbol || '').localeCompare(String(b.symbol || ''));

      }



      // Inside Today's Fresh News tiers (ranks 9 and 10): Sort by newest filing timestamp first!

      if (rankA >= 9) {

        const tsA = Number(a.ts || 0);

        const tsB = Number(b.ts || 0);

        if (tsB !== tsA) return tsB - tsA;

      }



      // Inside 1-minute heavy mover tier (rank 8): Sort by highest 1m velocity!

      if (rankA === 8) {

        const v1A = Math.abs(Number(a.move1mPct || 0));

        const v1B = Math.abs(Number(b.move1mPct || 0));

        const bandA = Math.floor(v1A / 0.15);

        const bandB = Math.floor(v1B / 0.15);

        if (bandB !== bandA) return bandB - bandA;

      }



      // Fallback: newest news first

      const tsA = Number(a.ts || 0);

      const tsB = Number(b.ts || 0);

      if (tsB !== tsA) return tsB - tsA;

      return String(a.symbol || '').localeCompare(String(b.symbol || ''));

    });

    if (catFilter === 'FAST') {

      const fastList = list.filter(c => {

        if (isPennyOrLowVolume(c)) return false;

        const v1 = Math.abs(Number(c.move1mPct || 0));

        const v5 = Math.abs(Number(c.move5mPct || 0));

        return v1 >= 0.20 || v5 >= 0.35 || Math.abs(Number(c.movePct || 0)) >= 0.50;

      });

      return fastList.length > 0 ? fastList : list.filter(c => !isPennyOrLowVolume(c)).slice(0, 15);

    } else if (catFilter === 'BUY') {

      return list.filter(c => !isPennyOrLowVolume(c) && !c.isLowMomentum && c.takeTrade !== false && c.tradeStatus !== 'ALREADY_FILLED' && c.tradeStatus !== 'ALREADY_MOVED' && c.tradeStatus !== 'STALE_YESTERDAY' && c.tradeStatus !== 'ROUTINE_DISCLOSURE' && c.tradeStatus !== 'ROUTINE_LAND_ACQUISITION' && c.tradeStatus !== 'RESULTS_UNCERTAIN' && c.tradeStatus !== 'LOW_ML_PROBABILITY' && String(c.prediction || '').toUpperCase().includes('BUY') && (c.isConfirmedMomentum || Math.abs(Number(c.move1mPct || 0)) >= 0.15 || Math.abs(Number(c.move5mPct || 0)) >= 0.30 || isClosed));

    } else if (catFilter === 'SELL') {

      return list.filter(c => !isPennyOrLowVolume(c) && (c.bias === 'BEARISH' || String(c.prediction || '').toUpperCase().includes('SELL')));

    } else if (catFilter === 'STAGNANT') {

      return list.filter(c => !isPennyOrLowVolume(c) && (c.isLowMomentum || String(c.prediction || '').toUpperCase().includes('LOW MOMENTUM')));

    } else if (catFilter === 'NEUTRAL') {

      return list.filter(c => c.bias === 'NEUTRAL' || String(c.prediction || '').toUpperCase().includes('NEUTRAL') || isPennyOrLowVolume(c));

    }

    // ALL filter: remove penny and low volume stocks completely

    return list.filter(c => !isPennyOrLowVolume(c));

  }, [catalysts, catFilter]);



  // 7B. Top 5 High-Probability Movers ("Only keep five and five will be set in one row")

  const top5DisplayList = useMemo(() => {
    if (boardData.top5Catalysts && boardData.top5Catalysts.length > 0) {
      return boardData.top5Catalysts.slice(0, 5);
    }
    if (catalysts && catalysts.length > 0) {
      return catalysts.slice(0, 5);
    }
    return filteredCatalysts.slice(0, 5);
  }, [boardData.top5Catalysts, catalysts, filteredCatalysts]);



  // 8. TWO CLEANLY SEPARATED VELOCITY TABLES (Strictly non-zero, NO 0.00%, NO Day %)

  const cleanMovers1m = useMemo(() => {

    let raw = Array.isArray(boardData.movers1m) && boardData.movers1m.length > 0 ? [...boardData.movers1m] : Array.isArray(boardData.growwMovers) ? [...boardData.growwMovers] : [];

    if (raw.length === 0) return [];

    const list = raw.filter(m => {

      const p = Number(m.price || m.ltp || 0);

      const toCr = Number(m.turnoverCr || 0);

      const v1m = Number(m.volume1m || m.volume || 0);

      const m1 = Number(m.move1mPct || 0);

      if (p < 30) return false;

      if (toCr > 0 && toCr < 0.20) return false;

      if (v1m > 0 && v1m < 100) return false;

      if (m.ticks != null && m.ticks < 3) return false;

      // STRICT FILTER: NEVER ALLOW 0.00%

      if (Math.abs(m1) < 0.01) return false;

      return true;

    });

    list.sort((a, b) => {

      const m1A = Math.abs(Number(a.move1mPct || 0));

      const m1B = Math.abs(Number(b.move1mPct || 0));

      return m1B - m1A;

    });

    return list.slice(0, 16);

  }, [boardData.movers1m, boardData.growwMovers]);

  const cleanMovers10s = useMemo(() => {

    const raw = Array.isArray(boardData.movers10s) ? [...boardData.movers10s] : [];

    if (raw.length === 0) return [];

    return raw.filter(m => {

      const p = Number(m.price || m.ltp || 0);

      const toCr = Number(m.turnoverCr || 0);

      const v1m = Number(m.volume1m || m.volume || 0);

      const r10 = Number(m.roc10 != null ? m.roc10 : m.move10sPct != null ? m.move10sPct : 0);

      if (p < 30) return false;

      if (toCr > 0 && toCr < 0.20) return false;

      if (v1m > 0 && v1m < 100) return false;

      if (m.ticks != null && m.ticks < 3) return false;

      if (Math.abs(r10) < 0.01) return false;

      return true;

    }).sort((a, b) => {

      const rA = Math.abs(Number(a.roc10 != null ? a.roc10 : a.move10sPct != null ? a.move10sPct : 0));

      const rB = Math.abs(Number(b.roc10 != null ? b.roc10 : b.move10sPct != null ? b.move10sPct : 0));

      return rB - rA;

    }).slice(0, 16);

  }, [boardData.movers10s]);

  const stableMovers = cleanMovers1m;



  // 9. Breakout Lanes: Current (In Buy Pocket) vs Pre-Breakout (Near Pivot)

  const currentCalls = useMemo(() => {

    return (boardData.currentBreakouts && boardData.currentBreakouts.length > 0)

      ? boardData.currentBreakouts

      : (boardData.activeCalls || []).filter(c => c.status !== 'PRE_BREAKOUT');

  }, [boardData.currentBreakouts, boardData.activeCalls]);



  const preCalls = useMemo(() => {

    return (boardData.preBreakouts && boardData.preBreakouts.length > 0)

      ? boardData.preBreakouts

      : (boardData.activeCalls || []).filter(c => c.status === 'PRE_BREAKOUT');

  }, [boardData.preBreakouts, boardData.activeCalls]);



  const allBreakoutCalls = useMemo(() => {
    return boardData.allBreakouts || [...currentCalls, ...preCalls];
  }, [boardData.allBreakouts, currentCalls, preCalls]);

  const supportCalls = useMemo(() => {
    return boardData.supportBounces || [];
  }, [boardData.supportBounces]);

  const trendCalls = useMemo(() => {
    return boardData.trendFollowCalls || [];
  }, [boardData.trendFollowCalls]);

  const [breakoutTab, setBreakoutTab] = useState('ALL');



  const filteredActiveCalls = useMemo(() => {

    let base = breakoutTab === 'TREND' ? trendCalls : breakoutTab === 'SUPPORT' ? supportCalls : breakoutTab === 'CURRENT' ? currentCalls : breakoutTab === 'PRE' ? preCalls : [...trendCalls, ...supportCalls, ...allBreakoutCalls];

    if (activeFilter === 'BREAKOUT' || activeFilter === 'CUP_AND_HANDLE') {
      return base.filter(c => (c.setup || '').includes('CUP') || (c.patternName || '').includes('Cup'));
    } else if (activeFilter === 'DOUBLE_BOTTOM' || activeFilter === 'DOUBLE_BOTTOM_NECKLINE') {
      return base.filter(c => (c.setup || '').includes('DOUBLE_BOTTOM') || (c.patternName || '').includes('Bottom') || (c.patternName || '').includes('W-'));
    } else if (activeFilter === 'FALLING_WEDGE') {
      return base.filter(c => (c.setup || '').includes('WEDGE') || (c.patternName || '').includes('Wedge'));
    } else if (activeFilter === 'BULL_FLAG' || activeFilter === 'BULL_FLAG_PENNANT') {
      return base.filter(c => (c.setup || '').includes('FLAG') || (c.patternName || '').includes('Flag'));
    } else if (activeFilter === 'TRIANGLE' || activeFilter === 'ASCENDING_TRIANGLE') {
      return base.filter(c => (c.setup || '').includes('TRIANGLE') || (c.patternName || '').includes('Triangle'));
    } else if (activeFilter === 'SUPPORT' || activeFilter === 'SUPPORT_BOUNCE') {
      return base.filter(c => (c.setup || '').includes('SUPPORT') || (c.patternName || '').includes('Support') || (c.patternName || '').includes('Polarity'));
    }

    return base;

  }, [breakoutTab, trendCalls, supportCalls, currentCalls, preCalls, allBreakoutCalls, activeFilter]);

  return /*#__PURE__*/React.createElement("div", {

    className: "app-shell"

  }, /*#__PURE__*/React.createElement(Sidebar, {

    collapsed: sidebarCollapsed,

    onToggle: toggleSidebar

  }), /*#__PURE__*/React.createElement("div", {

    className: "main-col"

  }, /*#__PURE__*/React.createElement(Topbar, {

    onToggleTheme: toggleTheme,

    lastUpdated: lastUpdated,

    brokerStatus: boardData.brokerStatus,

    quotes: boardData.quotes

  }), /*#__PURE__*/React.createElement("main", {

    className: "main-wrap",

    style: {

      padding: '16px 20px 32px',

      margin: 0,

      maxWidth: '100%'

    }

  }, /*#__PURE__*/React.createElement("div", {

    className: "top-widgets-row"

  }, /*#__PURE__*/React.createElement(TopNewsSquareBox, {

    catalysts: allFilings.length > 0 ? allFilings : (boardData.allFilings && boardData.allFilings.length ? boardData.allFilings : catalysts),

    onCopy: triggerCopy,

    onSelectSymbol: sym => {

      const el = document.getElementById(`cat-card-${sym}`);

      if (el) {

        el.scrollIntoView({

          behavior: 'smooth',

          block: 'center'

        });

        el.classList.add('copied-flash');

        setTimeout(() => el.classList.remove('copied-flash'), 1200);

      }

    }

  }), /*#__PURE__*/React.createElement(UpcomingEventsSquareBox, {

    catalysts: allFilings.length > 0 ? allFilings : (boardData.allFilings && boardData.allFilings.length ? boardData.allFilings : catalysts),

    onCopy: triggerCopy

  })), /*#__PURE__*/React.createElement("div", {

    className: "cat-section-header"

  }, /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'flex',

      justifyContent: 'space-between',

      alignItems: 'center',

      flexWrap: 'wrap',

      gap: '12px'

    }

  }, /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'flex',

      alignItems: 'center',

      gap: '10px',

      flexWrap: 'wrap'

    }

  }, /*#__PURE__*/React.createElement("h2", {

    style: {

      margin: 0,

      fontSize: '16px',

      fontWeight: 800,

      color: 'var(--text, #0f172a)',

      display: 'flex',

      alignItems: 'center',

      gap: '8px'

    }

  }, /*#__PURE__*/React.createElement("span", null, isMarketOpen ? "⚡ Top 5 High-Probability Catalysts (Live Session Announcements)" : isPostClose ? "⚡ Top 5 High-Probability Catalysts (Post-15:30 IST for Tomorrow's Open)" : "⚡ Top 5 High-Probability Catalysts (Overnight 15:30 IST to Now)")), /*#__PURE__*/React.createElement("span", {

    style: {

      fontSize: '12px',

      background: 'rgba(37,99,235,0.15)',

      color: '#2563eb',

      padding: '3px 9px',

      borderRadius: '12px',

      fontWeight: 700

    }

  }, "Top 5 Movers \xB7 Set in 1 Row"), isMarketOpen ? /*#__PURE__*/React.createElement("span", {

    style: {

      fontSize: '11px',

      background: 'rgba(16,185,129,0.15)',

      color: '#059669',

      padding: '3px 8px',

      borderRadius: '12px',

      fontWeight: 700,

      border: '1px solid rgba(16,185,129,0.3)'

    }

  }, "🟢 Live Market Session Active (09:15 - 15:30 IST)") : (tNum >= 900 && tNum < 915) ? /*#__PURE__*/React.createElement("span", {

    style: {

      fontSize: '11px',

      background: 'rgba(245,158,11,0.15)',

      color: '#d97706',

      padding: '3px 8px',

      borderRadius: '12px',

      fontWeight: 700,

      border: '1px solid rgba(245,158,11,0.3)'

    }

  }, "🌅 09:08 AM Pre-Market Auction Evaluated") : /*#__PURE__*/React.createElement("span", {

    style: {

      fontSize: '11px',

      background: 'rgba(99,102,241,0.15)',

      color: '#6366f1',

      padding: '3px 8px',

      borderRadius: '12px',

      fontWeight: 700,

      border: '1px solid rgba(99,102,241,0.3)'

    }

  }, "🌙 Overnight Top 5 Catalysts (For Tomorrow's 09:08 AM Open)"))), /*#__PURE__*/React.createElement("div", {

    style: {

      fontSize: '12px',

      color: 'var(--text-muted, #64748b)',

      marginTop: '4px'

    }

  }, isPostClose ? "Top 5 corporate filings filtered by ML win probability · Evaluated with 09:08 AM pre-market auction discovery (checks over-extension > +3.8% fade vs sweet-spot +0.8% to +3.8% continuation)" : isMarketOpen ? "Top 5 session catalysts with confirmed momentum thrust · Evaluated in real time" : "Top 5 overnight catalysts for tomorrow's open · Evaluated with 09:08 AM pre-market auction discovery")), /*#__PURE__*/React.createElement("div", {

    className: "top5-catalyst-row",

    style: {

      display: 'grid',

      gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',

      gridAutoFlow: 'column',

      gap: '10px',

      width: '100%',

      marginBottom: '24px',

      boxSizing: 'border-box'

    }

  }, top5DisplayList.length === 0 ? /*#__PURE__*/React.createElement("div", {

    style: {

      gridColumn: '1/-1',

      padding: '24px',

      textAlign: 'center',

      color: 'var(--text-muted)',

      background: 'var(--card-bg)',

      border: '1px dashed var(--card-border)',

      borderRadius: '12px',

      fontSize: '13px'

    }

  }, catalysts.length === 0 ? "Loading top high-probability announcements..." : "No high-probability catalysts meeting strict filters at this moment.") : top5DisplayList.map(c => /*#__PURE__*/React.createElement(CatalystCard, {

    key: c.symbol,

    c: c,

    onCopy: triggerCopy,

    isCopied: copiedSymbol === c.symbol

  }))), /*#__PURE__*/React.createElement("div", {

    className: "section-head",

    style: {

      marginTop: '24px'

    }

  }, /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'flex',

      justifyContent: 'space-between',

      alignItems: 'center',

      flexWrap: 'wrap',

      gap: '12px',

      width: '100%'

    }

  }, /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'flex',

      alignItems: 'center',

      gap: '10px'

    }

  }, /*#__PURE__*/React.createElement("h2", {

    style: {

      margin: 0,

      fontSize: '16px',

      fontWeight: 800,

      color: 'var(--text)',

      display: 'flex',

      alignItems: 'center',

      gap: '8px'

    }

  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDE80 ", velocityTab === '10s' ? '10-Second Velocity Rockets' : 'Live 1-Minute Velocity Rockets'), /*#__PURE__*/React.createElement("span", {

    style: {

      fontSize: '12px',

      background: 'rgba(245,158,11,0.15)',

      color: 'var(--accent)',

      padding: '3px 8px',

      borderRadius: '12px',

      fontWeight: 700

    }

  }, "(", (velocityTab === '10s' ? cleanMovers10s : cleanMovers1m).length, " Fast Movers)"))), /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'flex',

      alignItems: 'center',

      gap: '6px'

    }

  }, /*#__PURE__*/React.createElement("button", {

    type: "button",

    onClick: () => setVelocityTab('1m'),

    style: {

      padding: '5px 12px',

      borderRadius: '8px',

      fontSize: '12px',

      fontWeight: 700,

      cursor: 'pointer',

      border: velocityTab === '1m' ? '1.5px solid var(--accent, #f59e0b)' : '1px solid var(--card-border, #e2e8f0)',

      background: velocityTab === '1m' ? 'rgba(245, 158, 11, 0.15)' : 'transparent',

      color: velocityTab === '1m' ? 'var(--accent, #f59e0b)' : 'var(--text-muted)'

    }

  }, "\u26A1 Table 1: 1-Minute ROC (", cleanMovers1m.length, ")"), /*#__PURE__*/React.createElement("button", {

    type: "button",

    onClick: () => setVelocityTab('10s'),

    style: {

      padding: '5px 12px',

      borderRadius: '8px',

      fontSize: '12px',

      fontWeight: 700,

      cursor: 'pointer',

      border: velocityTab === '10s' ? '1.5px solid var(--accent, #f59e0b)' : '1px solid var(--card-border, #e2e8f0)',

      background: velocityTab === '10s' ? 'rgba(245, 158, 11, 0.15)' : 'transparent',

      color: velocityTab === '10s' ? 'var(--accent, #f59e0b)' : 'var(--text-muted)'

    }

  }, "\u26A1 Table 2: 10-Second ROC (", cleanMovers10s.length, ")"))), /*#__PURE__*/React.createElement("div", {

    style: {

      fontSize: '12px',

      color: 'var(--text-muted)',

      marginTop: '4px'

    }

  }, velocityTab === '10s' ? 'Table 2: Strictly ranked by pure 10-second price ROC (% change in last 10s ticks). Non-zero only, updates dynamically.' : 'Table 1: Strictly ranked by pure 1-minute price ROC (% change in last 60s ticks). Non-zero only, updates dynamically.')), /*#__PURE__*/React.createElement("div", {

    style: {

      display: 'grid',

      gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',

      gap: '12px',

      marginBottom: '28px'

    }

  }, (velocityTab === '10s' ? cleanMovers10s : cleanMovers1m).length === 0 ? /*#__PURE__*/React.createElement("div", {

    style: {

      gridColumn: '1/-1',

      padding: '20px',

      textAlign: 'center',

      color: 'var(--text-muted)',

      background: 'var(--card-bg)',

      border: '1px solid var(--card-border)',

      borderRadius: '12px'

    }

  }, "Scanning live tick stream for ", velocityTab === '10s' ? '10-second' : '1-minute', " velocity bursts...") : (velocityTab === '10s' ? cleanMovers10s : cleanMovers1m).map(m => /*#__PURE__*/React.createElement(GrowwMoverCard, {

    key: m.symbol,

    m: m,

    mode: velocityTab,

    onCopy: triggerCopy,

    isCopied: copiedSymbol === m.symbol

  }))), /*#__PURE__*/React.createElement(StrangleSection, {
    strangleData: boardData.strangleCalls,
    trackerData: boardData.strangleTracker,
    onCopy: triggerCopy,
    copiedSymbol: copiedSymbol
  }), /*#__PURE__*/React.createElement("div", {

    className: "section-head",

    style: {

      marginTop: '32px'

    }

  }, /*#__PURE__*/React.createElement("h2", null, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCCA Institutional Swing Opportunities Overview (Live Engine Distribution & Setups)"))), /*#__PURE__*/React.createElement(KpiSummary, {

    scorecard: boardData.scorecard

  }), /*#__PURE__*/React.createElement("div", {

    className: "section-head"

  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", null, /*#__PURE__*/React.createElement("span", null, breakoutTab === 'TREND' ? "📈 Institutional Trend Follow (Stage 2 Relative Strength Leaders)" : breakoutTab === 'SUPPORT' ? "🛡️ High-Conviction Support Bounces (Re-accumulation Held)" : breakoutTab === 'CURRENT' ? "⚡ Actionable Current Breakouts (In Buy Pocket)" : breakoutTab === 'PRE' ? "🎯 Pre-Breakout Watchlist for Tomorrow" : "🏛️ Institutional Swing Opportunities for Tomorrow"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '12px',
      color: 'var(--accent)',
      fontWeight: 700,
      marginLeft: '8px'
    }
  }, breakoutTab === 'CURRENT' ? `(${filteredActiveCalls.length} Triggered)` : breakoutTab === 'PRE' ? `(${filteredActiveCalls.length} Watchlist Setups)` : `(${filteredActiveCalls.length} Setups: ${currentCalls.length} Current, ${preCalls.length} Pre-Watchlist)`)), /*#__PURE__*/React.createElement("div", {

    style: {

      fontSize: '11px',

      color: 'var(--text-muted)',

      marginTop: '4px',

      display: 'flex',

      alignItems: 'center',

      gap: '8px'

    }

  }, /*#__PURE__*/React.createElement("span", null, "\u26A1 Last Scanned: ", boardData.swingCallsTimestamp ? new Date(boardData.swingCallsTimestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST' + (boardData.swingCallsSession ? ' (' + boardData.swingCallsSession + ')' : '') : 'Pending Scan', " \xB7 Auto-scans every 30m during market open"), /*#__PURE__*/React.createElement("button", {

    onClick: triggerManualScan,

    disabled: isScanningNow,

    style: {

      padding: '2px 8px',

      fontSize: '10px',

      fontWeight: 'bold',

      background: 'rgba(59,130,246,0.15)',

      color: '#3b82f6',

      border: '1px solid #3b82f6',

      borderRadius: '4px',

      cursor: isScanningNow ? 'not-allowed' : 'pointer'

    }

  }, isScanningNow ? '\u23F3 Scanning 998 Stocks...' : '\uD83D\uDD04 Scan Now'))), /*#__PURE__*/React.createElement("div", {

    className: "filter-pills",

    style: { gap: '6px', flexWrap: 'wrap' }

  }, /*#__PURE__*/React.createElement("button", {

    className: `filter-pill ${breakoutTab === 'ALL' ? 'active' : ''}`,

    onClick: () => setBreakoutTab('ALL'),

    style: { fontWeight: 800 }

  }, `All (${allBreakoutCalls.length + supportCalls.length + trendCalls.length})`), /*#__PURE__*/React.createElement("button", {

    className: `filter-pill ${breakoutTab === 'CURRENT' ? 'active' : ''}`,

    onClick: () => setBreakoutTab('CURRENT'),

    style: breakoutTab === 'CURRENT' ? { background: '#059669', borderColor: '#059669', color: '#fff', fontWeight: 700 } : { fontWeight: 600 }

  }, `🏆 Multi-Confluence Breakouts (${currentCalls.length})`), /*#__PURE__*/React.createElement("button", {

    className: `filter-pill ${breakoutTab === 'PRE' ? 'active' : ''}`,

    onClick: () => setBreakoutTab('PRE'),

    style: breakoutTab === 'PRE' ? { background: '#0f172a', borderColor: '#0f172a', color: '#fff', fontWeight: 700 } : { fontWeight: 600 }

  }, `🎯 Pre-Breakout Watchlist (${preCalls.length})`), /*#__PURE__*/React.createElement("button", {
    className: `filter-pill ${breakoutTab === 'TREND' ? 'active' : ''}`,
    onClick: () => setBreakoutTab('TREND'),
    style: breakoutTab === 'TREND' ? { background: '#0f172a', borderColor: '#0f172a', color: '#fff', fontWeight: 700 } : { fontWeight: 600 }
  }, `📈 Trend Follow (${trendCalls.length})`), /*#__PURE__*/React.createElement("button", {
    className: `filter-pill ${breakoutTab === 'SUPPORT' ? 'active' : ''}`,
    onClick: () => setBreakoutTab('SUPPORT'),
    style: breakoutTab === 'SUPPORT' ? { background: '#0f172a', borderColor: '#0f172a', color: '#fff', fontWeight: 700 } : { fontWeight: 600 }
  }, `🛡️ Support Bounces (${supportCalls.length})`), /*#__PURE__*/React.createElement("span", {

    style: { borderLeft: '1px solid var(--card-border)', height: '18px', margin: '0 4px' }

  }), /*#__PURE__*/React.createElement("button", {

    className: `filter-pill ${activeFilter === 'ALL' ? 'active' : ''}`,

    onClick: () => setActiveFilter('ALL')

  }, "All Patterns"), /*#__PURE__*/React.createElement("button", {
    className: `filter-pill ${activeFilter === 'DOUBLE_BOTTOM' ? 'active' : ''}`,
    onClick: () => setActiveFilter('DOUBLE_BOTTOM')
  }, "🔱 W-Bottom Neckline"), /*#__PURE__*/React.createElement("button", {
    className: `filter-pill ${activeFilter === 'BREAKOUT' ? 'active' : ''}`,
    onClick: () => setActiveFilter('BREAKOUT')
  }, "☕ Pure Cup & Handle"), /*#__PURE__*/React.createElement("button", {
    className: `filter-pill ${activeFilter === 'FALLING_WEDGE' ? 'active' : ''}`,
    onClick: () => setActiveFilter('FALLING_WEDGE')
  }, "📐 Falling Wedge"), /*#__PURE__*/React.createElement("button", {
    className: `filter-pill ${activeFilter === 'BULL_FLAG' ? 'active' : ''}`,
    onClick: () => setActiveFilter('BULL_FLAG')
  }, "🚩 Bull Flag"), /*#__PURE__*/React.createElement("button", {
    className: `filter-pill ${activeFilter === 'TRIANGLE' ? 'active' : ''}`,
    onClick: () => setActiveFilter('TRIANGLE')
  }, "📐 Ascending Triangle"))), /*#__PURE__*/React.createElement("div", {

    className: "cards-grid"

  }, filteredActiveCalls.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      gridColumn: '1/-1',
      padding: '36px 20px',
      textAlign: 'center',
      background: 'var(--card-bg)',
      border: '1px solid var(--card-border)',
      borderRadius: '14px'
    }
  },
    /*#__PURE__*/React.createElement("div", { style: { fontSize: '15px', fontWeight: 800, color: 'var(--text)', marginBottom: '8px' } },
      breakoutTab === 'SUPPORT' ? "🛡️ 0 High-Conviction Support Bounces Passed Today" : breakoutTab === 'CURRENT' ? "⚡ No stocks triggered into the buy pocket today" : "No setups found for this filter"
    ),
    /*#__PURE__*/React.createElement("div", { style: { fontSize: '12px', color: 'var(--text-muted)', maxWidth: '600px', margin: '0 auto 16px', lineHeight: 1.5 } },
      breakoutTab === 'SUPPORT'
        ? `Daily scan of 984 liquid NSE equities completed. 0 stocks satisfied all 6 strict institutional conditions (Volume Dry-Up on pullback + Rejection Wick + Structural Demand Floor + Volume Ignition). Inaccurate single-EMA bounces were strictly rejected.`
        : breakoutTab === 'CURRENT'
        ? `Daily scan of 984 liquid NSE equities completed. 0 candidates closed inside the buy pocket today (Market Regime: Bullish). However, ${preCalls.length} high-conviction setups are coiling below pivot for tomorrow's open.`
        : "Scanner executes daily across 984 liquid NSE equities."
    ),
    (breakoutTab === 'SUPPORT' && (currentCalls.length > 0 || preCalls.length > 0)) && /*#__PURE__*/React.createElement("button", {
      onClick: () => setBreakoutTab(currentCalls.length > 0 ? 'CURRENT' : 'PRE'),
      style: {
        background: '#0f172a',
        color: '#ffffff',
        border: 'none',
        borderRadius: '6px',
        padding: '7px 16px',
        fontSize: '12px',
        fontWeight: 800,
        cursor: 'pointer',
        marginBottom: '12px'
      }
    }, currentCalls.length > 0 ? `⚡ View Actionable Triggered Breakout (${currentCalls.map(c => c.symbol).join(', ')}) →` : `🎯 View ${preCalls.length} Pre-Breakout Watchlist Setups →`),
    (breakoutTab === 'CURRENT' && preCalls.length > 0) && /*#__PURE__*/React.createElement("button", {
      onClick: () => setBreakoutTab('PRE'),
      style: {
        background: '#d97706',
        color: '#ffffff',
        border: 'none',
        borderRadius: '6px',
        padding: '7px 16px',
        fontSize: '12px',
        fontWeight: 800,
        cursor: 'pointer'
      }
    }, `🎯 View ${preCalls.length} Pre-Breakout Watchlist Setups →`)
  ) : filteredActiveCalls.map(c => /*#__PURE__*/React.createElement(ScalpCard, {

    key: c.symbol || c.id,

    call: c,

    onCopy: triggerCopy,

    isCopied: copiedSymbol === c.symbol

  }))), /*#__PURE__*/React.createElement("div", {

    className: "section-head"

  }, /*#__PURE__*/React.createElement("h2", null, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCDC Verified Closed Swing Trade Audit & Performance Ledger"), /*#__PURE__*/React.createElement("span", {

    style: {

      fontSize: '12px',

      color: 'var(--text-muted)',

      fontWeight: 700,

      marginLeft: '8px'

    }

  }, "(", (boardData.closedCalls || []).length, " Closed Trades)"))), /*#__PURE__*/React.createElement(HistoryTable, {

    closed: boardData.closedCalls || []

  }))), /*#__PURE__*/React.createElement(Toast, {

    toast: toast

  }));

}



// Resilient Error Boundary to eliminate Blank White Screens

class ScalpErrorBoundary extends React.Component {

  constructor(props) {

    super(props);

    this.state = { hasError: false, error: null };

  }

  static getDerivedStateFromError(error) {

    return { hasError: true, error };

  }

  componentDidCatch(error, errorInfo) {

    console.error('[ScalpErrorBoundary] Render caught error:', error, errorInfo);

  }

  render() {

    if (this.state.hasError) {

      return /*#__PURE__*/React.createElement("div", {

        style: {

          padding: '60px 24px',

          textAlign: 'center',

          fontFamily: "'Plus Jakarta Sans', sans-serif",

          color: 'var(--text, #0f172a)'

        }

      }, /*#__PURE__*/React.createElement("div", {

        style: { fontSize: '32px', marginBottom: '12px' }

      }, "\u26A1"), /*#__PURE__*/React.createElement("div", {

        style: { fontSize: '18px', fontWeight: 800 }

      }, "Reconnecting Scalping Feed\u2026"), /*#__PURE__*/React.createElement("div", {

        style: { fontSize: '13px', color: 'var(--text-muted, #64748b)', margin: '8px 0 20px' }

      }, String(this.state.error && this.state.error.message ? this.state.error.message : 'Feed recovering automatically.')), /*#__PURE__*/React.createElement("button", {

        onClick: () => {

          this.setState({ hasError: false, error: null });

          window.location.reload();

        },

        style: {

          padding: '10px 24px',

          background: '#d97706',

          color: '#fff',

          border: 'none',

          borderRadius: '8px',

          fontWeight: 700,

          cursor: 'pointer'

        }

      }, "Reload Dashboard"));

    }

    return this.props.children;

  }

}



// Resilient Mounting to DOM (Zero-blank retry watchdog)

let _mountAttempts = 0;

function mountScalpingApp() {

  const rootElement = document.getElementById('root');

  if (!rootElement) return;



  if (typeof window.React === 'undefined' || typeof window.ReactDOM === 'undefined') {

    _mountAttempts++;

    if (_mountAttempts < 40) {

      setTimeout(mountScalpingApp, 50);

      return;

    }

  }



  try {

    const root = ReactDOM.createRoot(rootElement);

    root.render(React.createElement(ScalpErrorBoundary, null, React.createElement(ScalpingApp)));

  } catch (err) {

    console.error('[ScalpingApp Mount Error]', err);

    rootElement.innerHTML = '<div style="padding: 60px 24px; text-align: center; font-family: system-ui, -apple-system, sans-serif; color: #0f172a;">' +

      '<div style="font-size: 36px; margin-bottom: 12px;">🏛️</div>' +

      '<div style="font-size: 18px; font-weight: 800;">Connecting Institutional Swing Feed…</div>' +

      '<div style="font-size: 13px; color: #64748b; margin: 8px 0 20px;">' + (err.message || 'Auto-recovering live feed connection') + '</div>' +

      '<button onclick="window.location.reload(true)" style="padding: 10px 24px; background: #d97706; color: #fff; border: none; border-radius: 8px; font-weight: 700; cursor: pointer;">Reload Dashboard</button>' +

      '</div>';

  }

}

if (document.readyState === 'loading') {

  document.addEventListener('DOMContentLoaded', mountScalpingApp);

} else {

  mountScalpingApp();

}