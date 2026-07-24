# Roadmap

This roadmap prioritizes reproducibility and trading safety over feature expansion.

## Phase 0: Immediate security and repository hygiene

- [ ] Rotate any credentials present in the tracked `.env.backup.20260713_160820`; remove the file from the current tree and purge sensitive history with an owner-approved procedure.
- [ ] Export and review the live PM2 process list, commands, working directories, environment names, and restart policies.
- [ ] Export and review cron jobs and any systemd/ngrok configuration.
- [ ] Tag the verified production revision and record which services use which files.
- [ ] Confirm whether `futures_webhook.js`, the `/futures` and `/tradovate` routes in `server.js`, and `vwap_signal_sender.py` are active, legacy, or transitional.

## Phase 1: Reproducible baseline

- [ ] Add a root README that links to `docs/START_HERE.md`.
- [ ] Add a redacted `.env.example`.
- [ ] Add a PM2 ecosystem file with no secrets.
- [ ] Declare Node and Python versions.
- [ ] Add a Python dependency manifest and lock strategy.
- [ ] Add standard `npm` scripts for validation and tests.
- [ ] Capture the deployment and rollback approval checklist.

## Phase 2: Repository cleanup

Perform cleanup in dedicated, reviewed pull requests; do not mix it with trading changes.

- [ ] Move production services into a clear application directory.
- [ ] Move research code into `research/`.
- [ ] Move maintained operations tools into `ops/`.
- [ ] Move tests into language-specific test directories.
- [ ] Remove tracked `node_modules/` and rely on `package-lock.json` plus `npm ci`.
- [ ] Remove or externally archive tracked Parquet, CSV, quote directories, ZIP files, logs, and generated dashboards.
- [ ] Remove obsolete `*.bak*`, `*.backup*`, `*.before_*`, split fragments, and superseded patch scripts after owner review.
- [ ] Resolve exact duplicate files and document the canonical version.

### Recommended `.gitignore` additions/refinements

The current rules cover many artifact patterns but cannot untrack files already committed. After removing tracked artifacts, consider:

```gitignore
state/
*.jsonl
*.parquet
*.csv
*.zip
*.patch
*.bak*
*.backup*
*.before_*
calibration_quotes/
outcome_quotes/
dashboards/
directional_dashboards/
coverage/
.pytest_cache/
.mypy_cache/
.ruff_cache/
```

Use exceptions for intentionally versioned fixtures or static dashboard source. Consolidate the repeated `.env`, backup, log, and dashboard sections in the current `.gitignore`.

## Phase 3: Test and CI safety net

- [ ] Add schema/contract tests for every webhook.
- [ ] Add unit tests around order intent, sizing, idempotency, risk limits, and reconciliation.
- [ ] Add persisted-state restart tests.
- [ ] Add backtest/live strategy parity tests.
- [ ] Add secret scanning, dependency review, formatting, linting, and tests in CI.
- [ ] Prevent CI and local default test commands from connecting to brokers or placing orders.

## Phase 4: Architecture consolidation

- [ ] Define one canonical ingress and execution path per asset class and broker.
- [ ] Separate strategy, signal transport, execution, reconciliation, and presentation layers.
- [ ] Replace hard-coded account identifiers and environment-specific paths.
- [ ] Centralize typed configuration and validation.
- [ ] Move runtime data outside the Git checkout.
- [ ] Add durable, versioned state with explicit recovery semantics.
- [ ] Replace shell-built notification commands with safe HTTP clients.

## Phase 5: Operations and observability

- [ ] Add structured health/readiness checks per service.
- [ ] Monitor broker connectivity, stale data, rejected orders, reconciliation mismatches, and disabled safety controls.
- [ ] Track deployed commit and configuration version.
- [ ] Test backups and disaster recovery.
- [ ] Create market-session-aware maintenance and deployment windows.
- [ ] Add an incident runbook and kill-switch procedure.

## Audit inventory

At the time of this documentation audit, Git tracked approximately:

- 5,447 files and 170 MB;
- 3,589 files under `node_modules/`;
- 1,617 Parquet files;
- 23 CSV files;
- 47 backup-like files;
- one environment backup file.

Examples of exact duplicates include:

- `futures_webhook.js` and its timestamped backup;
- `tradovate_webhook.b0d8181.js` and a timestamped Tradovate backup;
- two `before_remove_tv_secret` Tradovate backups;
- multiple pairs/groups of `server.js` backups;
- duplicated generated CSV outputs.

These counts describe tracked content, not necessarily the live deployment.

