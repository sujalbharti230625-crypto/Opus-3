# feat: ETH/USDT Signal Engine — live data, intraday TFs, order-book liquidity, backtest & auto-calibration

## Summary
Adds a self-contained, browser-based **ETH/USDT trade-signal engine** with deep
multi-factor analysis, live market data, a 2-year walk-forward backtest, and
parameter auto-calibration. No build step, no server, no API keys.

## What's included
- **Multi-factor confluence engine** across HTF/MTF/LTF:
  market structure (BOS), EMA trend stack, RSI + MACD momentum, candlestick
  patterns, supply/demand zones, volume-by-price liquidity, **live order-book
  liquidity/walls**, simplified Elliott wave, and Tether-dominance inverse.
- **Live data** from Binance.US / Delta Exchange / Coinbase (candles + L2 order
  book) and CoinGecko (USDT dominance), with **automatic source fallback**.
- **Timeframe profiles:** Swing (1D), Intraday (4H), Scalp (1H).
- **Signal output:** side, confidence, entry, stop-loss, and 3 R-based targets.
- **Backtest + auto-calibration:** walk-forward over ~2 years, sweeps a 108-cell
  parameter grid, applies the best set to the live signal. KPIs, equity curve,
  and trade log included.
- **TradingView** chart widget (symbol/interval follow the active source & profile).

## Testing
- Test harness `test.js`: **76 checks** — 61 offline unit + 15 live integration.
- Throttle/network-resilient (rate limits = skip, not fail). CI-friendly exit code.

```bash
npm test            # unit + live integration (needs internet)
npm run test:offline   # unit only, no network
```

## Files
| File | Purpose |
|------|---------|
| `index.html` | UI, layout, styling |
| `engine.js`  | Pure analytics core (indicators, modules, signal, backtest, calibrate) |
| `app.js`     | Data fetching, rendering, orchestration, TradingView widget |
| `test.js`    | Unit + live-integration test harness |
| `README.md`  | Usage & docs |
| `package.json` | npm test scripts |

## Notes / limitations
- The order-book module is **live-only** and intentionally excluded from the
  historical backtest (no historical L2 data).
- Educational/analytical tool — **not financial advice**. Backtested results are
  hypothetical and not indicative of future performance.

## Checklist
- [x] Code committed on a clean feature branch
- [x] Tests pass (76/76)
- [x] No secrets/keys committed
- [x] `.gitignore` added
