# Deployment

## Current workflow

The repository supplies four operational scripts:

- `scripts/backup.sh` creates a timestamped tar snapshot in `~/server-snapshots`.
- `scripts/deploy.sh` verifies that tracked files are clean, creates a snapshot, fetches and fast-forwards to `origin/main`, conditionally runs `npm ci`, restarts known PM2 services, saves PM2 state, and runs the health check.
- `scripts/healthcheck.sh` checks required PM2 process names, disk, memory, branch, commit, and working-tree state.
- `scripts/rollback.sh` snapshots, hard-resets to a requested Git revision, reinstalls Node dependencies, restarts services, and runs the health check.

Deployment is therefore pull-based from the VPS. There is no GitHub Actions workflow in the repository.

## PM2 services

The deployment scripts restart:

| PM2 name | Inferred implementation | Role |
| --- | --- | --- |
| `ibkr-webhook` | `server.js` | IBKR options webhook |
| `tradovate-webhook` | `tradovate_webhook.js` | Tradovate futures executor |
| `watchdog` | `watchdog.py` | Monitoring/self-healing |
| `shadow-engine` | `shadow_engine.py --loop` | Non-trading research/shadow signals |
| `cvd-of` | `cvd_logger.js` | Read-only order-flow collection |

The health check also requires `ngrok`, but deployment does not restart it.

Other names appear in comments or operational scripts, including `futures-webhook`, `vwap-sender`, and `fly-autotest`. Because there is no committed ecosystem file, the authoritative process commands, interpreters, environment, working directories, restart policies, and log settings must be exported from the VPS.

## Recommended production procedure

Only the owner or an explicitly authorized operator should deploy.

1. Review and merge an approved pull request to `main`.
2. Confirm the market/session state and whether a restart can safely interrupt work.
3. On the VPS, confirm broker connectivity and reconcile open positions.
4. Confirm the repository is on the expected branch and has no unexplained changes.
5. Run:

   ```bash
   cd /root/ibkr-webhook
   ./scripts/deploy.sh
   ```

6. Inspect PM2 status and logs.
7. Verify `/health` and Tradovate health/status endpoints.
8. Reconcile application state against broker positions.
9. Verify notifications and inbound webhook reachability.
10. Record the deployed commit and result.

Do not deploy a documentation-only pull request during an active trading window solely to make the files available on the VPS.

## Rollback

`scripts/rollback.sh <revision>` is destructive to the VPS working tree because it uses `git reset --hard`. Use it only with an explicit, verified revision and after confirming that runtime state or uncommitted emergency changes will not be lost. The script creates a snapshot first, but its archive is not a substitute for broker reconciliation.

After rollback:

- confirm the checked-out commit;
- confirm dependency installation succeeded;
- inspect every required PM2 service;
- reconcile broker and local positions;
- verify ports, webhooks, and safety locks.

## Environment and secrets

The code references broker credentials, account identifiers, webhook/admin tokens, ports, sizing controls, risk limits, feature flags, notification configuration, and state/reconciliation intervals.

Rules:

- Keep `.env` out of Git.
- Maintain a redacted `.env.example` containing names and safe descriptions only.
- Store production secrets in a dedicated secret manager or tightly permissioned VPS environment file.
- Rotate any credential that has ever been committed, including credentials in historical Git objects.
- Never paste secret values into issues, pull requests, logs, AI prompts, or dashboards.

## Missing deployment artifacts

Create and review:

- a PM2 `ecosystem.config.cjs` with no secrets;
- a versioned cron/systemd-timer manifest or documented scheduler inventory;
- a runtime/version manifest for Node and Python;
- a redacted `.env.example`;
- endpoint smoke tests and a broker-free CI suite;
- a deployment checklist that records approvals and deployed revisions.

