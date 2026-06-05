# ETH/USDT Signal Engine

A self-contained browser app that pulls **live ETH/USDT data**, runs a deep
multi-factor analysis, generates a trade signal (entry / stop / 3 targets), and
**backtests + auto-calibrates** the strategy over real historical data.

## Run the app
Open **`index.html`** in any modern browser with internet access.
No build step, no server. (The in-app preview sandbox blocks external scripts,
so the TradingView chart and live fetches only work in a real browser tab.)

1. Pick a **data source** (Binance.US · Delta Exchange · Coinbase) and a
   **timeframe profile** (Swing 1D · Intraday 4H · Scalp 1H). Optionally tick
   **PA-only** to mute EMA/RSI/MACD, Elliott, Tether & order-book and drive the
   signal purely from price action.
2. Click **⟳ Run Analysis** — fetches candles, Tether dominance, and a live
   order-book snapshot, then renders the signal + all analysis modules,
   including the **Price-Action Map** (own candlestick canvas with FVGs, order
   blocks, swing highs/lows, premium/discount band and live trade levels drawn
   directly on the chart).
3. Set your **money-management** inputs (initial capital, % risk per trade,
   leverage cap, trade style, TP1/2/3 split, SL→breakeven, Delta fees), then
   click **⚙ Run Backtest & Calibrate** — walks the strategy forward over the
   loaded history, sweeps 108 parameter sets, and applies the best to the live
   signal.

### Dollar-based backtest
The simulator models a real account:
- **Initial capital** and fixed **% risk per trade** → position size (qty) is
  derived from the stop distance, capped by **max leverage**.
- **Partial exits** at TP1/TP2/TP3 with a configurable close-% split; remainder
  closes at the final TP, stop, or a time-based exit per the trade style.
- Optional **move stop-loss to breakeven** after TP1.
- Real **Delta Exchange ETH-futures fees** — maker 0.02% / taker 0.05% + 18% GST
  (editable). Entry/stop/time exits = taker; TP limit fills = maker.
- **Trade style** sets the max holding window & cooldown:
  Scalp (≤14 bars), Day (≤30), Swing (≤90).
- Outputs: final equity, net profit, return %, CAGR, win rate, profit factor,
  max drawdown (% and $), total fees paid, expectancy ($ and R), equity curve,
  and a per-trade log (qty, TPs hit, exit reason, fees, net P&L, running equity).

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

## Analysis modules (PRICE-ACTION-weighted multi-timeframe confluence)
The engine is deliberately **price-action led**. Highest-weighted layers:
- **Price Action (w 2.2)** — fair-value gaps (imbalances), liquidity sweeps /
  stop-runs, premium/discount within the dealing range (trend-aware), order
  blocks, rejection wicks.
- **Market Structure (w 2.0)** — BOS (continuation) + **CHoCH** (early reversal)
  + displacement detection.
- **Supply & Demand (w 1.6)** and **Candlestick patterns (w 1.3)**.

Confirming-only (down-weighted): EMA trend stack (0.7), RSI+MACD momentum (0.6),
Elliott wave (0.5). Plus liquidity heat map, live order-book, and Tether
dominance. The price-action weight itself is a calibration dimension.

Legacy module list: Market structure (BOS) · EMA trend stack · RSI+MACD momentum · candlestick
patterns · supply/demand zones · volume-by-price liquidity · **live order-book
liquidity & walls** · simplified Elliott wave · Tether-dominance inverse.

## Tests
```bash
npm test            # unit tests + live API integration (needs internet)
npm run test:offline   # unit tests only, no network
```
Exit code is non-zero if any assertion fails (CI-friendly).
Current suite: **109 checks** (94 offline unit + 15 live integration),
including price-action module (FVG/sweep/premium-discount), CHoCH structure,
dollar-model position sizing, leverage cap, fee scaling and partial exits.

## Disclaimer
Educational/analytical tool only. **Not financial advice.** Backtested results
are hypothetical and not indicative of future performance. Trade at your own risk.
