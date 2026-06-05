/* ============================================================
   ETH/USDT Signal Engine — analytics core
   Pure functions over OHLC candle arrays.
   Candle = {t (sec), o,h,l,c,v}
   ============================================================ */
(function (global) {
'use strict';

/* ---------- generic math / indicators ---------- */
const M = {
  sma(arr, p) {
    const out = Array(arr.length).fill(null);
    let s = 0;
    for (let i = 0; i < arr.length; i++) {
      s += arr[i];
      if (i >= p) s -= arr[i - p];
      if (i >= p - 1) out[i] = s / p;
    }
    return out;
  },
  ema(arr, p) {
    const out = Array(arr.length).fill(null);
    const k = 2 / (p + 1);
    let prev = null;
    for (let i = 0; i < arr.length; i++) {
      if (i < p - 1) continue;
      if (prev === null) {
        let s = 0; for (let j = i - p + 1; j <= i; j++) s += arr[j];
        prev = s / p;
      } else prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  },
  rsi(closes, p = 14) {
    const out = Array(closes.length).fill(null);
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) g += d; else l -= d;
    }
    g /= p; l /= p;
    out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
      l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  },
  atr(c, p = 14) {
    const tr = Array(c.length).fill(null);
    for (let i = 1; i < c.length; i++) {
      tr[i] = Math.max(
        c[i].h - c[i].l,
        Math.abs(c[i].h - c[i - 1].c),
        Math.abs(c[i].l - c[i - 1].c)
      );
    }
    const out = Array(c.length).fill(null);
    let prev = null;
    for (let i = 1; i < c.length; i++) {
      if (i < p) continue;
      if (prev === null) {
        let s = 0; for (let j = 1; j <= p; j++) s += tr[j];
        prev = s / p;
      } else prev = (prev * (p - 1) + tr[i]) / p;
      out[i] = prev;
    }
    return out;
  },
  macd(closes, f = 12, s = 26, sig = 9) {
    const ef = M.ema(closes, f), es = M.ema(closes, s);
    const line = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
    const valid = line.map(x => x == null ? 0 : x);
    const sg = M.ema(valid, sig);
    const hist = line.map((x, i) => (x != null && sg[i] != null) ? x - sg[i] : null);
    return { line, signal: sg, hist };
  }
};

/* ---------- timeframe resampling (daily -> N-day buckets is N/A;
   instead we fetch native granularities. Here we provide a helper to
   aggregate intraday into higher TF if needed) ---------- */
function resample(candles, factor) {
  if (factor <= 1) return candles.slice();
  const out = [];
  for (let i = 0; i < candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    if (!chunk.length) break;
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map(c => c.h)),
      l: Math.min(...chunk.map(c => c.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((a, c) => a + c.v, 0)
    });
  }
  return out;
}

/* ============================================================
   ANALYSIS MODULES — each returns {score:-1..1, label, detail}
   score>0 bullish, <0 bearish
   ============================================================ */

/* 1. Trend / Market structure (HH-HL vs LH-LL) using swing pivots */
function swings(c, look = 3) {
  const hi = [], lo = [];
  for (let i = look; i < c.length - look; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= look; j++) {
      if (c[i].h <= c[i - j].h || c[i].h <= c[i + j].h) isH = false;
      if (c[i].l >= c[i - j].l || c[i].l >= c[i + j].l) isL = false;
    }
    if (isH) hi.push({ i, p: c[i].h });
    if (isL) lo.push({ i, p: c[i].l });
  }
  return { hi, lo };
}

function marketStructure(c) {
  const s = swings(c);
  const H = s.hi.slice(-2), L = s.lo.slice(-2);
  let score = 0, txt = 'Range / unclear';
  if (H.length === 2 && L.length === 2) {
    const hh = H[1].p > H[0].p, hl = L[1].p > L[0].p;
    const lh = H[1].p < H[0].p, ll = L[1].p < L[0].p;
    if (hh && hl) { score = 1; txt = 'Uptrend — Higher Highs & Higher Lows'; }
    else if (lh && ll) { score = -1; txt = 'Downtrend — Lower Highs & Lower Lows'; }
    else if (hh && ll) { score = 0; txt = 'Expanding range / volatility'; }
    else { score = 0; txt = 'Contracting / transitional structure'; }
  }
  // Break of structure (last close vs last swing high/low)
  const last = c[c.length - 1].c;
  let bos = '';
  if (s.hi.length && last > s.hi[s.hi.length - 1].p) { bos = 'Bullish BOS (broke last swing high)'; score = Math.min(1, score + 0.5); }
  if (s.lo.length && last < s.lo[s.lo.length - 1].p) { bos = 'Bearish BOS (broke last swing low)'; score = Math.max(-1, score - 0.5); }
  return { score, label: 'Market Structure', detail: txt + (bos ? ' · ' + bos : ''), swings: s };
}

/* 2. Price-action trend via EMA stack + slope */
function trendEMA(c) {
  const cl = c.map(x => x.c);
  const e20 = M.ema(cl, 20), e50 = M.ema(cl, 50), e200 = M.ema(cl, 200);
  const i = c.length - 1;
  let score = 0, parts = [];
  if (e20[i] && e50[i]) { const up = e20[i] > e50[i]; score += up ? 0.4 : -0.4; parts.push(up ? '20>50 EMA' : '20<50 EMA'); }
  if (e50[i] && e200[i]) { const up = e50[i] > e200[i]; score += up ? 0.4 : -0.4; parts.push(up ? '50>200 EMA (bull)' : '50<200 EMA (bear)'); }
  if (e20[i] && e20[i - 5]) { const up = e20[i] > e20[i - 5]; score += up ? 0.2 : -0.2; parts.push(up ? 'rising slope' : 'falling slope'); }
  return { score: Math.max(-1, Math.min(1, score)), label: 'Trend (EMA Stack)', detail: parts.join(' · '), ema: { e20, e50, e200 } };
}

/* 3. Momentum: RSI + MACD histogram */
function momentum(c) {
  const cl = c.map(x => x.c);
  const rsi = M.rsi(cl, 14), macd = M.macd(cl);
  const i = c.length - 1;
  let score = 0, parts = [];
  const r = rsi[i];
  if (r != null) {
    if (r > 55) { score += 0.4; parts.push('RSI ' + r.toFixed(0) + ' (bullish)'); }
    else if (r < 45) { score -= 0.4; parts.push('RSI ' + r.toFixed(0) + ' (bearish)'); }
    else parts.push('RSI ' + r.toFixed(0) + ' (neutral)');
    if (r > 70) { parts.push('overbought'); score -= 0.15; }
    if (r < 30) { parts.push('oversold'); score += 0.15; }
  }
  const h = macd.hist[i], hp = macd.hist[i - 1];
  if (h != null && hp != null) {
    if (h > 0 && h >= hp) { score += 0.4; parts.push('MACD rising+'); }
    else if (h > 0) { score += 0.2; parts.push('MACD positive'); }
    else if (h < 0 && h <= hp) { score -= 0.4; parts.push('MACD falling-'); }
    else { score -= 0.2; parts.push('MACD negative'); }
  }
  return { score: Math.max(-1, Math.min(1, score)), label: 'Momentum (RSI+MACD)', detail: parts.join(' · '), rsi, macd };
}

/* 4. Candlestick patterns on last 1-3 candles */
function candles(c) {
  const n = c.length;
  const a = c[n - 3], b = c[n - 2], d = c[n - 1];
  let score = 0, found = [];
  const body = x => Math.abs(x.c - x.o);
  const range = x => (x.h - x.l) || 1e-9;
  const upWick = x => x.h - Math.max(x.c, x.o);
  const dnWick = x => Math.min(x.c, x.o) - x.l;
  // bullish/bearish engulfing
  if (b && d) {
    if (d.c > d.o && b.c < b.o && d.c >= b.o && d.o <= b.c) { score += 0.6; found.push('Bullish Engulfing'); }
    if (d.c < d.o && b.c > b.o && d.o >= b.c && d.c <= b.o) { score -= 0.6; found.push('Bearish Engulfing'); }
  }
  // hammer / shooting star
  if (dnWick(d) > body(d) * 2 && upWick(d) < body(d) && body(d) / range(d) < 0.4) { score += 0.45; found.push('Hammer'); }
  if (upWick(d) > body(d) * 2 && dnWick(d) < body(d) && body(d) / range(d) < 0.4) { score -= 0.45; found.push('Shooting Star'); }
  // doji
  if (body(d) / range(d) < 0.1) found.push('Doji (indecision)');
  // morning/evening star (3-candle)
  if (a && b && d) {
    if (a.c < a.o && body(b) / range(b) < 0.4 && d.c > d.o && d.c > (a.o + a.c) / 2) { score += 0.5; found.push('Morning Star'); }
    if (a.c > a.o && body(b) / range(b) < 0.4 && d.c < d.o && d.c < (a.o + a.c) / 2) { score -= 0.5; found.push('Evening Star'); }
  }
  if (!found.length) found.push('No major pattern');
  return { score: Math.max(-1, Math.min(1, score)), label: 'Candlestick Patterns', detail: found.join(' · ') };
}

/* 5. Supply & demand zones — find consolidation bases before strong moves */
function zones(c, atr) {
  const n = c.length;
  const out = [];
  const a = atr[n - 1] || (c[n - 1].c * 0.03);
  for (let i = 3; i < n - 2; i++) {
    const move = c[i + 1];
    const baseRange = Math.abs(c[i].h - c[i].l);
    const impulse = Math.abs(move.c - move.o);
    // demand: small base candle then strong up impulse
    if (impulse > a * 1.3 && move.c > move.o && baseRange < a) {
      out.push({ type: 'demand', lo: Math.min(c[i].l, c[i - 1].l), hi: Math.max(c[i].o, c[i].c), i });
    }
    if (impulse > a * 1.3 && move.c < move.o && baseRange < a) {
      out.push({ type: 'supply', lo: Math.min(c[i].o, c[i].c), hi: Math.max(c[i].h, c[i - 1].h), i });
    }
  }
  // keep most recent & nearest to price
  const price = c[n - 1].c;
  const demand = out.filter(z => z.type === 'demand' && z.hi < price * 1.02).slice(-3);
  const supply = out.filter(z => z.type === 'supply' && z.lo > price * 0.98).slice(-3);
  // score: closeness to demand (bull) vs supply (bear)
  let score = 0, detail = [];
  const nearestD = demand[demand.length - 1];
  const nearestS = supply[supply.length - 1];
  if (nearestD) { const dist = (price - nearestD.hi) / price; if (dist >= 0 && dist < 0.05) { score += 0.5; detail.push('Price near demand'); } }
  if (nearestS) { const dist = (nearestS.lo - price) / price; if (dist >= 0 && dist < 0.05) { score -= 0.5; detail.push('Price near supply'); } }
  if (!detail.length) detail.push('Price in mid-range between zones');
  return { score, label: 'Supply & Demand', detail: detail.join(' · '), demand, supply, all: out };
}

/* 6. Liquidity heat map — volume-by-price + equal highs/lows (liquidity pools) */
function liquidity(c) {
  const n = c.length;
  const win = Math.min(180, n);
  const slice = c.slice(n - win);
  let lo = Infinity, hi = -Infinity;
  slice.forEach(x => { lo = Math.min(lo, x.l); hi = Math.max(hi, x.h); });
  const BINS = 24;
  const step = (hi - lo) / BINS || 1;
  const bins = Array.from({ length: BINS }, (_, i) => ({ lo: lo + i * step, hi: lo + (i + 1) * step, vol: 0 }));
  slice.forEach(x => {
    const mid = (x.h + x.l + x.c) / 3;
    let b = Math.floor((mid - lo) / step); b = Math.max(0, Math.min(BINS - 1, b));
    bins[b].vol += x.v;
  });
  const maxVol = Math.max(...bins.map(b => b.vol)) || 1;
  // Point of control
  const poc = bins.reduce((a, b) => b.vol > a.vol ? b : a, bins[0]);
  // equal highs / lows = resting liquidity (stop clusters)
  const sw = swings(slice, 2);
  const tol = step * 0.5;
  const eqHi = [], eqLo = [];
  for (let i = 1; i < sw.hi.length; i++) if (Math.abs(sw.hi[i].p - sw.hi[i - 1].p) < tol) eqHi.push(sw.hi[i].p);
  for (let i = 1; i < sw.lo.length; i++) if (Math.abs(sw.lo[i].p - sw.lo[i - 1].p) < tol) eqLo.push(sw.lo[i].p);
  const price = c[n - 1].c;
  // score: liquidity above (eqHi) tends to attract price up (bullish draw); below = bearish draw
  let score = 0, detail = [];
  const liqAbove = eqHi.filter(p => p > price).length;
  const liqBelow = eqLo.filter(p => p < price).length;
  if (liqAbove > liqBelow) { score += 0.3; detail.push(liqAbove + ' buy-side pool(s) above'); }
  else if (liqBelow > liqAbove) { score -= 0.3; detail.push(liqBelow + ' sell-side pool(s) below'); }
  // price relative to POC
  if (price > poc.hi) { score += 0.2; detail.push('above POC (acceptance up)'); }
  else if (price < poc.lo) { score -= 0.2; detail.push('below POC (acceptance down)'); }
  else detail.push('trading at POC (value)');
  return {
    score: Math.max(-1, Math.min(1, score)), label: 'Liquidity Heat Map', detail: detail.join(' · '),
    bins, maxVol, poc, eqHi, eqLo, lo, hi, window: win
  };
}

/* 6b. Order-book liquidity — analyse a live L2 snapshot.
   book = {bids:[[price,size]...], asks:[[price,size]...]} (price desc bids / asc asks)
   Returns binned resting liquidity walls + bid/ask imbalance score. */
function orderbook(book, price) {
  if (!book || !book.bids || !book.asks || !book.bids.length || !book.asks.length) {
    return { score: 0, label: 'Order-Book Liquidity', detail: 'No live book', bins: [], available: false };
  }
  const bids = book.bids.map(b => ({ p: +b[0], s: +b[1] })).filter(x => isFinite(x.p) && isFinite(x.s));
  const asks = book.asks.map(a => ({ p: +a[0], s: +a[1] })).filter(x => isFinite(x.p) && isFinite(x.s));
  if (!bids.length || !asks.length) return { score: 0, label: 'Order-Book Liquidity', detail: 'Empty book', bins: [], available: false };

  // limit to a band around price (±4%) so far-away dust doesn't dominate
  const band = price * 0.04;
  const lo = price - band, hi = price + band;
  const bIn = bids.filter(b => b.p >= lo);
  const aIn = asks.filter(a => a.p <= hi);
  const bidVol = bIn.reduce((s, x) => s + x.s, 0);
  const askVol = aIn.reduce((s, x) => s + x.s, 0);
  const total = bidVol + askVol || 1;
  const imb = (bidVol - askVol) / total; // >0 = more bids (support) → bullish

  // bin into price buckets for a heat-map (combine both sides)
  const BINS = 20;
  const step = (hi - lo) / BINS || 1;
  const bins = Array.from({ length: BINS }, (_, i) => ({ lo: lo + i * step, hi: lo + (i + 1) * step, bid: 0, ask: 0 }));
  const place = (x, side) => { let k = Math.floor((x.p - lo) / step); k = Math.max(0, Math.min(BINS - 1, k)); bins[k][side] += x.s; };
  bIn.forEach(x => place(x, 'bid'));
  aIn.forEach(x => place(x, 'ask'));
  const maxVol = Math.max(1, ...bins.map(b => b.bid + b.ask));

  // detect "walls" = bins with size > 3x median
  const sizes = bins.map(b => b.bid + b.ask).filter(v => v > 0).sort((a, b) => a - b);
  const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const walls = bins
    .map(b => ({ mid: (b.lo + b.hi) / 2, size: b.bid + b.ask, side: b.bid >= b.ask ? 'bid' : 'ask' }))
    .filter(b => med > 0 && b.size > med * 3)
    .sort((a, b) => b.size - a.size).slice(0, 4);

  let score = Math.max(-1, Math.min(1, imb * 1.4));
  let detail = `Bid/ask imbalance ${(imb * 100).toFixed(0)}% within ±4% · ` +
    (imb > 0.08 ? 'bid-stacked (support)' : imb < -0.08 ? 'ask-stacked (resistance)' : 'balanced');
  return { score, label: 'Order-Book Liquidity', detail, bins, maxVol, walls, bidVol, askVol, imb, lo, hi, available: true };
}

/* 7. Elliott wave (simplified) — count alternating swings, infer impulse position */
function elliott(c) {
  const sw = swings(c, 3);
  const pts = [...sw.hi.map(x => ({ ...x, k: 'h' })), ...sw.lo.map(x => ({ ...x, k: 'l' }))].sort((a, b) => a.i - b.i);
  // build alternating zigzag
  const zz = [];
  for (const p of pts) {
    if (!zz.length) { zz.push(p); continue; }
    const last = zz[zz.length - 1];
    if (p.k === last.k) { // keep more extreme
      if ((p.k === 'h' && p.p > last.p) || (p.k === 'l' && p.p < last.p)) zz[zz.length - 1] = p;
    } else zz.push(p);
  }
  const recent = zz.slice(-6);
  let score = 0, detail = 'Insufficient swing data';
  if (recent.length >= 4) {
    const up = recent[recent.length - 1].p > recent[0].p;
    const legs = recent.length - 1;
    // odd impulse legs in trend direction
    if (up) {
      if (legs % 2 === 0) { score = 0.5; detail = 'Likely impulsive wave up (wave 3/5 context)'; }
      else { score = 0.25; detail = 'Corrective pullback within uptrend (wave 2/4)'; }
    } else {
      if (legs % 2 === 0) { score = -0.5; detail = 'Likely impulsive wave down (wave 3/5 context)'; }
      else { score = -0.25; detail = 'Corrective bounce within downtrend (wave 2/4)'; }
    }
  }
  return { score, label: 'Elliott Wave (model)', detail, zz: recent };
}

/* 8. Tether dominance inverse relation
   usdtPrev/usdtNow: USDT.D %, plus short trend. Falling USDT.D => bullish ETH */
function tetherDom(usdtSeries) {
  // usdtSeries: array of dominance % (chronological). use last vs ~7 ago
  if (!usdtSeries || usdtSeries.length < 8) return { score: 0, label: 'Tether Dominance', detail: 'Data unavailable', value: null };
  const now = usdtSeries[usdtSeries.length - 1];
  const prev = usdtSeries[usdtSeries.length - 8];
  const chg = (now - prev) / prev;
  let score = 0, detail;
  if (chg < -0.01) { score = 0.6; detail = `USDT.D falling ${(chg * 100).toFixed(2)}% → risk-on, bullish ETH`; }
  else if (chg > 0.01) { score = -0.6; detail = `USDT.D rising +${(chg * 100).toFixed(2)}% → risk-off, bearish ETH`; }
  else { score = 0; detail = `USDT.D flat (${now.toFixed(2)}%) → neutral`; }
  return { score, label: 'Tether Dominance (inverse)', detail, value: now };
}

/* ============================================================
   MULTI-TIMEFRAME CONFLUENCE + SIGNAL
   tfData = {high:[candles], mid:[candles], low:[candles]}
   weights configurable for calibration
   ============================================================ */
const DEFAULT_W = {
  structure: 1.4, trend: 1.2, momentum: 1.0, candles: 0.8,
  zones: 1.1, liquidity: 0.9, elliott: 0.7, tether: 1.0,
  tfHigh: 1.5, tfMid: 1.0, tfLow: 0.6
};

function analyzeTF(c) {
  const atr = M.atr(c, 14);
  const ms = marketStructure(c);
  const tr = trendEMA(c);
  const mo = momentum(c);
  const ca = candles(c);
  const zo = zones(c, atr);
  const li = liquidity(c);
  const el = elliott(c);
  return { atr, ms, tr, mo, ca, zo, li, el, price: c[c.length - 1].c };
}

function buildSignal(tfData, usdtSeries, params, book) {
  const p = Object.assign({}, DEFAULT_W, params || {});
  const H = analyzeTF(tfData.high);
  const Mi = analyzeTF(tfData.mid);
  const L = analyzeTF(tfData.low);
  const td = tetherDom(usdtSeries);
  const ob = orderbook(book, tfData.low[tfData.low.length - 1].c);

  function tfScore(A) {
    return (A.ms.score * p.structure + A.tr.score * p.trend + A.mo.score * p.momentum +
      A.ca.score * p.candles + A.zo.score * p.zones + A.li.score * p.liquidity +
      A.el.score * p.elliott) /
      (p.structure + p.trend + p.momentum + p.candles + p.zones + p.liquidity + p.elliott);
  }
  const sH = tfScore(H), sM = tfScore(Mi), sL = tfScore(L);
  const tfNet = (sH * p.tfHigh + sM * p.tfMid + sL * p.tfLow) / (p.tfHigh + p.tfMid + p.tfLow);
  // blend tether (cross-TF) + live order book (only when available)
  const baseW = p.structure + p.trend + p.momentum + p.candles + p.zones + p.liquidity + p.elliott;
  const obW = ob.available ? (p.orderbook != null ? p.orderbook : 0.8) : 0;
  const net = (tfNet * baseW + td.score * p.tether + ob.score * obW) /
    (baseW + p.tether + obW);

  const price = tfData.low[tfData.low.length - 1].c;
  const atr = L.atr[L.atr.length - 1] || price * 0.02;
  const thr = p.threshold != null ? p.threshold : 0.12;
  let side = 'NEUTRAL';
  if (net >= thr) side = 'LONG';
  else if (net <= -thr) side = 'SHORT';

  // levels using ATR, refined by a *nearby* zone only (capped to avoid blowout)
  const slMult = p.slMult != null ? p.slMult : 1.5;
  const baseStop = atr * slMult;
  const maxStop = atr * slMult * 2; // never let a zone push the stop beyond 2x base
  let entry = price, stop, t1, t2, t3;
  if (side === 'LONG') {
    entry = price;
    const z = H.zo.demand[H.zo.demand.length - 1];
    let s = price - baseStop;
    // if a demand zone sits just below entry, place stop a touch under it (but capped)
    if (z && z.lo < price && (price - z.lo) <= maxStop) s = Math.min(s, z.lo - atr * 0.25);
    stop = Math.max(s, price - maxStop);
    const risk = entry - stop;
    t1 = entry + risk * (p.t1R || 1.5);
    t2 = entry + risk * (p.t2R || 2.5);
    t3 = entry + risk * (p.t3R || 4.0);
  } else if (side === 'SHORT') {
    entry = price;
    const z = H.zo.supply[H.zo.supply.length - 1];
    let s = price + baseStop;
    if (z && z.hi > price && (z.hi - price) <= maxStop) s = Math.max(s, z.hi + atr * 0.25);
    stop = Math.min(s, price + maxStop);
    const risk = stop - entry;
    t1 = entry - risk * (p.t1R || 1.5);
    t2 = entry - risk * (p.t2R || 2.5);
    t3 = entry - risk * (p.t3R || 4.0);
  }
  const confidence = Math.min(100, Math.round(Math.abs(net) * 140));

  const factors = [
    Object.assign({ tf: 'HTF' }, H.ms),
    Object.assign({ tf: 'HTF' }, H.tr),
    Object.assign({ tf: 'MTF' }, Mi.mo),
    Object.assign({ tf: 'LTF' }, L.ca),
    Object.assign({ tf: 'HTF' }, H.zo),
    Object.assign({ tf: 'MTF' }, Mi.li),
    Object.assign({ tf: 'HTF' }, H.el),
    Object.assign({ tf: 'GLOBAL' }, td)
  ];
  if (ob.available) factors.push(Object.assign({ tf: 'LIVE' }, ob));

  return {
    side, net, confidence, price, entry, stop, t1, t2, t3, atr,
    factors, tfScores: { high: sH, mid: sM, low: sL },
    analysis: { H, M: Mi, L, td, ob }, params: p
  };
}

/* ============================================================
   BACKTEST — walk forward over daily candles.
   At each bar i (after warmup), compute signal using data up to i,
   then simulate forward: which hits first, stop or t2 (primary target).
   Returns trades + stats. Uses R-multiples.
   ============================================================ */
function backtest(daily, usdtAligned, params, opts) {
  opts = opts || {};
  const warmup = opts.warmup || 210;     // need EMA200 etc.
  const fwdMax = opts.fwdMax || 30;      // bars to resolve a trade
  const htf = opts.htf || 5;             // HTF resample factor
  const mtf = opts.mtf || 2;             // MTF resample factor
  const fee = opts.fee != null ? opts.fee : 0.0008; // round-trip approx
  const cooldownBars = opts.cooldown || 2;
  const trades = [];
  let lastExitIdx = -999;
  const p = Object.assign({}, DEFAULT_W, params || {});

  for (let i = warmup; i < daily.length - 1; i++) {
    if (i - lastExitIdx < cooldownBars) continue;
    const upto = daily.slice(0, i + 1);
    const tfData = {
      high: resample(upto, htf),
      mid: resample(upto, mtf),
      low: upto
    };
    if (tfData.high.length < 60) continue;
    const us = usdtAligned ? usdtAligned.slice(0, i + 1) : null;
    let sig;
    try { sig = buildSignal(tfData, us, p); } catch (e) { continue; }
    if (sig.side === 'NEUTRAL' || !isFinite(sig.stop)) continue;

    const entry = sig.entry;
    const stop = sig.stop;
    const tgt = sig.t2; // primary target = 2.5R default
    const risk = Math.abs(entry - stop);
    if (risk <= 0) continue;

    // simulate forward
    let exit = null, exitIdx = null, result = null;
    for (let j = i + 1; j <= Math.min(i + fwdMax, daily.length - 1); j++) {
      const bar = daily[j];
      if (sig.side === 'LONG') {
        if (bar.l <= stop) { exit = stop; result = 'loss'; exitIdx = j; break; }
        if (bar.h >= tgt) { exit = tgt; result = 'win'; exitIdx = j; break; }
      } else {
        if (bar.h >= stop) { exit = stop; result = 'loss'; exitIdx = j; break; }
        if (bar.l <= tgt) { exit = tgt; result = 'win'; exitIdx = j; break; }
      }
    }
    if (exit == null) { // time exit at last available
      exitIdx = Math.min(i + fwdMax, daily.length - 1);
      exit = daily[exitIdx].c;
      result = (sig.side === 'LONG' ? exit > entry : exit < entry) ? 'win-t' : 'loss-t';
    }
    let R = sig.side === 'LONG' ? (exit - entry) / risk : (entry - exit) / risk;
    R -= fee / (risk / entry); // subtract fees in R terms (approx)
    trades.push({
      idx: i, date: daily[i].t, side: sig.side, entry, stop, target: tgt,
      exit, exitIdx, R, result: R > 0 ? 'WIN' : 'LOSS', conf: sig.confidence
    });
    lastExitIdx = exitIdx;
  }
  return summarize(trades);
}

function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter(t => t.R > 0);
  const losses = trades.filter(t => t.R <= 0);
  const grossW = wins.reduce((a, t) => a + t.R, 0);
  const grossL = Math.abs(losses.reduce((a, t) => a + t.R, 0));
  let eq = 0, peak = 0, maxDD = 0;
  const curve = [];
  trades.forEach(t => {
    eq += t.R; peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
    curve.push({ date: t.date, eq, dd: peak - eq });
  });
  const expectancy = n ? trades.reduce((a, t) => a + t.R, 0) / n : 0;
  return {
    trades, curve,
    stats: {
      n, wins: wins.length, losses: losses.length,
      winRate: n ? wins.length / n * 100 : 0,
      profitFactor: grossL ? grossW / grossL : (grossW > 0 ? Infinity : 0),
      totalR: eq, expectancy, maxDD,
      avgWin: wins.length ? grossW / wins.length : 0,
      avgLoss: losses.length ? -grossL / losses.length : 0
    }
  };
}

/* ============================================================
   AUTO-CALIBRATION — sweep key params, pick best by an objective
   objective = expectancy * sqrt(n) penalized by drawdown
   ============================================================ */
function calibrate(daily, usdtAligned, onProgress, opts) {
  const grid = {
    threshold: [0.08, 0.12, 0.16, 0.20],
    slMult: [1.0, 1.5, 2.0],
    t2R: [2.0, 2.5, 3.0],
    tether: [0.5, 1.0, 1.6]
  };
  let best = null, tested = 0;
  const total = grid.threshold.length * grid.slMult.length * grid.t2R.length * grid.tether.length;
  const results = [];
  for (const threshold of grid.threshold)
    for (const slMult of grid.slMult)
      for (const t2R of grid.t2R)
        for (const tether of grid.tether) {
          const params = { threshold, slMult, t2R, t1R: Math.max(1, t2R - 1), t3R: t2R + 1.5, tether };
          const bt = backtest(daily, usdtAligned, params, opts);
          const s = bt.stats;
          // objective: require minimum sample, reward expectancy & PF, penalize DD
          let obj = -Infinity;
          if (s.n >= 8) {
            const pf = isFinite(s.profitFactor) ? s.profitFactor : 3;
            obj = s.expectancy * Math.sqrt(s.n) * Math.min(pf, 3) / (1 + s.maxDD * 0.15);
          }
          results.push({ params, stats: s, obj });
          if (!best || obj > best.obj) best = { params, stats: s, obj, bt };
          tested++;
          if (onProgress) onProgress(tested, total);
        }
  return { best, results };
}

/* ---------- expose ---------- */
global.Engine = {
  M, resample, marketStructure, trendEMA, momentum, candles, zones,
  liquidity, orderbook, elliott, tetherDom, analyzeTF, buildSignal, backtest,
  summarize, calibrate, DEFAULT_W
};

})(window);
