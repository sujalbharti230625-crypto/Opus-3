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
  let score = 0, txt = 'Range / unclear', trendDir = 0;
  if (H.length === 2 && L.length === 2) {
    const hh = H[1].p > H[0].p, hl = L[1].p > L[0].p;
    const lh = H[1].p < H[0].p, ll = L[1].p < L[0].p;
    if (hh && hl) { score = 1; trendDir = 1; txt = 'Uptrend — Higher Highs & Higher Lows'; }
    else if (lh && ll) { score = -1; trendDir = -1; txt = 'Downtrend — Lower Highs & Lower Lows'; }
    else if (hh && ll) { score = 0; txt = 'Expanding range / volatility'; }
    else { score = 0; txt = 'Contracting / transitional structure'; }
  }
  const last = c[c.length - 1].c;
  const lastHi = s.hi.length ? s.hi[s.hi.length - 1] : null;
  const lastLo = s.lo.length ? s.lo[s.lo.length - 1] : null;

  // Break of Structure (BOS) = continuation in the prevailing trend direction.
  // Change of Character (CHoCH) = first break AGAINST the prevailing trend (early reversal).
  let event = '';
  if (lastHi && last > lastHi.p) {
    if (trendDir < 0) { event = 'Bullish CHoCH (broke down-trend high → possible reversal up)'; score = Math.min(1, score + 0.7); }
    else { event = 'Bullish BOS (continuation, broke last swing high)'; score = Math.min(1, score + 0.5); }
  } else if (lastLo && last < lastLo.p) {
    if (trendDir > 0) { event = 'Bearish CHoCH (broke up-trend low → possible reversal down)'; score = Math.max(-1, score - 0.7); }
    else { event = 'Bearish BOS (continuation, broke last swing low)'; score = Math.max(-1, score - 0.5); }
  }

  // Displacement: is the latest candle an outsized momentum move (institutional intent)?
  const n = c.length, atrApprox = (() => {
    let s2 = 0, k = 0; for (let j = Math.max(1, n - 14); j < n; j++) { s2 += Math.abs(c[j].c - c[j - 1].c); k++; }
    return k ? s2 / k : 0;
  })();
  const lastBody = Math.abs(c[n - 1].c - c[n - 1].o);
  if (atrApprox > 0 && lastBody > atrApprox * 1.8) {
    const dir = c[n - 1].c > c[n - 1].o ? 1 : -1;
    event += (event ? ' · ' : '') + (dir > 0 ? 'Bullish displacement' : 'Bearish displacement');
    score = Math.max(-1, Math.min(1, score + dir * 0.2));
  }

  return { score: Math.max(-1, Math.min(1, score)), label: 'Market Structure', detail: txt + (event ? ' · ' + event : ''), swings: s, trendDir };
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

/* 4b. PRICE ACTION — pure-PA concepts the other modules don't cover:
   Fair Value Gaps (imbalance), liquidity sweeps / stop-runs, premium-discount
   positioning within the dealing range, order blocks, and rejection wicks.
   This is the heaviest-weighted module per the price-action emphasis. */
function priceAction(c, atrArr) {
  const n = c.length;
  if (n < 30) return { score: 0, label: 'Price Action (PA)', detail: 'Insufficient data', fvg: [] };
  const atr = (atrArr && atrArr[n - 1]) || (c[n - 1].c * 0.02);
  const price = c[n - 1].c;
  let score = 0; const parts = [];

  // --- (1) Fair Value Gaps / imbalance: 3-candle gap where wick of c[i-1] and
  // c[i+1] don't overlap. Unfilled FVGs near price act as magnets / support. ---
  const fvg = [];
  for (let i = 2; i < n; i++) {
    const a = c[i - 2], b = c[i - 1], d = c[i];
    // bullish FVG: gap between a.high and d.low (impulse up leaves void)
    if (d.l > a.h && (b.c - b.o) > 0) fvg.push({ type: 'bull', lo: a.h, hi: d.l, i, t: d.t, mid: (a.h + d.l) / 2 });
    // bearish FVG: gap between a.low and d.high (impulse down)
    if (d.h < a.l && (b.c - b.o) < 0) fvg.push({ type: 'bear', lo: d.h, hi: a.l, i, t: d.t, mid: (d.h + a.l) / 2 });
  }
  // unfilled FVGs = price hasn't traded back through them since
  const unfilled = fvg.filter(g => {
    for (let j = g.i + 1; j < n; j++) {
      if (g.type === 'bull' && c[j].l <= g.lo) return false;
      if (g.type === 'bear' && c[j].h >= g.hi) return false;
    }
    return true;
  }).slice(-4);
  const recentFvg = fvg.slice(-1)[0];
  if (recentFvg && recentFvg.i >= n - 3) {
    if (recentFvg.type === 'bull') { score += 0.4; parts.push('Fresh bullish FVG (imbalance up)'); }
    else { score -= 0.4; parts.push('Fresh bearish FVG (imbalance down)'); }
  }

  // --- (2) Liquidity sweep / stop run: price pokes beyond a recent swing
  // extreme then closes back inside → liquidity grab, reversal fuel. ---
  const look = 20;
  const seg = c.slice(Math.max(0, n - look), n - 1);
  const recentHigh = Math.max(...seg.map(x => x.h));
  const recentLow = Math.min(...seg.map(x => x.l));
  const last = c[n - 1];
  if (last.h > recentHigh && last.c < recentHigh) { score -= 0.5; parts.push('Sell-side sweep (swept highs, closed back in → bearish)'); }
  if (last.l < recentLow && last.c > recentLow) { score += 0.5; parts.push('Buy-side sweep (swept lows, closed back in → bullish)'); }

  // --- (3) Premium / discount within the dealing range (last ~40 bars).
  // Mean-reversion (discount→long, premium→short) only applies in a RANGE.
  // In a trend, premium/discount instead flags with-trend pullback entries. ---
  const dr = c.slice(Math.max(0, n - 40));
  const drHi = Math.max(...dr.map(x => x.h)), drLo = Math.min(...dr.map(x => x.l));
  const eq = (drHi + drLo) / 2, span = (drHi - drLo) || 1;
  const posPct = (price - drLo) / span; // 0=low,1=high
  // is the dealing range itself trending? compare first-half vs second-half mid
  const half = Math.floor(dr.length / 2);
  const midA = dr.slice(0, half).reduce((s, x) => s + x.c, 0) / (half || 1);
  const midB = dr.slice(half).reduce((s, x) => s + x.c, 0) / ((dr.length - half) || 1);
  const rangeTrend = (midB - midA) / (eq || 1); // >0.03 up, <-0.03 down
  const trending = Math.abs(rangeTrend) > 0.03;
  if (!trending) {
    // range → classic mean reversion
    if (posPct < 0.4) { score += 0.3; parts.push('Discount of range (' + (posPct * 100).toFixed(0) + '% → favor longs)'); }
    else if (posPct > 0.6) { score -= 0.3; parts.push('Premium of range (' + (posPct * 100).toFixed(0) + '% → favor shorts)'); }
    else parts.push('Equilibrium (~50% of range)');
  } else if (rangeTrend > 0) {
    // uptrend → buy pullbacks into discount, don't fade premium
    if (posPct < 0.45) { score += 0.35; parts.push('Discount pullback in uptrend (with-trend long)'); }
    else parts.push('Premium in uptrend (wait for pullback)');
  } else {
    // downtrend → sell rallies into premium, don't fade discount
    if (posPct > 0.55) { score -= 0.35; parts.push('Premium rally in downtrend (with-trend short)'); }
    else parts.push('Discount in downtrend (wait for rally)');
  }

  // --- (4) Order blocks: opposite-color candle before a displacement move.
  // Collect recent ones (for plotting); score only when price is inside one. ---
  const orderBlocks = [];
  for (let i = n - 2; i >= Math.max(1, n - 60); i--) {
    const mv = c[i + 1];
    if (Math.abs(mv.c - mv.o) <= atr * 1.5) continue;
    if (mv.c > mv.o && c[i].c < c[i].o) { // bullish OB (down candle before up displacement)
      // mitigated if price has since traded fully below it
      let mitig = false; for (let j = i + 2; j < n; j++) if (c[j].c < c[i].l) { mitig = true; break; }
      orderBlocks.push({ type: 'bull', lo: c[i].l, hi: c[i].h, i, t: c[i].t, mitigated: mitig });
    } else if (mv.c < mv.o && c[i].c > c[i].o) { // bearish OB
      let mitig = false; for (let j = i + 2; j < n; j++) if (c[j].c > c[i].h) { mitig = true; break; }
      orderBlocks.push({ type: 'bear', lo: c[i].l, hi: c[i].h, i, t: c[i].t, mitigated: mitig });
    }
  }
  // nearest unmitigated OB drives the score
  const nearestOB = orderBlocks.filter(o => !o.mitigated)
    .sort((a, b) => Math.abs((a.lo + a.hi) / 2 - price) - Math.abs((b.lo + b.hi) / 2 - price))[0];
  if (nearestOB) {
    if (nearestOB.type === 'bull' && price >= nearestOB.lo && price <= nearestOB.hi * 1.01) { score += 0.35; parts.push('Price at bullish order block'); }
    if (nearestOB.type === 'bear' && price <= nearestOB.hi && price >= nearestOB.lo * 0.99) { score -= 0.35; parts.push('Price at bearish order block'); }
  }
  const obPlot = orderBlocks.filter(o => !o.mitigated).slice(0, 6);

  // --- (5) Rejection wick on the last candle (pressure imbalance). ---
  const body = Math.abs(last.c - last.o), rng = (last.h - last.l) || 1e-9;
  const upW = last.h - Math.max(last.c, last.o), dnW = Math.min(last.c, last.o) - last.l;
  if (dnW > rng * 0.55 && body < rng * 0.4) { score += 0.25; parts.push('Long lower wick (demand rejection)'); }
  if (upW > rng * 0.55 && body < rng * 0.4) { score -= 0.25; parts.push('Long upper wick (supply rejection)'); }

  if (!parts.length) parts.push('Neutral price action');
  return {
    score: Math.max(-1, Math.min(1, score)), label: 'Price Action (PA)',
    detail: parts.join(' · '), fvg: unfilled, orderBlocks: obPlot,
    range: { hi: drHi, lo: drLo, eq, posPct }
  };
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
/* Weights — PRICE-ACTION EMPHASIS.
   Pure price-action modules (priceAction, market structure, supply/demand,
   candlesticks) dominate; lagging indicators (EMA trend, RSI/MACD momentum,
   Elliott) are de-emphasized to a confirming role. */
const DEFAULT_W = {
  priceAction: 2.2,   // FVG, sweeps, premium/discount, order blocks, rejection
  structure: 2.0,     // BOS / CHoCH / displacement (raised)
  zones: 1.6,         // supply & demand (raised)
  candles: 1.3,       // candlestick patterns (raised)
  liquidity: 1.0,
  trend: 0.7,         // EMA stack — confirming only (lowered)
  momentum: 0.6,      // RSI/MACD — confirming only (lowered)
  elliott: 0.5,       // lowered
  tether: 0.9,
  tfHigh: 1.5, tfMid: 1.0, tfLow: 0.7
};

function analyzeTF(c) {
  const atr = M.atr(c, 14);
  const ms = marketStructure(c);
  const pa = priceAction(c, atr);
  const tr = trendEMA(c);
  const mo = momentum(c);
  const ca = candles(c);
  const zo = zones(c, atr);
  const li = liquidity(c);
  const el = elliott(c);
  return { atr, ms, pa, tr, mo, ca, zo, li, el, price: c[c.length - 1].c };
}

function buildSignal(tfData, usdtSeries, params, book) {
  const p = Object.assign({}, DEFAULT_W, params || {});
  // Price-action-only mode: mute the lagging/indicator & macro modules so the
  // signal is driven purely by price action, structure, S/D, candles & liquidity.
  if (p.paOnly) { p.trend = 0; p.momentum = 0; p.elliott = 0; p.tether = 0; p.orderbook = 0; }
  const H = analyzeTF(tfData.high);
  const Mi = analyzeTF(tfData.mid);
  const L = analyzeTF(tfData.low);
  const td = tetherDom(usdtSeries);
  const ob = orderbook(book, tfData.low[tfData.low.length - 1].c);

  const paW = p.priceAction != null ? p.priceAction : 2.2;
  const sumW = paW + p.structure + p.trend + p.momentum + p.candles + p.zones + p.liquidity + p.elliott;
  // guard: if a (mis)configuration zeroes every module weight, fall back to a
  // price-action-only divisor so the score never becomes NaN (div-by-zero).
  const tfDiv = sumW > 0 ? sumW : 1;
  function tfScore(A) {
    return (A.pa.score * paW + A.ms.score * p.structure + A.tr.score * p.trend +
      A.mo.score * p.momentum + A.ca.score * p.candles + A.zo.score * p.zones +
      A.li.score * p.liquidity + A.el.score * p.elliott) / tfDiv;
  }
  const sH = tfScore(H), sM = tfScore(Mi), sL = tfScore(L);
  const tfWsum = (p.tfHigh + p.tfMid + p.tfLow) || 1;
  const tfNet = (sH * p.tfHigh + sM * p.tfMid + sL * p.tfLow) / tfWsum;
  // blend tether (cross-TF) + live order book (only when available)
  const baseW = tfDiv;
  const obW = ob.available ? (p.orderbook != null ? p.orderbook : 0.8) : 0;
  const blendDiv = (baseW + p.tether + obW) || 1;
  const net = (tfNet * baseW + td.score * p.tether + ob.score * obW) / blendDiv;

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
    Object.assign({ tf: 'LTF' }, L.pa),
    Object.assign({ tf: 'HTF' }, H.pa),
    Object.assign({ tf: 'HTF' }, H.ms),
    Object.assign({ tf: 'HTF' }, H.zo),
    Object.assign({ tf: 'LTF' }, L.ca),
    Object.assign({ tf: 'MTF' }, Mi.li),
    Object.assign({ tf: 'HTF' }, H.tr),
    Object.assign({ tf: 'MTF' }, Mi.mo),
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
   BACKTEST — dollar-based walk-forward simulator.
   Models: initial capital, % risk per trade (position sizing),
   partial exits at TP1/TP2/TP3, Delta Exchange ETH-futures fees
   (maker/taker + GST on notional), leverage cap, optional
   move-stop-to-breakeven after TP1, and trade style (scalp/day/swing).
   Returns trades + dollar stats + equity curve.
   ============================================================ */

// Delta Exchange ETH perpetual-futures fee defaults (editable via opts).
// Source: Delta support — futures maker 0.02%, taker 0.05%, +18% GST.
const DELTA_FEES = { taker: 0.0005, maker: 0.0002, gst: 0.18 };

// Trade-style presets (max bars held + cooldown bars between trades).
const STYLES = {
  scalp: { fwdMax: 14, cooldown: 1, label: 'Scalp' },
  day:   { fwdMax: 30, cooldown: 2, label: 'Day Trade' },
  swing: { fwdMax: 90, cooldown: 3, label: 'Swing Trade' }
};

function backtest(daily, usdtAligned, params, opts) {
  opts = opts || {};
  const warmup = opts.warmup || 210;
  const htf = opts.htf || 5;
  const mtf = opts.mtf || 2;

  // ----- money-management config -----
  const capital   = opts.capital   != null ? opts.capital   : 10000; // initial $
  const riskPct   = opts.riskPct   != null ? opts.riskPct   : 1.0;    // % equity / trade
  const maxLev     = opts.maxLeverage != null ? opts.maxLeverage : 25; // notional cap
  const beAfterTP1 = opts.beAfterTP1 !== false;                        // default ON
  // TP allocation (% of position closed at each target); auto-normalized.
  let split = opts.tpSplit || [50, 30, 20];
  const sSum = split.reduce((a, b) => a + (isFinite(b) && b > 0 ? b : 0), 0);
  // if the split is empty/zero, default to the full position closing at TP1
  split = sSum > 0 ? split.map(x => (isFinite(x) && x > 0 ? x : 0) / sSum) : [1, 0, 0];
  // fees
  const F = Object.assign({}, DELTA_FEES, opts.fees || {});
  const feeOf = (notional, kind) => notional * (kind === 'maker' ? F.maker : F.taker) * (1 + F.gst);
  // style
  const style = STYLES[opts.style] || STYLES.swing;
  const fwdMax = opts.fwdMax || style.fwdMax;
  const cooldownBars = opts.cooldown != null ? opts.cooldown : style.cooldown;

  const p = Object.assign({}, DEFAULT_W, params || {});
  const trades = [];
  let equity = capital;
  let lastExitIdx = -999;

  for (let i = warmup; i < daily.length - 1; i++) {
    if (i - lastExitIdx < cooldownBars) continue;
    if (equity <= 0) break; // account blown
    const upto = daily.slice(0, i + 1);
    const tfData = { high: resample(upto, htf), mid: resample(upto, mtf), low: upto };
    if (tfData.high.length < 60) continue;
    const us = usdtAligned ? usdtAligned.slice(0, i + 1) : null;
    let sig;
    try { sig = buildSignal(tfData, us, p); } catch (e) { continue; }
    if (sig.side === 'NEUTRAL' || !isFinite(sig.stop)) continue;

    const isLong = sig.side === 'LONG';
    const entry = sig.entry, stop = sig.stop;
    const tps = [sig.t1, sig.t2, sig.t3];
    const stopDist = Math.abs(entry - stop);
    if (stopDist <= 0) continue;

    // ----- position sizing from $ risk, capped by leverage -----
    const riskDollars = equity * (riskPct / 100);
    let qty = riskDollars / stopDist;
    let notional = qty * entry;
    const maxNotional = equity * maxLev;
    if (notional > maxNotional) { qty = maxNotional / entry; notional = qty * entry; }
    if (qty <= 0) continue;

    const entryFee = feeOf(notional, 'taker'); // market entry = taker
    let remaining = qty, curStop = stop, grossPnl = 0, exitFees = entryFee;
    const fills = [];
    let filled = 0; // how many TPs filled
    let closed = false, exitIdx = null;

    const end = Math.min(i + fwdMax, daily.length - 1);
    for (let j = i + 1; j <= end && !closed; j++) {
      const bar = daily[j];
      // 1) stop check first (pessimistic / conservative within-bar ordering)
      const stopHit = isLong ? bar.l <= curStop : bar.h >= curStop;
      if (stopHit) {
        const px = curStop;
        const pnl = isLong ? remaining * (px - entry) : remaining * (entry - px);
        grossPnl += pnl; exitFees += feeOf(remaining * px, 'taker');
        fills.push({ price: px, qty: remaining, reason: curStop === entry ? 'BE-stop' : 'stop' });
        remaining = 0; closed = true; exitIdx = j; break;
      }
      // 2) take-profits in order
      while (filled < 3) {
        const tp = tps[filled];
        const tpHit = isLong ? bar.h >= tp : bar.l <= tp;
        if (!tpHit) break;
        const qtyP = (filled === 2) ? remaining : qty * split[filled]; // last TP closes remainder
        const useQ = Math.min(qtyP, remaining);
        filled++;
        if (useQ > 1e-9) { // only record a real (non-zero) partial fill
          const pnl = isLong ? useQ * (tp - entry) : useQ * (entry - tp);
          grossPnl += pnl; exitFees += feeOf(useQ * tp, 'maker'); // TP = limit = maker
          fills.push({ price: tp, qty: useQ, reason: 'TP' + filled });
          remaining -= useQ;
        }
        if (beAfterTP1 && filled === 1) curStop = entry; // SL → breakeven after TP1
        if (remaining <= 1e-9) { remaining = 0; closed = true; exitIdx = j; break; }
      }
    }
    // 3) time exit for any leftover
    if (!closed) {
      exitIdx = end;
      const px = daily[end].c;
      const pnl = isLong ? remaining * (px - entry) : remaining * (entry - px);
      grossPnl += pnl; exitFees += feeOf(remaining * px, 'taker');
      fills.push({ price: px, qty: remaining, reason: 'time' });
      remaining = 0;
    }

    const pnlAfterFees = grossPnl - exitFees;
    equity += pnlAfterFees;
    const netR = pnlAfterFees / riskDollars;

    trades.push({
      idx: i, date: daily[i].t, side: sig.side, style: style.label,
      entry, stop, t1: tps[0], t2: tps[1], t3: tps[2],
      qty, notional, fees: exitFees, grossPnl, netPnl: pnlAfterFees, netR,
      fills, exitIdx, holdBars: exitIdx - i, tpsFilled: filled,
      equity, conf: sig.confidence,
      result: pnlAfterFees > 0 ? 'WIN' : 'LOSS'
    });
    lastExitIdx = exitIdx;
  }
  return summarize(trades, capital);
}

function summarize(trades, capital) {
  capital = capital != null ? capital : 10000;
  const n = trades.length;
  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  const totalFees = trades.reduce((a, t) => a + t.fees, 0);

  // equity curve in dollars + drawdown
  let eq = capital, peak = capital, maxDD = 0, maxDDpct = 0, cumR = 0;
  const curve = [{ date: trades.length ? trades[0].date - 86400 : 0, equity: capital, dd: 0, ddPct: 0, eqR: 0 }];
  trades.forEach(t => {
    eq = t.equity; cumR += t.netR;
    peak = Math.max(peak, eq);
    const dd = peak - eq, ddPct = peak > 0 ? dd / peak * 100 : 0;
    maxDD = Math.max(maxDD, dd); maxDDpct = Math.max(maxDDpct, ddPct);
    curve.push({ date: t.date, equity: eq, dd, ddPct, eqR: cumR });
  });

  const finalEquity = trades.length ? trades[trades.length - 1].equity : capital;
  const netProfit = finalEquity - capital;
  const returnPct = capital > 0 ? netProfit / capital * 100 : 0;
  const totalR = trades.reduce((a, t) => a + t.netR, 0);

  // CAGR from first→last trade timestamps
  let cagr = 0;
  if (trades.length >= 2) {
    const years = (trades[trades.length - 1].date - trades[0].date) / (365.25 * 86400);
    if (years > 0 && finalEquity > 0) cagr = (Math.pow(finalEquity / capital, 1 / years) - 1) * 100;
  }

  return {
    trades, curve,
    stats: {
      n, wins: wins.length, losses: losses.length,
      winRate: n ? wins.length / n * 100 : 0,
      profitFactor: grossLoss ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
      capital, finalEquity, netProfit, returnPct, cagr,
      totalFees, totalR, expectancyR: n ? totalR / n : 0,
      expectancyDollars: n ? netProfit / n : 0,
      maxDD, maxDDpct,
      avgWin: wins.length ? grossProfit / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      // back-compat alias used by old objective
      expectancy: n ? totalR / n : 0
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
    tether: [0.5, 1.2],
    priceAction: [1.6, 2.2, 3.0] // sweep the price-action emphasis itself
  };
  let best = null, tested = 0;
  const total = grid.threshold.length * grid.slMult.length * grid.t2R.length * grid.tether.length * grid.priceAction.length;
  const results = [];
  for (const threshold of grid.threshold)
    for (const slMult of grid.slMult)
      for (const t2R of grid.t2R)
        for (const tether of grid.tether)
        for (const priceAction of grid.priceAction) {
          const params = { threshold, slMult, t2R, t1R: Math.max(1, t2R - 1), t3R: t2R + 1.5, tether, priceAction };
          const bt = backtest(daily, usdtAligned, params, opts);
          const s = bt.stats;
          // objective: require minimum sample, reward $ return & PF, penalize % drawdown
          let obj = -Infinity;
          if (s.n >= 8) {
            const pf = isFinite(s.profitFactor) ? s.profitFactor : 3;
            obj = (s.returnPct / 100) * Math.sqrt(s.n) * Math.min(pf, 3) / (1 + s.maxDDpct / 100 * 1.5);
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
  M, resample, marketStructure, priceAction, trendEMA, momentum, candles, zones,
  liquidity, orderbook, elliott, tetherDom, analyzeTF, buildSignal, backtest,
  summarize, calibrate, DEFAULT_W, DELTA_FEES, STYLES
};

})(window);
