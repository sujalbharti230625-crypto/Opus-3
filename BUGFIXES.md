# Bug-fix log

## Round 4 — pre-release audit
Systematic audit (syntax, DOM-reference cross-check, edge-case fuzzing,
browser-load simulation, full test suite). Bugs found & fixed:

1. **Division-by-zero → `NaN` signal.** If a parameter combination zeroed every
   module weight (e.g. `paOnly` + a calibrated set with `priceAction:0`), the
   confluence divisor became 0 and `net` was `NaN`, producing fragile/unstable
   output. **Fix:** guard all weight divisors (`tfDiv`, `tfWsum`, `blendDiv`)
   with a `|| 1` / positive fallback. All-zero weights now yield a clean
   `net = 0 → NEUTRAL`.

2. **Zero-quantity TP fills logged.** A `tpSplit` of `[0,0,0]` (or partial
   zeros) produced phantom `TP1:0.000` fills in the trade log. **Fix:** an
   empty/zero split now defaults to closing the full position at TP1, and the
   TP loop only records non-zero partial fills.

3. **Negative dollars rendered as `$-1,234.50`.** The `usd()` formatter put the
   minus sign after the `$`. **Fix:** sign now precedes the symbol
   (`-$1,234.50`); verified no double-sign with the existing `+`/`-` prefixes.

4. **Timeframe dropdown labels didn't match the engine.** The HTML showed
   `Intraday (1D·4H·1H)` / `Scalp (4H·1H·15m)` but the engine actually resamples
   to `1D·8H·4H` and `4H·2H·1H`. **Fix:** labels synced to the real profile
   config.

### Verified clean (no fix needed)
- No DOM IDs referenced in JS are missing from HTML (`cprog` is created
  dynamically during calibration).
- No top-level ReferenceErrors when `app.js` loads (browser-scope simulation).
- 9 fuzz edge cases (zero capital, 200% risk, zero fees, tiny datasets, flat
  candles, `paOnly`, tiny calibrate) — no crashes, all outputs finite.
- Engine data contracts (FVG/order-block timestamps, range fields) intact.
- Test suite: **109/109 passing** (94 offline unit + 15 live integration).
