# Project Context

## Purpose

`zacamos1/tradovate-webhook` is an automated trading platform rather than a single webhook. It combines:

- an IBKR options execution service;
- futures execution through Tradovate and, historically or additionally, IBKR;
- VWAP-based futures signal generation;
- broker reconciliation, safety controls, health checks, dashboards, and notifications;
- options, futures, and order-flow research;
- scripts for deploying and operating the system on a Linux VPS.

GitHub is intended to be the source of truth. Human ownership covers architecture, strategy logic, research direction, review, debugging, merges, and production deployment. Coding agents may implement approved work, tests, documentation, and pull requests, but must not approve their own production changes.

## Operating assumptions inferred from the repository

- The deployment directory is `/root/ibkr-webhook` on a Linux VPS.
- Node.js and Python services run under PM2.
- IBKR Gateway/TWS is reachable locally, commonly on port `4002`; `server.js` has a separate historical default of `7496`.
- The options webhook defaults to HTTP port `3000`.
- The dedicated IBKR futures webhook defaults to port `3001`.
- The Tradovate executor defaults to port `3002`.
- `vwap_signal_sender.py` defaults to `http://localhost:3002/signal`.
- Secrets and runtime configuration are loaded from `.env` or process environment variables.
- Notifications use ntfy when `NTFY_TOPIC` is configured.
- `scripts/deploy.sh` deploys `origin/main` with a fast-forward-only pull, then restarts known PM2 services and runs a health check.

These are repository observations, not a guarantee of current VPS state. PM2 and cron configuration are not committed declaratively.

## Trading domains

### IBKR options

`server.js` receives TradingView-style webhooks and connects to IBKR through `@stoqey/ib`. It contains option selection, order placement, bracket/exit behavior, position tracking, reconnect handling, dashboards, health reporting, and gated test-fly execution.

### Tradovate futures

`tradovate_webhook.js` receives futures signals, uses Tradovate REST and WebSocket APIs, persists operational state, exposes a dashboard/status surface, performs reconciliation, and applies safety controls. The committed configuration points to Tradovate demo API endpoints. Deployment configuration must be reviewed before any live-account assumption is made.

### Futures signals

`vwap_signal_sender.py` pulls IBKR futures bars, evaluates VWAP reclaim/rejection conditions, and sends signals to the Tradovate service. Several parameters are labeled as needing to match backtest behavior; changes therefore require research parity checks.

### Research

The repository includes backtests, fidelity comparisons, calibration scripts, quote pulls, signal reconstruction, shadow engines, and large market-data/result collections. Research dependencies are not captured in a Python lockfile or project manifest.

## External systems

- GitHub for version control and review
- IBKR Gateway/TWS and IBKR market data
- Tradovate REST and WebSocket APIs
- TradingView webhooks/signals
- PM2 for process supervision
- ntfy for notifications
- ngrok for inbound connectivity
- Databento and Yahoo Finance in research paths

## Known gaps

- No root README, automated test suite, CI workflow, or unified development command.
- No committed PM2 ecosystem file or canonical cron manifest.
- Production, research, generated artifacts, and backups share the repository root.
- Python dependencies and runtime versions are not declared.
- The repository contains multiple apparent generations of the same trading services.

