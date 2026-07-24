# Architecture

## High-level flow

```text
TradingView / internal signal generators
        |
        +--> IBKR options HTTP service (`server.js`, :3000)
        |        |
        |        +--> IBKR Gateway/TWS --> option orders and exits
        |
        +--> legacy/dedicated IBKR futures service (`futures_webhook.js`, :3001)
        |        |
        |        +--> IBKR Gateway --> futures target-position orders
        |
        +--> VWAP sender (`vwap_signal_sender.py`)
                 |
                 +--> Tradovate executor (`tradovate_webhook.js`, :3002)
                           |
                           +--> Tradovate REST/WebSocket
                           +--> state/*.json
                           +--> tradovate_log.jsonl
                           +--> dashboard/

PM2 supervises services.
`watchdog.py`, health scripts, dashboards, logs, and ntfy provide operations support.
```

## Production and operational components

### `server.js`: IBKR options webhook

- Express service on `WEBHOOK_PORT` (default `3000`).
- Connects to TWS/IBKR through `@stoqey/ib`.
- Main routes include `/webhook`, `/futures`, `/tradovate`, `/dashboard`, `/futures-status`, `/health`, and a gated `/place_test_fly`.
- Uses environment-controlled exits, trailing behavior, time stops, account selection, and order parameters.
- Writes trading and MFE logs in the working directory.
- Imports `fly_exec.js`; other root-level JavaScript helpers support operational repair, position cleanup, and reporting.

The presence of `/futures` and `/tradovate` routes alongside dedicated services indicates historical evolution. Do not assume every route remains part of the intended production path.

### `tradovate_webhook.js`: Tradovate executor

- HTTP server on `TRADOVATE_PORT` (default `3002`).
- Receives signal requests and interacts with Tradovate REST and WebSocket APIs.
- Current source uses Tradovate demo endpoints.
- Maintains positions, runtime state, reconciliation state, daily limits, deduplication, pause/entry controls, and a safety lock.
- Writes JSONL logs and atomic JSON state under `state/`.
- Serves assets from `dashboard/`.
- Comments describe TradingView-managed exits as the current production architecture, with a feature flag for legacy server-side management.

### `futures_webhook.js`: dedicated IBKR futures executor

- HTTP service on `PORT` (default `3001`).
- Connects to IBKR on `IB_PORT` (default `4002`).
- Treats signals as desired target positions and calculates order deltas for idempotency.
- Supports a webhook secret, account selection, dry-run mode, contract-roll buffer, and JSONL logging.
- Its code comments identify it as paper-first. Confirm whether it is active or legacy before modifying it.

### `vwap_signal_sender.py`: futures signal generator

- Pulls live bars from IBKR.
- Evaluates VWAP reclaim/rejection signals on completed bars.
- Sends approved signals to the Tradovate executor.
- Writes JSONL signal logs.
- Has loop, once, and dry-run modes.

## Research and shadow components

- `signal_backtest.py`: options signal backtesting and TradingView fidelity work.
- `shadow_engine.py`: reuses the backtest engine to emit non-trading shadow signals.
- `cvd_logger.js`: read-only MES order-flow logger.
- `calibrate_live_replay.py`, `compare_*`, `outcome_*`, `reentry_analysis.py`, `signal_reconstruction.py`, and `*_pull.py`: data acquisition, calibration, and analysis.
- CSV, Parquet, JSON, HTML, `calibration_quotes/`, and `outcome_quotes/`: mostly generated inputs/results rather than source code.

## Persistence

Runtime persistence is file-based:

- JSONL event and trade logs in the repository working directory;
- Tradovate JSON state under `state/`;
- generated dashboards in dashboard directories;
- PM2 logs under the PM2 home;
- backup snapshots under `~/server-snapshots`.

This makes the process working directory significant. Deployments and service definitions must preserve it.

## Service boundaries and ports

| Service | Default port | Upstream/downstream |
| --- | ---: | --- |
| IBKR options webhook | 3000 | TradingView/inbound HTTP -> IBKR |
| IBKR futures webhook | 3001 | TradingView/inbound HTTP -> IBKR |
| Tradovate executor | 3002 | VWAP sender/inbound HTTP -> Tradovate |
| IBKR Gateway | 4002 commonly; `server.js` defaults to 7496 | Local broker connection |

Default values are not an environment contract. Capture the actual VPS configuration before consolidation.

## Architectural risks

- Multiple overlapping executors and routes make ownership ambiguous.
- Runtime state is colocated with source and depends on process working directory.
- Strategy parameters live directly in production files.
- PM2 and cron topology cannot be reproduced solely from Git.
- No automated contract tests cover webhook payloads, authentication, idempotency, reconciliation, or safety locks.

