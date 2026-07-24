# Start Here

This repository contains live and paper-trading services, research tools, dashboards, deployment scripts, generated data, and historical backups. Treat changes as safety-critical: a small routing, sizing, authentication, or process-management change can place or alter orders.

## Before making a change

1. Read [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DEPLOYMENT.md](DEPLOYMENT.md), and [CODING_STANDARDS.md](CODING_STANDARDS.md).
2. Confirm whether the target is production, paper/demo, research, or an obsolete backup. File location alone is not yet a reliable boundary.
3. Work on a branch. Do not develop directly on `main` or on the trading VPS.
4. Keep credentials, logs, state, datasets, and generated reports out of commits.
5. For trading-path changes, require tests or a dry-run/paper validation and a human review before deployment.
6. Never deploy automatically from an AI-generated pull request. The owner approves merges and production deployments.

## Current source-of-truth map

The classifications below are inferred from code comments and deployment scripts. Verify them against the live PM2 configuration before changing process topology.

| Area | Current files | Classification |
| --- | --- | --- |
| IBKR options webhook | `server.js`, `fly_exec.js`, related execution helpers | Production |
| Tradovate futures executor | `tradovate_webhook.js`, `dashboard/` | Production, configured for Tradovate demo endpoints in the current source |
| Legacy/dedicated IBKR futures webhook | `futures_webhook.js` | Production or retained operational service; verify live PM2 state |
| Futures signal generation | `vwap_signal_sender.py` | Production candidate/production companion; verify live PM2 state |
| Safety and monitoring | `watchdog.py`, `health_digest.js`, `scripts/healthcheck.sh` | Operational production support |
| Shadow/options research | `shadow_engine.py`, `signal_backtest.py` | Research/shadow |
| Order-flow logger | `cvd_logger.js` | Read-only research service |
| Options and futures research | Most other root-level Python scripts, CSV/Parquet data, `calibration_quotes/`, `outcome_quotes/` | Research/generated data |
| Historical material | `*.bak*`, `*.backup*`, `*.before_*`, `tw_part_*`, patch scripts | Backup/migration residue; not authoritative |

## Safe workflow

```text
Issue or approved task
  -> branch
  -> implementation and tests
  -> pull request
  -> owner review
  -> merge to main
  -> owner-approved VPS deployment
  -> health check and broker reconciliation
```

## Quick repository checks

Before opening a pull request:

```bash
git status --short
git diff --check
git diff --stat origin/main...
```

There is currently no unified test command, lint command, CI workflow, or PM2 ecosystem file. Adding those is a high-priority roadmap item.

## If uncertain

Stop and ask before changing:

- order placement, exits, sizing, account selection, or symbol routing;
- API authentication or webhook authorization;
- default ports or cross-service URLs;
- PM2, cron, deployment, or rollback behavior;
- strategy parameters described as matching a backtest;
- persisted position, reconciliation, or safety-lock state.

