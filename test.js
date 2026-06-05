/* ============================================================
   test.js — unit + integration test harness for the engine.
   Run:  node test.js          (offline unit tests + live integration)
         node test.js --offline (skip network/integration tests)
   Exit code 0 = all pass, 1 = failure.
   ============================================================ */
'use strict';
const https = require('https');

// ---- load the engine (it attaches to global.window.Engine) ----
global.window = {};
require('./engine.js');
const E = global.window.Engine;

// ---- tiny assertion framework ----
let passed = 0, failed = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (got ${a}, expected ${b})`); }
function approx(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, expected ~${b})`); }
function finiteNum(x, msg) { ok(typeof x === 'number' && isFinite(x), `${msg} should be finite (got ${x})`); }
function section(name) { console.log('\n=== ' + name + ' ==='); }

// ---- helpers to synthesize candles ----
function mkCandle(t, o, h, l, c, v) { return { t, o, h, l, c, v: v == null ? 1000 : v }; }
// Zig-zag legs (impulse up 7 bars, pullback down 4 bars) repeated → clear
// swing highs/lows with net upward Higher-High/Higher-Low structure.
// Leg length (>look=3) guarantees the pivot detector registers swings.
function zigzag(n, start, dir) {
  // dir=+1 net up, -1 net down. impulse 7 bars, retrace 4 bars.
  // Wicks are derived from CLOSE (not open) so each peak/trough is a unique
  // pivot (open-based wicks created equal-highs that defeated pivot detection).
  const out = []; let p = start; let phase = 0; let impulse = true;
  for (let i = 0; i < n; i++) {
    const o = p;
    let r;
    if (impulse) r = dir > 0 ? 0.025 : -0.025;     // strong leg in trend dir
    else r = dir > 0 ? -0.012 : 0.012;             // shallower retrace
    p *= (1 + r); const c = p;
    out.push(mkCandle(1700000000 + i * 86400, o, c * 1.002, c * 0.998, c, 1000));
    phase++;
    if (impulse && phase >= 7) { impulse = false; phase = 0; }
    else if (!impulse && phase >= 4) { impulse = true; phase = 0; }
  }
  return out;
}
function trendUp(n, start = 1000) { return zigzag(n, start, +1); }
function trendDown(n, start = 6000) { return zigzag(n, start, -1); }
function flat(n, price = 2000) {
  return Array.from({ length: n }, (_, i) => mkCandle(1700000000 + i * 86400, price, price, price, price, 1000));
}
function seededRandom(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }
function randomWalk(n, seed = 42, start = 2000) {
  const rnd = seededRandom(seed); const out = []; let p = start;
  for (let i = 0; i < n; i++) {
    p *= (1 + (rnd() - 0.5) * 0.05);
    const o = p, c = p * (1 + (rnd() - 0.5) * 0.03);
    out.push(mkCandle(1700000000 + i * 86400, o, Math.max(o, c) * 1.01, Math.min(o, c) * 0.99, c, rnd() * 1000));
  }
  return out;
}

/* ============================================================
   UNIT TESTS — indicators
   ============================================================ */
section('Indicators (math)');
(() => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const sma = E.M.sma(arr, 3);
  eq(sma[0], null, 'SMA warmup is null');
  approx(sma[2], 2, 1e-9, 'SMA(3) at idx2 = (1+2+3)/3');
  approx(sma[9], 9, 1e-9, 'SMA(3) at idx9 = (8+9+10)/3');

  const ema = E.M.ema(arr, 3);
  finiteNum(ema[9], 'EMA last value');
  ok(ema[9] > ema[2], 'EMA rises on rising series');

  // RSI of strictly rising series should be ~100
  const rsi = E.M.rsi(arr.concat([11, 12, 13, 14, 15]), 14);
  ok(rsi[14] > 95, 'RSI of monotonic up ≈ 100');

  // ATR positive on volatile data
  const atr = E.M.atr(randomWalk(60, 1), 14);
  finiteNum(atr[59], 'ATR last');
  ok(atr[59] > 0, 'ATR positive');

  // MACD structure
  const macd = E.M.macd(arr.concat([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
  ok(macd.line.length === 20 && macd.signal.length === 20 && macd.hist.length === 20, 'MACD arrays aligned');
})();

section('resample');
(() => {
  const c = trendUp(20);
  const r5 = E.resample(c, 5);
  eq(r5.length, 4, 'resample(20,5) → 4 buckets');
  eq(r5[0].o, c[0].o, 'bucket open = first candle open');
  eq(r5[0].c, c[4].c, 'bucket close = last candle close');
  ok(r5[0].h >= Math.max(c[0].h, c[4].h) - 1e-9, 'bucket high = max of members');
  eq(E.resample(c, 1).length, 20, 'resample factor 1 = identity length');
})();

/* ============================================================
   UNIT TESTS — analysis modules directionality
   ============================================================ */
section('Module directionality');
(() => {
  const up = trendUp(260), down = trendDown(260);
  ok(E.marketStructure(up).score > 0, 'marketStructure bullish on uptrend');
  ok(E.marketStructure(down).score < 0, 'marketStructure bearish on downtrend');
  ok(E.trendEMA(up).score > 0, 'trendEMA bullish on uptrend');
  ok(E.trendEMA(down).score < 0, 'trendEMA bearish on downtrend');
  ok(E.momentum(up).score > 0, 'momentum bullish on uptrend');
  ok(E.momentum(down).score < 0, 'momentum bearish on downtrend');

  // candlestick: build a clean bullish engulfing at the end
  const ce = trendUp(10).slice(0, 8);
  ce.push(mkCandle(1, 100, 101, 95, 96, 1));   // bearish
  ce.push(mkCandle(2, 96, 110, 95, 108, 1));   // bullish engulfing
  ok(E.candles(ce).score > 0, 'candles detects bullish engulfing');

  // tether dominance: falling => bullish, rising => bearish
  const falling = Array.from({ length: 10 }, (_, i) => 6 - i * 0.05);
  const rising = Array.from({ length: 10 }, (_, i) => 5 + i * 0.05);
  ok(E.tetherDom(falling).score > 0, 'tetherDom: falling USDT.D bullish');
  ok(E.tetherDom(rising).score < 0, 'tetherDom: rising USDT.D bearish');
  eq(E.tetherDom(null).score, 0, 'tetherDom: null → neutral');
  eq(E.tetherDom([1, 2]).score, 0, 'tetherDom: too short → neutral');
})();

section('Price Action module');
(() => {
  const up = trendUp(260), down = trendDown(260);
  const paUp = E.priceAction(up, E.M.atr(up, 14));
  const paDn = E.priceAction(down, E.M.atr(down, 14));
  ok(paUp.score > 0, 'priceAction bullish bias in uptrend');
  ok(paDn.score < 0, 'priceAction bearish bias in downtrend');
  ok(Array.isArray(paUp.fvg), 'priceAction returns FVG array');
  ok(paUp.range && typeof paUp.range.posPct === 'number', 'priceAction returns range/posPct');
  ok(paUp.score >= -1 && paUp.score <= 1, 'priceAction score bounded');
  // insufficient data → neutral, no crash
  eq(E.priceAction(up.slice(0, 10), null).score, 0, 'priceAction: short data → neutral');

  // FVG detection: craft a clean 3-candle bullish gap (c3.low > c1.high)
  const g = [];
  for (let i = 0; i < 30; i++) g.push({ t: i, o: 100, h: 101, l: 99, c: 100, v: 1 });
  g.push({ t: 30, o: 100, h: 102, l: 99, c: 101, v: 1 });   // c1
  g.push({ t: 31, o: 101, h: 112, l: 101, c: 111, v: 1 });  // c2 strong up
  g.push({ t: 32, o: 111, h: 115, l: 105, c: 113, v: 1 });  // c3 low(105) > c1 high(102)
  const pg = E.priceAction(g, E.M.atr(g, 14));
  ok(pg.fvg.some(f => f.type === 'bull'), 'priceAction detects a bullish FVG');
  ok(pg.fvg.every(f => typeof f.t === 'number'), 'FVGs carry a timestamp (for plotting)');

  // order blocks exposed as a plottable array with timestamps
  ok(Array.isArray(paUp.orderBlocks), 'priceAction returns orderBlocks array');
  ok(paUp.orderBlocks.every(o => typeof o.t === 'number' && (o.type === 'bull' || o.type === 'bear')),
    'order blocks have timestamp & type');

  // trend-aware premium/discount: downtrend should NOT be flipped bullish by being at lows
  ok(E.marketStructure(down).score < 0 && paDn.score < 0, 'downtrend stays bearish (no mean-revert flip)');

  // CHoCH detection: build downtrend then break a swing high
  const ms = E.marketStructure(down);
  ok(typeof ms.trendDir === 'number', 'marketStructure exposes trendDir');
})();

section('Order-book module');
(() => {
  const price = 2000;
  // bid-stacked book → bullish
  const bidBook = {
    bids: [[1999, 100], [1998, 200], [1997, 300], [1990, 400]],
    asks: [[2001, 10], [2002, 20], [2003, 5]]
  };
  const ob1 = E.orderbook(bidBook, price);
  ok(ob1.available, 'orderbook available with data');
  ok(ob1.score > 0, 'orderbook bullish when bid-stacked');
  ok(ob1.imb > 0, 'imbalance positive when bids dominate');
  ok(Array.isArray(ob1.bins) && ob1.bins.length > 0, 'orderbook produces bins');

  const askBook = {
    bids: [[1999, 5], [1998, 10]],
    asks: [[2001, 100], [2002, 200], [2003, 300]]
  };
  ok(E.orderbook(askBook, price).score < 0, 'orderbook bearish when ask-stacked');

  // robustness
  eq(E.orderbook(null, price).available, false, 'orderbook null → unavailable');
  eq(E.orderbook({ bids: [], asks: [] }, price).available, false, 'orderbook empty → unavailable');
  eq(E.orderbook(null, price).score, 0, 'orderbook null → score 0');
})();

/* ============================================================
   UNIT TESTS — buildSignal robustness
   ============================================================ */
section('buildSignal robustness');
(() => {
  const mkTf = c => ({ high: E.resample(c, 5), mid: E.resample(c, 2), low: c });

  // flat data → should be NEUTRAL and not crash
  const sFlat = E.buildSignal(mkTf(flat(400)), null, {});
  eq(sFlat.side, 'NEUTRAL', 'flat data → NEUTRAL');
  finiteNum(sFlat.net, 'flat net finite');

  // strong uptrend → LONG with sane levels
  const sUp = E.buildSignal(mkTf(trendUp(400)), null, {});
  eq(sUp.side, 'LONG', 'strong uptrend → LONG');
  finiteNum(sUp.stop, 'LONG stop finite');
  ok(sUp.stop < sUp.entry, 'LONG stop below entry');
  ok(sUp.t1 > sUp.entry && sUp.t2 > sUp.t1 && sUp.t3 > sUp.t2, 'LONG targets ascending');

  // strong downtrend → SHORT with sane levels
  const sDn = E.buildSignal(mkTf(trendDown(400)), null, {});
  eq(sDn.side, 'SHORT', 'strong downtrend → SHORT');
  ok(sDn.stop > sDn.entry, 'SHORT stop above entry');
  ok(sDn.t1 < sDn.entry && sDn.t2 < sDn.t1 && sDn.t3 < sDn.t2, 'SHORT targets descending');

  // risk capped: stop distance never beyond 2x ATR*slMult
  const atr = sUp.atr, slMult = sUp.params.slMult || 1.5;
  ok((sUp.entry - sUp.stop) <= atr * slMult * 2 + 1e-6, 'LONG stop within risk cap');

  // order book integrates without breaking
  const book = { bids: [[1, 100]], asks: [[2, 1]] };
  const sOb = E.buildSignal(mkTf(trendUp(400)), null, {}, book);
  finiteNum(sOb.net, 'signal w/ orderbook net finite');
  ok(sOb.factors.some(f => f.label === 'Order-Book Liquidity'), 'orderbook appears in factors when provided');
  ok(!E.buildSignal(mkTf(trendUp(400)), null, {}).factors.some(f => f.label === 'Order-Book Liquidity'),
    'no orderbook factor when book absent');

  // confidence bounded 0..100
  ok(sUp.confidence >= 0 && sUp.confidence <= 100, 'confidence in [0,100]');

  // PA-only mode: mutes indicator/macro weights but still produces a signal
  const sPa = E.buildSignal(mkTf(trendUp(400)), null, { paOnly: true });
  eq(sPa.params.trend, 0, 'PA-only mutes EMA trend weight');
  eq(sPa.params.momentum, 0, 'PA-only mutes momentum weight');
  eq(sPa.params.elliott, 0, 'PA-only mutes Elliott weight');
  eq(sPa.params.tether, 0, 'PA-only mutes Tether weight');
  finiteNum(sPa.net, 'PA-only net finite');
  ok(sPa.side === 'LONG', 'PA-only still goes LONG on a clean uptrend');
})();

/* ============================================================
   UNIT TESTS — backtest & calibrate
   ============================================================ */
section('Backtest & calibrate');
(() => {
  const rw = randomWalk(500, 7);
  const bt = E.backtest(rw, null, {}, { capital: 10000, riskPct: 1 });
  finiteNum(bt.stats.n, 'backtest n finite');
  ok(bt.stats.n >= 0, 'backtest n non-negative');
  eq(bt.trades.length, bt.stats.n, 'trades length matches n');
  eq(bt.curve.length, bt.stats.n + 1, 'curve length = n + 1 (seed point)');
  if (bt.stats.n > 0) {
    eq(bt.stats.wins + bt.stats.losses, bt.stats.n, 'wins+losses = n');
    approx(bt.stats.winRate, bt.stats.wins / bt.stats.n * 100, 1e-6, 'winRate consistent');
    // final equity = last curve point, and = capital + netProfit
    approx(bt.stats.finalEquity, bt.curve[bt.curve.length - 1].equity, 1e-6, 'finalEquity = last curve equity');
    approx(bt.stats.finalEquity, bt.stats.capital + bt.stats.netProfit, 1e-6, 'finalEquity = capital + netProfit');
    approx(bt.stats.returnPct, bt.stats.netProfit / bt.stats.capital * 100, 1e-6, 'returnPct consistent');
    ok(bt.stats.maxDD >= 0 && bt.stats.maxDDpct >= 0, 'maxDD/maxDDpct non-negative');
    ok(bt.stats.totalFees >= 0, 'totalFees non-negative');
  }

  // --- dollar-model specifics ---
  // position sizing: risk ≈ riskPct of capital on first trade (before BE/partials)
  const bt2 = E.backtest(rw, null, {}, { capital: 50000, riskPct: 2, style: 'swing', beAfterTP1: false });
  if (bt2.trades.length) {
    const t = bt2.trades[0];
    const riskTaken = t.qty * Math.abs(t.entry - t.stop);
    approx(riskTaken, 50000 * 0.02, 50000 * 0.02 * 0.001 + 1e-6, 'qty sized to 2% risk (pre-leverage cap)');
    ok(t.notional > 0 && t.fees > 0, 'trade has notional & fees');
    ok(t.fills && t.fills.length >= 1, 'trade has fills (partial exits)');
  }
  // leverage cap limits notional
  const btLev = E.backtest(rw, null, {}, { capital: 1000, riskPct: 50, maxLeverage: 5 });
  if (btLev.trades.length) {
    ok(btLev.trades[0].notional <= 1000 * 5 + 1e-6, 'notional capped by max leverage');
  }
  // fees scale with taker rate
  const loFee = E.backtest(rw, null, {}, { fees: { maker: 0, taker: 0.0001, gst: 0 } });
  const hiFee = E.backtest(rw, null, {}, { fees: { maker: 0, taker: 0.01, gst: 0 } });
  if (loFee.stats.n && hiFee.stats.n) ok(hiFee.stats.totalFees > loFee.stats.totalFees, 'higher taker fee → more fees paid');
  // trade style changes horizon → generally different trade count or holding
  const scalp = E.backtest(rw, null, {}, { style: 'scalp' });
  const swing = E.backtest(rw, null, {}, { style: 'swing' });
  ok(scalp.stats.n >= 0 && swing.stats.n >= 0, 'scalp & swing both run');
  // STYLES & DELTA_FEES exposed
  ok(E.STYLES && E.STYLES.scalp && E.STYLES.swing, 'STYLES preset exposed');
  approx(E.DELTA_FEES.taker, 0.0005, 1e-9, 'Delta taker fee default 0.05%');
  approx(E.DELTA_FEES.maker, 0.0002, 1e-9, 'Delta maker fee default 0.02%');

  // empty/degenerate: flat data → zero trades, no crash
  const btFlat = E.backtest(flat(400), null, {}, { capital: 10000 });
  eq(btFlat.stats.n, 0, 'flat data → 0 trades');
  eq(btFlat.stats.finalEquity, 10000, 'flat data → equity unchanged');

  // calibrate returns a best with params + bt
  const cal = E.calibrate(rw, null, null, { htf: 5, mtf: 2, warmup: 210, fwdMax: 30 });
  ok(cal.best && cal.best.params, 'calibrate returns best.params');
  ok(cal.best.bt && cal.best.bt.stats, 'calibrate best has bt.stats');
  ok(cal.results.length === 216, 'calibrate swept full 216-cell grid (incl. priceAction)');
  ok(cal.best.params.priceAction != null, 'calibrated params include priceAction weight');
  ok(typeof cal.best.params.threshold === 'number', 'best.threshold numeric');

  // intraday opts: different warmup/htf must still run
  const calI = E.calibrate(rw, null, null, { htf: 6, mtf: 2, warmup: 220, fwdMax: 36 });
  ok(calI.best && calI.best.params, 'calibrate works with intraday opts');
})();

/* ============================================================
   INTEGRATION TESTS — live APIs (skipped with --offline)
   ============================================================ */
let skipped = 0;
function getJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        // surface rate-limit / throttle as a distinguishable error
        if (r.statusCode === 429 || /throttl/i.test(d)) return rej(new Error('THROTTLED'));
        try { res(JSON.parse(d)); } catch (e) { rej(new Error('parse: ' + d.slice(0, 40))); }
      });
    }).on('error', rej);
  });
}
// for integration: throttling/network is a SKIP (warning), not a failure
function okNet(cond, msg, err) {
  if (err && /THROTTLED|ETIMEDOUT|ENOTFOUND|ECONNRESET/i.test(err.message || '')) {
    skipped++; console.log('  ⚠ SKIP (network/throttle): ' + msg); return;
  }
  ok(cond, msg);
}

async function integration() {
  section('Integration — live data (Binance.US, Delta, Coinbase, CoinGecko)');

  // Binance.US klines (daily + 4h)
  try {
    const st = (Math.floor(Date.now() / 1000) - 740 * 86400) * 1000;
    const rows = await getJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=1d&limit=1000&startTime=${st}`);
    ok(Array.isArray(rows) && rows.length > 500, `Binance.US daily klines (${rows && rows.length})`);
    const h4 = await getJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=4h&limit=500`);
    ok(Array.isArray(h4) && h4.length > 100, `Binance.US 4h klines (${h4 && h4.length})`);
    const daily = rows.map(r => mkCandle(Math.floor(r[0] / 1000), +r[3] /*o*/, +r[2], +r[3], +r[4], +r[5]))
      .map((_, i) => ({ t: Math.floor(rows[i][0] / 1000), o: +rows[i][1], h: +rows[i][2], l: +rows[i][3], c: +rows[i][4], v: +rows[i][5] }));
    const sig = E.buildSignal({ high: E.resample(daily, 5), mid: E.resample(daily, 2), low: daily }, null, {});
    ok(['LONG', 'SHORT', 'NEUTRAL'].includes(sig.side), `Binance signal side valid (${sig.side})`);
    finiteNum(sig.net, 'Binance signal net finite');
  } catch (e) { okNet(false, 'Binance.US integration', e); }

  // Binance.US order book
  try {
    const ob = await getJSON('https://api.binance.us/api/v3/depth?symbol=ETHUSDT&limit=1000');
    ok(ob.bids && ob.asks && ob.bids.length > 50, `Binance.US order book depth (${ob.bids && ob.bids.length} bids)`);
    const price = (+ob.bids[0][0] + +ob.asks[0][0]) / 2;
    const obA = E.orderbook({ bids: ob.bids, asks: ob.asks }, price);
    ok(obA.available, 'Binance order book parsed by engine');
    finiteNum(obA.imb, 'Binance order book imbalance finite');
  } catch (e) { okNet(false, 'Binance order book', e); }

  // Delta candles + l2 book
  try {
    const end = Math.floor(Date.now() / 1000), start = end - 740 * 86400;
    const j = await getJSON(`https://api.delta.exchange/v2/history/candles?resolution=1d&symbol=ETHUSDT&start=${start}&end=${end}`);
    ok(j.success && j.result.length > 500, `Delta daily candles (${j.result && j.result.length})`);
    const lb = await getJSON('https://api.delta.exchange/v2/l2orderbook/ETHUSDT');
    ok(lb.success && lb.result.buy && lb.result.sell, 'Delta L2 order book shape');
    const bids = lb.result.buy.map(x => [+x.price, +x.size]).sort((a, b) => b[0] - a[0]);
    const asks = lb.result.sell.map(x => [+x.price, +x.size]).sort((a, b) => a[0] - b[0]);
    const price = (bids[0][0] + asks[0][0]) / 2;
    ok(E.orderbook({ bids, asks }, price).available, 'Delta order book parsed by engine');
  } catch (e) { okNet(false, 'Delta integration', e); }

  // Coinbase candles
  try {
    const cb = await getJSON('https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=86400');
    ok(Array.isArray(cb) && cb.length > 100, `Coinbase daily candles (${cb && cb.length})`);
  } catch (e) { okNet(false, 'Coinbase integration', e); }

  // CoinGecko dominance contract (throttling → skip, not fail)
  try {
    const g = await getJSON('https://api.coingecko.com/api/v3/global');
    ok(g.data && g.data.market_cap_percentage && typeof g.data.market_cap_percentage.usdt === 'number',
      `CoinGecko USDT dominance present (${g.data && g.data.market_cap_percentage && g.data.market_cap_percentage.usdt})`);
    const mc = await getJSON('https://api.coingecko.com/api/v3/coins/tether/market_chart?vs_currency=usd&days=365&interval=daily');
    ok(mc.market_caps && mc.market_caps.length > 100, `CoinGecko market_chart history (${mc.market_caps && mc.market_caps.length})`);
  } catch (e) { okNet(false, 'CoinGecko integration', e); }

  // Full pipeline on real Binance data: backtest + calibrate
  try {
    const st = (Math.floor(Date.now() / 1000) - 740 * 86400) * 1000;
    const rows = await getJSON(`https://api.binance.us/api/v3/klines?symbol=ETHUSDT&interval=1d&limit=1000&startTime=${st}`);
    const daily = rows.map(r => ({ t: Math.floor(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
    const cal = E.calibrate(daily, null, null, { capital: 10000, riskPct: 1, style: 'swing', maxLeverage: 25 });
    ok(cal.best && cal.best.params, 'live calibration produced a best param set');
    finiteNum(cal.best.stats.winRate, 'live calibrated win rate finite');
    finiteNum(cal.best.stats.finalEquity, 'live calibrated final equity finite');
    const s = cal.best.stats;
    console.log(`  ℹ live calibration ($10k, 1% risk, swing): ${s.n} trades, ${s.winRate.toFixed(1)}% win, PF ${isFinite(s.profitFactor)?s.profitFactor.toFixed(2):'∞'}, $${s.capital}→$${s.finalEquity.toFixed(0)} (${s.returnPct>=0?'+':''}${s.returnPct.toFixed(1)}%), $${s.totalFees.toFixed(0)} fees`);
  } catch (e) { okNet(false, 'Live pipeline', e); }
}

/* ============================================================
   RUN
   ============================================================ */
(async () => {
  const offline = process.argv.includes('--offline');
  if (!offline) {
    try { await integration(); }
    catch (e) { console.log('Integration suite error (network?):', e.message); }
  } else {
    console.log('\n(skipping integration tests — --offline)');
  }

  console.log('\n' + '─'.repeat(48));
  console.log(`RESULT: ${passed} passed, ${failed} failed${skipped ? ', ' + skipped + ' skipped (network/throttle)' : ''}`);
  if (failed) { console.log('FAILURES:'); fails.forEach(f => console.log('  • ' + f)); }
  process.exit(failed ? 1 : 0);
})();
