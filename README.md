# ETH/USDT Signal Engine

A self-contained browser app that pulls **live ETH/USDT data**, runs a deep
multi-factor analysis, generates a trade signal (entry / stop / 3 targets), and
**backtests + auto-calibrates** the strategy over real historical data.

## Run the app
Open **`index.html`** in any modern browser with internet access.
No build step, no server. (The in-app preview sandbox blocks external scripts,
so the TradingView chart and live fetches only work in a real browser tab.)

1. Pick a **data source** (Binance.US · Delta Exchange · Coinbase) and a
   **timeframe profile** (Swing 1D · Intraday 4H · Scalp 1H).
2. Click **⟳ Run Analysis** — fetches candles, Tether dominance, and a live
   order-book snapshot, then renders the signal + all analysis modules.
3. Click **⚙ Run Backtest & Calibrate** — walks the strategy forward over the
   loaded history, sweeps 108 parameter sets, and applies the best to the live
   signal.

## Files
| File | Purpose |
|------|---------|
| `index.html` | UI, layout, styling |
| `engine.js`  | Pure analytics core (indicators, modules, signal, backtest, calibrate). Framework-free, Node-testable. |
| `app.js`     | Data fetching, rendering, orchestration, TradingView widget |
| `test.js`    | Unit + live-integration test harness |

## Data sources (all CORS-enabled, no API key)
- **Binance.US** — `ETHUSDT` klines (1d/4h/1h) + L2 order book (`/depth`)
- **Delta Exchange** — `ETHUSDT` candles + L2 order book (`/l2orderbook`)
- **Coinbase** — `ETH-USD` candles + L2 book (fallback)
- **CoinGecko** — USDT dominance (`/global`) + history (`/market_chart`)

The app tries your chosen source first and **auto-falls back** to the others.

## Analysis modules (weighted multi-timeframe confluence)
Market structure (BOS) · EMA trend stack · RSI+MACD momentum · candlestick
patterns · supply/demand zones · volume-by-price liquidity · **live order-book
liquidity & walls** · simplified Elliott wave · Tether-dominance inverse.

## Tests
```bash
npm test            # unit tests + live API integration (needs internet)
npm run test:offline   # unit tests only, no network
```
Exit code is non-zero if any assertion fails (CI-friendly).
Current suite: **76 checks** (61 offline unit + 15 live integration).

## Disclaimer
Educational/analytical tool only. **Not financial advice.** Backtested results
are hypothetical and not indicative of future performance. Trade at your own risk.
