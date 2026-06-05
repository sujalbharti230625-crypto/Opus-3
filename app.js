/* ============================================================
   app.js — data fetching, UI, orchestration
   ============================================================ */
(function () {
'use strict';
const E = window.Engine;
const $ = s => document.querySelector(s);
const fmt = (n, d = 2) => n == null || !isFinite(n) ? '—' :
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
// place the sign before the $ so negatives read "-$1,234.50" not "$-1,234.50"
const usd = n => (n == null || !isFinite(n)) ? '—' :
  (n < 0 ? '-$' + fmt(-n, 2) : '$' + fmt(n, 2));

let STATE = { daily: null, usdt: null, calibrated: null, lastSignal: null };

/* ---------- status helpers ---------- */
function setStatus(txt, busy) {
  $('#statusTxt').textContent = txt;
  $('#spin').style.display = busy ? 'inline-block' : 'none';
}

/* ============================================================
   DATA FETCH — multi-source live ETH/USDT daily candles
   Sources: Binance.US (ETHUSDT), Delta Exchange (ETHUSDT),
            Coinbase (ETH-USD). All CORS-enabled for the browser.
   Returns ascending [{t(sec),o,h,l,c,v}], deduped.
   ============================================================ */
const SOURCES = {
  binance: { label: 'Binance.US · ETHUSDT', pair: 'ETHUSDT', tv: 'BINANCE:ETHUSDT' },
  delta:   { label: 'Delta Exchange · ETHUSDT', pair: 'ETHUSDT', tv: 'DELTA:ETHUSDT' },
  coinbase:{ label: 'Coinbase · ETH-USD', pair: 'ETH-USD', tv: 'COINBASE:ETHUSD' }
};

function dedupeSort(rows) {
  const map = new Map();
  rows.forEach(r => map.set(r.t, r));
  return [...map.values()].sort((a, b) => a.t - b.t);
}

/* Timeframe profiles: which native interval to fetch + how to build HTF/MTF/LTF.
   sec = seconds per base candle, htf/mtf = resample factors for confluence,
   warmup/fwdMax tune the backtest, tvInterval for the chart. */
const PROFILES = {
  swing:    { label: 'Swing · 1D',    binance: '1d',  delta: '1d',  cbGran: 86400, sec: 86400, htf: 5, mtf: 2, warmup: 210, fwdMax: 30, bars: 740, tvInterval: 'D',   note: '1W·2D·1D' },
  intraday: { label: 'Intraday · 4H', binance: '4h',  delta: '4h',  cbGran: 14400, sec: 14400, htf: 6, mtf: 2, warmup: 220, fwdMax: 36, bars: 1000, tvInterval: '240', note: '1D·8H·4H' },
  scalp:    { label: 'Scalp · 1H',    binance: '1h',  delta: '1h',  cbGran: 3600,  sec: 3600,  htf: 4, mtf: 2, warmup: 220, fwdMax: 48, bars: 1000, tvInterval: '60',  note: '4H·2H·1H' }
};
function activeProfile() { return PROFILES[($('#profile') && $('#profile').value) || 'swing'] || PROFILES.swing; }

// Binance.US klines: [openTime(ms),o,h,l,c,vol,closeTime,...]
async function fetchBinance(prof) {
  const startTime = (Math.floor(Date.now() / 1000) - prof.bars * prof.sec) * 1000;
  const url = `https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=${prof.binance}&limit=1000&startTime=${startTime}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Binance HTTP ' + res.status);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('Binance: empty response');
  return dedupeSort(rows.map(r => ({
    t: Math.floor(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5]
  })));
}

// Delta Exchange candles: result:[{time(sec),open,high,low,close,volume}]
async function fetchDelta(prof) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - prof.bars * prof.sec;
  const url = `https://api.delta.exchange/v2/history/candles?resolution=${prof.delta}&symbol=ETHUSDT&start=${start}&end=${end}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Delta HTTP ' + res.status);
  const j = await res.json();
  if (!j.success || !j.result || !j.result.length) throw new Error('Delta: empty response');
  return dedupeSort(j.result.map(r => ({
    t: r.time, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume
  })));
}

// Coinbase ETH-USD candles (chunked ≤300): [time,low,high,open,close,vol]
async function fetchCoinbase(prof) {
  const gran = prof.cbGran, max = 300;
  const now = Math.floor(Date.now() / 1000);
  const start = now - prof.bars * prof.sec;
  let all = [], cursorEnd = now;
  while (cursorEnd > start) {
    const cursorStart = Math.max(start, cursorEnd - max * gran);
    const url = `https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=${gran}` +
      `&start=${new Date(cursorStart * 1000).toISOString()}&end=${new Date(cursorEnd * 1000).toISOString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Coinbase HTTP ' + res.status);
    const rows = await res.json();
    all = all.concat(rows.map(r => ({ t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] })));
    cursorEnd = cursorStart;
    await new Promise(r => setTimeout(r, 250));
  }
  return dedupeSort(all);
}

const FETCHERS = { binance: fetchBinance, delta: fetchDelta, coinbase: fetchCoinbase };

// Fetch from chosen source, auto-fallback to others on failure.
async function fetchCandles(prof) {
  const chosen = $('#source').value;
  const order = [chosen, ...Object.keys(FETCHERS).filter(s => s !== chosen)];
  let lastErr;
  for (const src of order) {
    try {
      setStatus(`Fetching ${prof.label} ETH/USDT from ${SOURCES[src].label}…`, true);
      const data = await FETCHERS[src](prof);
      if (data.length < 200) throw new Error(src + ': only ' + data.length + ' candles');
      STATE.activeSource = src;
      return data;
    } catch (e) { console.warn(e); lastErr = e; }
  }
  throw new Error('All data sources failed (' + (lastErr ? lastErr.message : '') + ')');
}

/* ---------- live order-book snapshot (best-effort; non-fatal) ----------
   Normalized to {bids:[[price,size]], asks:[[price,size]]}, bids desc / asks asc. */
async function fetchOrderBook(src) {
  try {
    if (src === 'binance') {
      const j = await (await fetch('https://api.binance.us/api/v3/depth?symbol=ETHUSDT&limit=1000')).json();
      if (!j.bids || !j.asks) return null;
      return { bids: j.bids, asks: j.asks };
    }
    if (src === 'delta') {
      const j = await (await fetch('https://api.delta.exchange/v2/l2orderbook/ETHUSDT')).json();
      if (!j.success || !j.result) return null;
      const bids = (j.result.buy || []).map(x => [+x.price, +x.size]).sort((a, b) => b[0] - a[0]);
      const asks = (j.result.sell || []).map(x => [+x.price, +x.size]).sort((a, b) => a[0] - b[0]);
      return { bids, asks };
    }
    if (src === 'coinbase') {
      const j = await (await fetch('https://api.exchange.coinbase.com/products/ETH-USD/book?level=2')).json();
      if (!j.bids || !j.asks) return null;
      return { bids: j.bids.map(b => [+b[0], +b[1]]), asks: j.asks.map(a => [+a[0], +a[1]]) };
    }
  } catch (e) { console.warn('order book unavailable', e); }
  return null;
}

/* USDT dominance proxy: USDT market cap / total market cap, current + history.
   CoinGecko /global gives current; /coins/tether/market_chart gives mcap history.
   For dominance history we approximate using tether mcap vs a smoothed total proxy. */
async function fetchUsdtDominance(days) {
  let current = null, series = [];
  try {
    const g = await (await fetch('https://api.coingecko.com/api/v3/global')).json();
    const totals = g.data.total_market_cap;
    const pct = g.data.market_cap_percentage;
    current = pct && pct.usdt != null ? pct.usdt : null;
  } catch (e) { /* ignore */ }
  try {
    const d = Math.min(days, 365); // CG free tier daily up to 365
    const mc = await (await fetch(
      `https://api.coingecko.com/api/v3/coins/tether/market_chart?vs_currency=usd&days=${d}&interval=daily`
    )).json();
    // market_caps: [[ms, mcap]]
    if (mc.market_caps && mc.market_caps.length) {
      // Build a dominance-like series: normalize tether mcap to a slow baseline (its own 90d max)
      const caps = mc.market_caps.map(x => x[1]);
      // Use relative change of USDT mcap as dominance proxy direction.
      // Convert to a pseudo-% anchored to current dominance.
      const lastCap = caps[caps.length - 1];
      const anchor = current != null ? current : 5;
      series = caps.map(v => anchor * (v / lastCap));
    }
  } catch (e) { /* ignore */ }
  return { current, series };
}

/* align usdt daily series length to daily candles (pad with first val) */
function alignUsdt(daily, usdtSeries) {
  if (!usdtSeries || !usdtSeries.length) return null;
  const n = daily.length;
  if (usdtSeries.length >= n) return usdtSeries.slice(usdtSeries.length - n);
  const pad = Array(n - usdtSeries.length).fill(usdtSeries[0]);
  return pad.concat(usdtSeries);
}

/* ============================================================
   MAIN RUN
   ============================================================ */
async function runAnalysis() {
  const btn = $('#runBtn');
  btn.disabled = true;
  try {
    const prof = activeProfile();
    STATE.profile = prof;
    const daily = await fetchCandles(prof);
    STATE.daily = daily;
    setStatus('Fetching Tether dominance from CoinGecko…', true);
    const ud = await fetchUsdtDominance(365);
    STATE.usdt = ud;
    const usdtAligned = alignUsdt(daily, ud.series);
    STATE.usdtAligned = usdtAligned;

    // live order-book snapshot (best-effort, non-fatal)
    setStatus('Fetching live order book…', true);
    const book = await fetchOrderBook(STATE.activeSource);
    STATE.book = book;

    // header live stats
    const last = daily[daily.length - 1], prev = daily[daily.length - 2];
    $('#hPrice').textContent = usd(last.c);
    const ch = (last.c - prev.c) / prev.c * 100;
    $('#h24').textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
    $('#h24').style.color = ch >= 0 ? 'var(--grn)' : 'var(--red)';
    $('#hUsdt').textContent = ud.current != null ? ud.current.toFixed(2) + '%' : 'n/a';

    // Build MTF confluence per the active profile
    const paOnly = !!($('#paOnly') && $('#paOnly').checked);
    const params = Object.assign({}, STATE.calibrated || {}, { paOnly });
    const tfData = {
      high: E.resample(daily, prof.htf),
      mid: E.resample(daily, prof.mtf),
      low: daily
    };
    setStatus(paOnly ? 'Running price-action-only analysis…' : 'Running deep multi-factor analysis…', true);
    const sig = E.buildSignal(tfData, usdtAligned, params, book);
    STATE.lastSignal = sig;
    STATE.lastDaily = daily;

    renderSignal(sig);
    renderFactors(sig);
    renderPriceAction(sig);
    drawPaChart(daily, sig);
    renderZones(sig.analysis.H.zo, sig.price);
    renderLiquidity(sig.analysis.M.li, sig.price);
    renderOrderBook(sig.analysis.ob, sig.price);
    loadTradingView(true);

    $('#calibBtn').disabled = false;
    const srcLabel = SOURCES[STATE.activeSource] ? SOURCES[STATE.activeSource].label : STATE.activeSource;
    setStatus(`Analysis complete · ${daily.length} ${prof.label} candles from ${srcLabel} (${new Date(daily[0].t*1000).toLocaleString()} → ${new Date(last.t*1000).toLocaleString()})${book?' · live book ✓':' · book n/a'}. Now run the backtest to calibrate.`, false);
  } catch (e) {
    console.error(e);
    setStatus('⚠ ' + e.message + ' — (CORS/network: open the downloaded file directly in a browser with internet).', false);
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
   RENDER: signal
   ============================================================ */
function renderSignal(s) {
  const cls = s.side.toLowerCase();
  const dirWord = s.side === 'LONG' ? 'Buy / Long' : s.side === 'SHORT' ? 'Sell / Short' : 'Stand Aside';
  let lvls = '';
  if (s.side !== 'NEUTRAL') {
    const rr = (t) => '(' + (Math.abs(t - s.entry) / Math.abs(s.entry - s.stop)).toFixed(1) + 'R)';
    lvls = `
    <div class="lvls">
      <div class="lvl entry"><div class="lab">▸ Entry</div><div class="num">${usd(s.entry)}</div><div class="sub">market / limit zone</div></div>
      <div class="lvl stop"><div class="lab">■ Stop Loss</div><div class="num">${usd(s.stop)}</div><div class="sub">risk ${(Math.abs(s.entry-s.stop)/s.entry*100).toFixed(2)}%</div></div>
      <div class="lvl t1"><div class="lab">◉ Target 1</div><div class="num">${usd(s.t1)}</div><div class="sub">${rr(s.t1)} · scale 50%</div></div>
      <div class="lvl t2"><div class="lab">◉ Target 2</div><div class="num">${usd(s.t2)}</div><div class="sub">${rr(s.t2)} · scale 30%</div></div>
      <div class="lvl t3"><div class="lab">◉ Target 3</div><div class="num">${usd(s.t3)}</div><div class="sub">${rr(s.t3)} · runner</div></div>
      <div class="lvl"><div class="lab">⚖ Net Score</div><div class="num" style="color:var(--cyn)">${s.net.toFixed(3)}</div><div class="sub">HTF ${s.tfScores.high.toFixed(2)} · MTF ${s.tfScores.mid.toFixed(2)} · LTF ${s.tfScores.low.toFixed(2)}</div></div>
    </div>`;
  } else {
    lvls = `<p class="muted" style="margin-top:6px">Net score ${s.net.toFixed(3)} is inside the no-trade band (±${(s.params.threshold||0.12)}). The confluence is mixed — wait for alignment.</p>`;
  }
  $('#sigBody').innerHTML = `
    <div class="sig-head ${cls}">
      <div class="sig-badge ${cls}">${s.side}</div>
      <div class="sig-meta">
        <div style="font-size:16px;font-weight:600">ETH/USDT · ${dirWord}</div>
        <div class="conf">Confidence ${s.confidence}% · ATR ${usd(s.atr)}</div>
        <div class="conf-bar"><i style="width:${s.confidence}%"></i></div>
        <div style="margin-top:8px">
          ${STATE.calibrated ? '<span class="tag" style="background:#0d3a2c;color:#16c784">✓ Calibrated params</span>' : '<span class="tag">default params (run backtest to calibrate)</span>'}
        </div>
      </div>
    </div>
    ${lvls}`;
}

/* ============================================================
   RENDER: factors
   ============================================================ */
const ICONS = {
  bull: '<svg viewBox="0 0 24 24" fill="none" stroke="#16c784" stroke-width="2"><path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/></svg>',
  bear: '<svg viewBox="0 0 24 24" fill="none" stroke="#ea3943" stroke-width="2"><path d="M3 7l6 6 4-4 8 8"/><path d="M17 17h4v-4"/></svg>',
  neu: '<svg viewBox="0 0 24 24" fill="none" stroke="#8a98b5" stroke-width="2"><path d="M4 12h16"/></svg>'
};
// module weight lookup (mirrors engine DEFAULT_W) for display
const W_LABEL = {
  'Price Action (PA)': 'priceAction', 'Market Structure': 'structure',
  'Supply & Demand': 'zones', 'Candlestick Patterns': 'candles',
  'Liquidity Heat Map': 'liquidity', 'Trend (EMA Stack)': 'trend',
  'Momentum (RSI+MACD)': 'momentum', 'Elliott Wave (model)': 'elliott',
  'Tether Dominance (inverse)': 'tether', 'Order-Book Liquidity': 'orderbook'
};
function renderFactors(s) {
  const W = Object.assign({}, (window.Engine && window.Engine.DEFAULT_W) || {}, s.params || {});
  const wOf = label => { const key = W_LABEL[label]; return key && W[key] != null ? W[key] : null; };
  const rows = s.factors.map(f => {
    const k = f.score > 0.1 ? 'bull' : f.score < -0.1 ? 'bear' : 'neu';
    const pill = k === 'bull' ? 'BULLISH' : k === 'bear' ? 'BEARISH' : 'NEUTRAL';
    const w = wOf(f.label);
    const isPA = f.label === 'Price Action (PA)';
    const wTag = w != null ? `<span class="tag" style="background:${w>=1.5?'#1c2f1f':'#171c28'};color:${w>=1.5?'#16c784':'var(--dim)'}">w ${w}</span>` : '';
    return `<div class="fac" style="${isPA?'background:linear-gradient(90deg,rgba(139,92,246,.10),transparent);border-radius:8px':''}">
      <div class="ic">${ICONS[k]}</div>
      <div class="t"><b>${f.label} <span class="tag" style="background:#10182a;color:var(--dim)">${f.tf}</span> ${wTag}</b><span>${f.detail}</span></div>
      <div class="pill ${k}">${pill} ${f.score>0?'+':''}${f.score.toFixed(2)}</div>
    </div>`;
  }).join('');
  $('#facBody').innerHTML = rows +
    `<div style="margin-top:14px;font-size:12px;color:var(--mut)">Modules ordered & weighted by price-action priority (w = weight). Weighted net across 3 timeframes = <b style="color:var(--cyn)">${s.net.toFixed(3)}</b>. Long if ≥ +${(s.params.threshold||0.12)}, Short if ≤ −${(s.params.threshold||0.12)}.</div>`;
}

/* ============================================================
   RENDER: supply/demand zones
   ============================================================ */
function renderPriceAction(sig) {
  const H = sig.analysis.H, L = sig.analysis.L, price = sig.price;
  const paH = H.pa, paL = L.pa;
  const ms = H.ms;
  // dealing range premium/discount bar (HTF)
  const r = paH.range || { hi: price * 1.1, lo: price * 0.9, posPct: 0.5 };
  const pos = Math.max(0, Math.min(1, r.posPct));
  const zoneLabel = pos < 0.4 ? 'DISCOUNT' : pos > 0.6 ? 'PREMIUM' : 'EQUILIBRIUM';
  const zoneColor = pos < 0.4 ? 'var(--grn)' : pos > 0.6 ? 'var(--red)' : 'var(--mut)';

  // unfilled FVGs (combine HTF + LTF, nearest to price)
  const fvgs = [...(paH.fvg || []).map(f => ({ ...f, tf: 'HTF' })), ...(paL.fvg || []).map(f => ({ ...f, tf: 'LTF' }))]
    .sort((a, b) => Math.abs((a.mid - price)) - Math.abs((b.mid - price))).slice(0, 5);
  const fvgTags = fvgs.map(f =>
    `<span class="tag" style="background:${f.type==='bull'?'#0d3a2c':'#3a1216'};color:${f.type==='bull'?'#16c784':'#ea3943'}">${f.tf} ${f.type==='bull'?'Bull':'Bear'} FVG ${usd(f.lo)}–${usd(f.hi)}</span>`
  ).join(' ');

  const paPill = v => {
    const k = v > 0.1 ? 'bull' : v < -0.1 ? 'bear' : 'neu';
    const t = k === 'bull' ? 'BULLISH' : k === 'bear' ? 'BEARISH' : 'NEUTRAL';
    return `<span class="pill ${k}">${t} ${v>0?'+':''}${v.toFixed(2)}</span>`;
  };

  $('#paBody').innerHTML = `
    <div class="flexrow" style="gap:14px;margin-bottom:14px">
      <div class="cchip" style="flex:1">Market Structure (HTF) ${paPill(ms.score)}<div style="font-size:12px;color:var(--mut);margin-top:6px">${ms.detail}</div></div>
    </div>
    <div class="flexrow" style="gap:14px;margin-bottom:6px">
      <div style="flex:1"><div class="muted" style="font-size:12px;margin-bottom:6px">Price Action — HTF ${paPill(paH.score)}</div><div style="font-size:12.5px">${paH.detail}</div></div>
      <div style="flex:1"><div class="muted" style="font-size:12px;margin-bottom:6px">Price Action — LTF ${paPill(paL.score)}</div><div style="font-size:12.5px">${paL.detail}</div></div>
    </div>
    <h3 class="sub">Dealing Range — Premium / Discount (HTF)</h3>
    <div style="position:relative;height:34px;border-radius:8px;overflow:hidden;background:linear-gradient(90deg,rgba(22,199,132,.25),rgba(90,98,120,.15) 50%,rgba(234,57,67,.25))">
      <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#5d6b88"></div>
      <div style="position:absolute;left:${(pos*100).toFixed(1)}%;top:0;bottom:0;width:3px;background:var(--cyn);box-shadow:0 0 8px var(--cyn)"></div>
      <div style="position:absolute;left:6px;top:8px;font-size:11px;color:var(--grn)">DISCOUNT ${usd(r.lo)}</div>
      <div style="position:absolute;right:6px;top:8px;font-size:11px;color:var(--red)">PREMIUM ${usd(r.hi)}</div>
    </div>
    <div style="margin-top:8px;font-size:12.5px">Price <b style="color:var(--cyn)">${usd(price)}</b> sits at <b style="color:${zoneColor}">${(pos*100).toFixed(0)}% (${zoneLabel})</b> of the HTF dealing range. ${zoneLabel==='DISCOUNT'?'Discount favors longs / with-trend dip buys.':zoneLabel==='PREMIUM'?'Premium favors shorts / with-trend rally sells.':'Equilibrium — wait for displacement toward a premium/discount extreme.'}</div>
    <h3 class="sub">Unfilled Fair-Value Gaps (imbalances) near price</h3>
    <div>${fvgTags || '<span class="muted">No unfilled FVGs near current price.</span>'}</div>
    <div style="margin-top:12px;font-size:11.5px;color:var(--dim)">Price action is the highest-weighted layer of the engine (FVGs · liquidity sweeps · order blocks · premium/discount · rejection wicks · BOS/CHoCH). EMA/RSI/MACD only confirm.</div>`;
}

/* ============================================================
   Price-Action MAP — own canvas candlestick chart with overlays:
   unfilled FVGs, order blocks, swing H/L, premium/discount band,
   and the live entry / stop / targets.
   ============================================================ */
function drawPaChart(daily, sig) {
  const cv = $('#paChart'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.width = cv.clientWidth * dpr;
  const H = cv.height = 360 * dpr;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!daily || daily.length < 5) return;

  const N = Math.min(120, daily.length);          // last N candles
  const view = daily.slice(daily.length - N);
  const padL = 8 * dpr, padR = 64 * dpr, padT = 14 * dpr, padB = 22 * dpr;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  let lo = Math.min(...view.map(c => c.l)), hi = Math.max(...view.map(c => c.h));
  // include levels so they're visible
  const L = sig.analysis.L, pa = L.pa;
  const extra = [sig.entry, sig.stop, sig.t1, sig.t2, sig.t3].filter(isFinite);
  extra.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
  const pad = (hi - lo) * 0.06 || hi * 0.02; lo -= pad; hi += pad;
  const span = (hi - lo) || 1;
  const t0 = view[0].t, t1 = view[view.length - 1].t, tspan = (t1 - t0) || 1;
  const x = t => padL + plotW * ((t - t0) / tspan);
  const y = v => padT + plotH * (1 - (v - lo) / span);
  const cw = Math.max(1.5 * dpr, plotW / N * 0.62);

  // grid + right-axis price labels
  ctx.strokeStyle = '#161e30'; ctx.fillStyle = '#5d6b88'; ctx.lineWidth = dpr;
  ctx.font = `${10.5 * dpr}px sans-serif`; ctx.textAlign = 'left';
  for (let g = 0; g <= 4; g++) {
    const v = lo + span * g / 4, yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillText('$' + Math.round(v).toLocaleString('en-US'), W - padR + 4 * dpr, yy + 3.5 * dpr);
  }

  // premium/discount band from HTF range
  const r = (sig.analysis.H.pa && sig.analysis.H.pa.range) || null;
  if (r && r.hi > r.lo) {
    const yEq = y(r.eq);
    ctx.fillStyle = 'rgba(234,57,67,.05)'; ctx.fillRect(padL, y(r.hi), plotW, Math.max(0, yEq - y(r.hi)));
    ctx.fillStyle = 'rgba(22,199,132,.05)'; ctx.fillRect(padL, yEq, plotW, Math.max(0, y(r.lo) - yEq));
    ctx.strokeStyle = 'rgba(120,130,150,.4)'; ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(padL, yEq); ctx.lineTo(W - padR, yEq); ctx.stroke(); ctx.setLineDash([]);
  }

  // collect overlays from HTF + LTF (dedupe-ish by drawing both, clipped to view)
  const inView = t => t >= t0 - tspan * 0.02;
  const fvgs = [...(sig.analysis.H.pa.fvg || []), ...(pa.fvg || [])].filter(f => f.t && inView(f.t));
  const obs = [...(sig.analysis.H.pa.orderBlocks || []), ...(pa.orderBlocks || [])].filter(o => o.t && inView(o.t));

  // FVG rectangles (extend to right edge — they remain relevant until filled)
  fvgs.forEach(f => {
    const xx = x(Math.max(f.t, t0)); const w = (W - padR) - xx;
    const yTop = y(f.hi), hgt = Math.max(1 * dpr, y(f.lo) - y(f.hi));
    ctx.fillStyle = f.type === 'bull' ? 'rgba(22,199,132,.13)' : 'rgba(234,57,67,.13)';
    ctx.fillRect(xx, yTop, w, hgt);
    ctx.strokeStyle = f.type === 'bull' ? 'rgba(22,199,132,.35)' : 'rgba(234,57,67,.35)';
    ctx.lineWidth = dpr; ctx.strokeRect(xx, yTop, w, hgt);
  });

  // order blocks (solid edge boxes extended right)
  obs.forEach(o => {
    const xx = x(Math.max(o.t, t0)); const w = (W - padR) - xx;
    const yTop = y(o.hi), hgt = Math.max(1.5 * dpr, y(o.lo) - y(o.hi));
    ctx.fillStyle = o.type === 'bull' ? 'rgba(22,199,132,.10)' : 'rgba(234,57,67,.10)';
    ctx.fillRect(xx, yTop, w, hgt);
    ctx.strokeStyle = o.type === 'bull' ? '#16c784' : '#ea3943';
    ctx.lineWidth = 1.4 * dpr; ctx.strokeRect(xx, yTop, w, hgt);
    ctx.fillStyle = o.type === 'bull' ? '#16c784' : '#ea3943';
    ctx.font = `${9.5 * dpr}px sans-serif`;
    ctx.fillText(o.type === 'bull' ? 'OB+' : 'OB-', xx + 2 * dpr, yTop + 10 * dpr);
  });

  // candles
  view.forEach(c => {
    const cx = x(c.t), up = c.c >= c.o;
    ctx.strokeStyle = up ? '#16c784' : '#ea3943'; ctx.fillStyle = up ? '#16c784' : '#ea3943';
    ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
    const yO = y(c.o), yC = y(c.c);
    ctx.fillRect(cx - cw / 2, Math.min(yO, yC), cw, Math.max(1 * dpr, Math.abs(yC - yO)));
  });

  // swing H/L markers from LTF structure
  const sw = (L.ms && L.ms.swings) || { hi: [], lo: [] };
  ctx.fillStyle = '#f0b90b'; ctx.font = `${9 * dpr}px sans-serif`;
  const baseIdx = daily.length - N;
  sw.hi.slice(-6).forEach(s => { if (s.i >= baseIdx) { const cx = x(daily[s.i].t); ctx.beginPath(); ctx.arc(cx, y(s.p) - 5 * dpr, 2.4 * dpr, 0, 7); ctx.fill(); } });
  sw.lo.slice(-6).forEach(s => { if (s.i >= baseIdx) { const cx = x(daily[s.i].t); ctx.beginPath(); ctx.arc(cx, y(s.p) + 5 * dpr, 2.4 * dpr, 0, 7); ctx.fill(); } });

  // entry / stop / targets lines
  const line = (v, col, lab) => {
    if (!isFinite(v)) return;
    ctx.strokeStyle = col; ctx.lineWidth = 1.3 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W - padR, y(v)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.font = `${9.5 * dpr}px sans-serif`; ctx.textAlign = 'left';
    ctx.fillText(lab, padL + 3 * dpr, y(v) - 3 * dpr);
  };
  if (sig.side !== 'NEUTRAL') {
    line(sig.entry, '#22d3ee', 'Entry ' + usd(sig.entry));
    line(sig.stop, '#ea3943', 'SL ' + usd(sig.stop));
    line(sig.t1, '#16c784', 'TP1'); line(sig.t2, '#16c784', 'TP2'); line(sig.t3, '#16c784', 'TP3');
  }

  const note = $('#paChartNote'), srcEl = $('#paMapSrc');
  if (srcEl) srcEl.textContent = `${(STATE.profile&&STATE.profile.label)||''} · last ${N} candles`;
  if (note) note.innerHTML = `Boxes = unfilled <b style="color:#16c784">bull</b>/<b style="color:#ea3943">bear</b> FVGs & order blocks (extended right until filled). Dots = swing highs/lows. Dashed = live trade levels.${(sig.params&&sig.params.paOnly)?' <b style="color:#cbb6ff">PA-only mode active.</b>':''}`;
}

function renderZones(zo, price) {
  const all = [...zo.supply.map(z => ({ ...z })), ...zo.demand.map(z => ({ ...z }))]
    .sort((a, b) => b.hi - a.hi);
  if (!all.length) { $('#zoneBody').innerHTML = '<p class="muted">No high-probability institutional zones detected in current range.</p>'; return; }
  const max = Math.max(...all.map(z => z.hi)), min = Math.min(...all.map(z => z.lo));
  const span = (max - min) || 1;
  const rows = all.map(z => {
    const isS = z.type === 'supply';
    const w = ((z.hi - z.lo) / span * 100).toFixed(0);
    const left = ((z.lo - min) / span * 100).toFixed(0);
    return `<div class="zrow">
      <span class="lbl" style="color:${isS?'var(--red)':'var(--grn)'}">${isS?'SUPPLY':'DEMAND'}</span>
      <div style="flex:1;position:relative;height:18px;background:#0e1525;border-radius:5px">
        <div class="bar" style="position:absolute;left:${left}%;width:${Math.max(8,w)}%;background:${isS?'linear-gradient(90deg,#ea3943,#7a1c22)':'linear-gradient(90deg,#0d6b4c,#16c784)'};opacity:.85"></div>
      </div>
      <span class="px">${usd(z.lo).replace('$','')}–${usd(z.hi).replace('$','')}</span>
    </div>`;
  }).join('');
  $('#zoneBody').innerHTML = `<div class="zone-bar">${rows}</div>
    <div style="margin-top:12px;font-size:12px;color:var(--mut)">Current price <b style="color:var(--cyn)">${usd(price)}</b>. Demand zones = potential long entries; supply zones = potential short entries / profit targets. Derived from low-range base candles preceding strong impulse moves on the HTF.</div>`;
}

/* ============================================================
   RENDER: liquidity heat map
   ============================================================ */
function renderLiquidity(li, price) {
  const rows = li.bins.slice().reverse().map(b => {
    const pct = (b.vol / li.maxVol * 100);
    const isPoc = b === li.poc;
    const here = price >= b.lo && price < b.hi;
    const heat = `hsl(${190 - pct * 1.4},85%,${30 + pct * 0.25}%)`;
    return `<div class="zrow">
      <span class="px" style="width:70px">${usd((b.lo+b.hi)/2).replace('$','')}</span>
      <div style="flex:1;height:16px;background:#0e1525;border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${Math.max(2,pct)}%;background:${heat};border-radius:4px"></div>
      </div>
      <span class="lbl" style="width:auto;color:${isPoc?'var(--amb)':here?'var(--cyn)':'var(--dim)'}">${isPoc?'◀ POC':here?'◀ price':''}</span>
    </div>`;
  }).join('');
  const pools = [];
  li.eqHi.slice(-3).forEach(p => pools.push(`<span class="tag" style="background:#3a1216;color:#ea3943">SSL/BSL ${usd(p)}</span>`));
  li.eqLo.slice(-3).forEach(p => pools.push(`<span class="tag" style="background:#0d3a2c;color:#16c784">BSL/SSL ${usd(p)}</span>`));
  const srcLabel = (SOURCES[STATE.activeSource] && SOURCES[STATE.activeSource].label) || 'live exchange';
  const winN = (li.window != null) ? li.window : (li.bins ? li.bins.length : 0);
  const liqSrcEl = $('#liqSrc'); if (liqSrcEl) liqSrcEl.textContent = srcLabel.split(' · ')[0];
  $('#liqBody').innerHTML = `<div class="zone-bar">${rows}</div>
    <div style="margin-top:12px;font-size:12px;color:var(--mut)">Volume-by-price built from the last ${winN} ${srcLabel.split(' · ')[0]} candles. Brighter = more traded volume (resting liquidity / high-interest price). <b style="color:var(--amb)">POC</b> = point of control. Equal highs/lows below are stop-loss liquidity pools price tends to seek:</div>
    <div style="margin-top:8px">${pools.length?pools.join(' '):'<span class="muted">No clear equal-high/low liquidity pools.</span>'}</div>`;
}

/* ============================================================
   RENDER: live order-book depth (bids vs asks, walls, imbalance)
   ============================================================ */
function renderOrderBook(ob, price) {
  const srcEl = $('#obSrc');
  const srcName = (SOURCES[STATE.activeSource] && SOURCES[STATE.activeSource].label.split(' · ')[0]) || '—';
  if (srcEl) srcEl.textContent = srcName;
  if (!ob || !ob.available) {
    $('#obBody').innerHTML = '<p class="muted">Live order book not available for this source/run (network or endpoint limit). The signal still uses all other modules.</p>';
    return;
  }
  // bins are ascending in price; show high→low like a real book ladder
  const rows = ob.bins.slice().reverse().map(b => {
    const bidPct = b.bid / ob.maxVol * 100, askPct = b.ask / ob.maxVol * 100;
    const here = price >= b.lo && price < b.hi;
    return `<div class="zrow">
      <span class="px" style="width:74px;text-align:right">${usd((b.lo+b.hi)/2).replace('$','')}</span>
      <div style="flex:1;display:flex;align-items:center;gap:2px">
        <div style="flex:1;display:flex;justify-content:flex-end"><div style="height:13px;width:${askPct}%;background:linear-gradient(90deg,#7a1c22,#ea3943);border-radius:3px 0 0 3px"></div></div>
        <div style="width:1px;height:16px;background:${here?'var(--cyn)':'#2a3450'}"></div>
        <div style="flex:1"><div style="height:13px;width:${bidPct}%;background:linear-gradient(90deg,#16c784,#0d6b4c);border-radius:0 3px 3px 0"></div></div>
      </div>
      <span class="lbl" style="width:46px;color:${here?'var(--cyn)':'var(--dim)'}">${here?'◀ mid':''}</span>
    </div>`;
  }).join('');
  const imbCls = ob.imb > 0.08 ? 'var(--grn)' : ob.imb < -0.08 ? 'var(--red)' : 'var(--mut)';
  const walls = (ob.walls || []).map(w =>
    `<span class="tag" style="background:${w.side==='bid'?'#0d3a2c':'#3a1216'};color:${w.side==='bid'?'#16c784':'#ea3943'}">${w.side==='bid'?'BID':'ASK'} wall ${usd(w.mid)} · ${fmt(w.size,0)}</span>`
  ).join(' ');
  $('#obBody').innerHTML = `
    <div class="flexrow" style="margin-bottom:10px">
      <div class="cchip">Bid depth (±4%) <b style="color:var(--grn)">${fmt(ob.bidVol,0)}</b></div>
      <div class="cchip">Ask depth (±4%) <b style="color:var(--red)">${fmt(ob.askVol,0)}</b></div>
      <div class="cchip">Imbalance <b style="color:${imbCls}">${(ob.imb*100).toFixed(1)}%</b></div>
    </div>
    <div class="legend"><span><i style="background:var(--grn)"></i>Bids (support)</span><span><i style="background:var(--red)"></i>Asks (resistance)</span></div>
    <div class="zone-bar" style="margin-top:8px">${rows}</div>
    <div style="margin-top:12px;font-size:12px;color:var(--mut)">Real L2 snapshot from ${srcName}. ${ob.detail}. Large resting orders ("walls") often act as magnets or barriers:</div>
    <div style="margin-top:8px">${walls||'<span class="muted">No outsized walls within ±4%.</span>'}</div>`;
}

/* ============================================================
   TradingView widget
   ============================================================ */
let tvSymbol = null;
function loadTradingView(force) {
  if (typeof TradingView === 'undefined') return; // offline / blocked
  const src = STATE.activeSource || $('#source').value;
  const sym = (SOURCES[src] && SOURCES[src].tv) || 'BINANCE:ETHUSDT';
  const interval = (STATE.profile && STATE.profile.tvInterval) || activeProfile().tvInterval || 'D';
  const key = sym + '@' + interval;
  if (!force && tvSymbol === key) return;     // already showing this symbol+interval
  tvSymbol = key;
  const symEl = $('#tvSym'); if (symEl) symEl.textContent = sym;
  $('#tv').innerHTML = '';
  try {
    new TradingView.widget({
      autosize: true, symbol: sym, interval, timezone: 'Etc/UTC',
      theme: 'dark', style: '1', locale: 'en', container_id: 'tv',
      hide_side_toolbar: false, allow_symbol_change: true,
      studies: ['STD;EMA', 'STD;RSI', 'STD;MACD'], backgroundColor: '#0e1422'
    });
  } catch (e) { /* keep fallback */ }
}

/* ============================================================
   BACKTEST + CALIBRATE
   ============================================================ */
// read the money-management form into a backtest opts object
function readMM(prof) {
  const num = (id, d) => { const v = parseFloat(($('#' + id) || {}).value); return isFinite(v) ? v : d; };
  return {
    htf: prof.htf, mtf: prof.mtf, warmup: prof.warmup,
    capital: num('mmCapital', 10000),
    riskPct: num('mmRisk', 1),
    maxLeverage: num('mmLev', 25),
    style: ($('#mmStyle') || {}).value || 'swing',
    tpSplit: [num('mmTp1', 50), num('mmTp2', 30), num('mmTp3', 20)],
    beAfterTP1: (($('#mmBe') || {}).value || 'yes') === 'yes',
    fees: {
      maker: num('mmMaker', 0.02) / 100,
      taker: num('mmTaker', 0.05) / 100,
      gst: num('mmGst', 18) / 100
    }
  };
}

async function runCalibration() {
  if (!STATE.daily) { setStatus('Run the analysis first to load data.', false); return; }
  const btn = $('#calibBtn');
  btn.disabled = true;
  setStatus('Sweeping strategy parameters with your money-management settings…', true);
  $('#calibChips').innerHTML = '<div class="cchip">Calibrating… <b id="cprog">0%</b></div>';
  await new Promise(r => setTimeout(r, 50));

  // run in chunks to keep UI alive
  const daily = STATE.daily, ua = STATE.usdtAligned;
  const prof = STATE.profile || activeProfile();
  const opts = readMM(prof);
  STATE.mmOpts = opts;
  let out;
  await new Promise(resolve => {
    setTimeout(() => {
      out = E.calibrate(daily, ua, (done, total) => {
        const el = $('#cprog'); if (el) el.textContent = Math.round(done / total * 100) + '%';
      }, opts);
      resolve();
    }, 30);
  });

  const best = out.best;
  STATE.calibrated = best.params;
  renderCalib(best);
  renderBacktest(best.bt);

  // re-run live signal with calibrated params (keep live order book in the mix)
  const paOnly = !!($('#paOnly') && $('#paOnly').checked);
  const tfData = { high: E.resample(daily, prof.htf), mid: E.resample(daily, prof.mtf), low: daily };
  const sig = E.buildSignal(tfData, ua, Object.assign({}, STATE.calibrated, { paOnly }), STATE.book);
  STATE.lastSignal = sig;
  renderSignal(sig); renderFactors(sig); renderPriceAction(sig); drawPaChart(daily, sig); renderOrderBook(sig.analysis.ob, sig.price);

  const bs = best.bt.stats;
  setStatus(`Calibration complete · best of ${out.results.length} sets · ${usd(bs.capital)} → ${usd(bs.finalEquity)} (${bs.returnPct>=0?'+':''}${bs.returnPct.toFixed(1)}%, ${bs.n} trades, ${bs.winRate.toFixed(0)}% win, $${bs.totalFees.toFixed(0)} fees). Applied to the live signal above.`, false);
  btn.disabled = false;
}

function renderCalib(best) {
  const p = best.params, o = STATE.mmOpts || {};
  const objTxt = isFinite(best.obj) ? best.obj.toFixed(3) : 'n/a (too few trades)';
  const styleLabel = ({ scalp: 'Scalp', day: 'Day Trade', swing: 'Swing' })[o.style] || o.style || 'Swing';
  $('#calibChips').innerHTML = `
    <div class="cchip">Style <b>${styleLabel}</b></div>
    <div class="cchip">Capital <b>${usd(o.capital||10000)}</b></div>
    <div class="cchip">Risk/trade <b>${(o.riskPct!=null?o.riskPct:1)}%</b></div>
    <div class="cchip">Signal threshold <b>±${p.threshold}</b></div>
    <div class="cchip">Stop (ATR×) <b>${p.slMult}</b></div>
    <div class="cchip">Primary target <b>${p.t2R}R</b></div>
    <div class="cchip">Tether weight <b>${p.tether}</b></div>
    <div class="cchip">Objective <b>${objTxt}</b></div>`;
}

function renderBacktest(bt) {
  $('#btResults').style.display = 'block';
  const s = bt.stats;
  const k = (lab, val, cls, sub) => `<div class="kpi"><div class="k">${lab}</div><div class="v ${cls||''}">${val}</div>${sub?`<div class="sub" style="font-size:11px;color:var(--mut)">${sub}</div>`:''}</div>`;
  $('#kpis').innerHTML =
    k('Initial Capital', usd(s.capital)) +
    k('Final Equity', usd(s.finalEquity), s.finalEquity >= s.capital ? 'pos' : 'neg') +
    k('Net Profit', (s.netProfit >= 0 ? '+' : '') + usd(s.netProfit), s.netProfit >= 0 ? 'pos' : 'neg', (s.returnPct>=0?'+':'') + s.returnPct.toFixed(1) + '%') +
    k('CAGR', (s.cagr >= 0 ? '+' : '') + s.cagr.toFixed(1) + '%', s.cagr >= 0 ? 'pos' : 'neg', 'annualized') +
    k('Trades', s.n, '', `${s.wins}W / ${s.losses}L`) +
    k('Win Rate', s.winRate.toFixed(1) + '%', s.winRate >= 50 ? 'pos' : 'neg') +
    k('Profit Factor', isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞', s.profitFactor >= 1 ? 'pos' : 'neg') +
    k('Max Drawdown', '-' + s.maxDDpct.toFixed(1) + '%', 'neg', '-' + usd(s.maxDD)) +
    k('Total Fees Paid', usd(s.totalFees), 'neg', 'Delta futures + GST') +
    k('Avg Win', '+' + usd(s.avgWin), 'pos') +
    k('Avg Loss', usd(s.avgLoss), 'neg') +
    k('Expectancy', (s.expectancyDollars >= 0 ? '+' : '') + usd(s.expectancyDollars), s.expectancyDollars >= 0 ? 'pos' : 'neg', 'per trade · ' + (s.expectancyR>=0?'+':'') + s.expectancyR.toFixed(2) + 'R');
  STATE.lastCurve = bt.curve;
  drawEquity(bt.curve);
  drawTrades(bt.trades);
}

function drawEquity(curve) {
  const cv = $('#equity'), ctx = cv.getContext('2d');
  const W = cv.width = cv.clientWidth * devicePixelRatio;
  const H = cv.height = 240 * devicePixelRatio;
  ctx.clearRect(0, 0, W, H);
  if (!curve.length) return;
  const eqs = curve.map(c => c.equity);
  let min = Math.min(...eqs), max = Math.max(...eqs);
  const padBand = (max - min) * 0.08 || max * 0.05 || 1;
  min -= padBand; max += padBand;
  const span = (max - min) || 1;
  const pad = 56 * devicePixelRatio;
  const x = i => pad + (W - pad * 1.2) * (i / (curve.length - 1 || 1));
  const y = v => H - pad * 0.7 - (H - pad * 1.4) * ((v - min) / span);
  // grid + $ labels
  ctx.strokeStyle = '#1a2336'; ctx.lineWidth = devicePixelRatio;
  ctx.fillStyle = '#5d6b88'; ctx.font = `${11*devicePixelRatio}px sans-serif`;
  for (let g = 0; g <= 4; g++) {
    const v = min + span * g / 4, yy = y(v);
    ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(W - pad * 0.2, yy); ctx.stroke();
    ctx.fillText('$' + Math.round(v).toLocaleString('en-US'), 2 * devicePixelRatio, yy + 4 * devicePixelRatio);
  }
  // starting-capital reference line
  const cap = (STATE.mmOpts && STATE.mmOpts.capital) || curve[0].equity;
  if (cap >= min && cap <= max) {
    ctx.strokeStyle = '#39414f'; ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
    ctx.beginPath(); ctx.moveTo(pad, y(cap)); ctx.lineTo(W - pad * 0.2, y(cap)); ctx.stroke();
    ctx.setLineDash([]);
  }
  // equity area + line
  ctx.beginPath();
  curve.forEach((c, i) => { const xx = x(i), yy = y(c.equity); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
  ctx.strokeStyle = '#16c784'; ctx.lineWidth = 2.2 * devicePixelRatio; ctx.stroke();
  ctx.lineTo(x(curve.length - 1), y(min)); ctx.lineTo(x(0), y(min)); ctx.closePath();
  ctx.fillStyle = 'rgba(22,199,132,.10)'; ctx.fill();
  // drawdown band (peak-to-equity) in red
  let peak = curve[0].equity;
  ctx.beginPath();
  curve.forEach((c, i) => { peak = Math.max(peak, c.equity); const xx = x(i), yy = y(peak); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
  for (let i = curve.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(curve[i].equity));
  ctx.closePath(); ctx.fillStyle = 'rgba(234,57,67,.10)'; ctx.fill();
}

function drawTrades(trades) {
  const tb = $('#tradeTbl tbody');
  const rows = trades.slice(-40).reverse().map((t, i) => {
    const wcls = t.netPnl > 0 ? 'tw' : 'tl';
    const reasons = (t.fills || []).map(f => f.reason).join(', ');
    return `<tr>
      <td>${trades.length - i}</td>
      <td>${new Date(t.date * 1000).toLocaleDateString()}</td>
      <td style="color:${t.side==='LONG'?'var(--grn)':'var(--red)'}">${t.side}</td>
      <td>${t.style||''}</td>
      <td>${usd(t.entry)}</td>
      <td>${fmt(t.qty,3)}</td>
      <td>${t.tpsFilled}/3</td>
      <td style="font-size:11px">${reasons}</td>
      <td class="tl">${usd(t.fees)}</td>
      <td class="${wcls}">${t.netPnl>=0?'+':''}${usd(t.netPnl)}</td>
      <td>${usd(t.equity)}</td>
    </tr>`;
  }).join('');
  tb.innerHTML = rows || '<tr><td colspan="11" class="muted">No trades generated with these parameters.</td></tr>';
}

/* ---------- events ---------- */
$('#runBtn').addEventListener('click', runAnalysis);
$('#calibBtn').addEventListener('click', runCalibration);
$('#source').addEventListener('change', () => {
  // reset calibration (different market) and re-pull if we already had data
  STATE.calibrated = null; STATE.activeSource = $('#source').value;
  loadTradingView();
  if (STATE.daily) runAnalysis();
});
$('#profile').addEventListener('change', () => {
  // different timeframe => calibration no longer valid; re-pull + redraw chart
  STATE.calibrated = null; STATE.profile = activeProfile();
  loadTradingView();
  if (STATE.daily) runAnalysis();
});
$('#paOnly').addEventListener('change', () => {
  // toggling price-action-only re-runs the analysis (uses cached data, no refetch needed)
  if (STATE.daily) runAnalysis();
});

// redraw canvases on resize (sized from clientWidth)
let _rsz;
window.addEventListener('resize', () => {
  clearTimeout(_rsz);
  _rsz = setTimeout(() => {
    if (STATE.lastCurve) drawEquity(STATE.lastCurve);
    if (STATE.lastDaily && STATE.lastSignal) drawPaChart(STATE.lastDaily, STATE.lastSignal);
  }, 200);
});

// try TV early so the widget shows even before run
window.addEventListener('load', () => { setTimeout(() => loadTradingView(true), 600); });
})();
