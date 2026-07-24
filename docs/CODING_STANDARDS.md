# Coding Standards

## Safety first

1. Treat order placement, exits, sizing, account selection, routing, authentication, reconciliation, and persisted state as safety-critical.
2. Never change production trading logic in a documentation, cleanup, formatting, or dependency pull request.
3. Preserve paper/demo and dry-run paths. Test there before requesting production approval.
4. Do not silently change defaults. Prefer explicit configuration and fail closed for secrets, accounts, or ambiguous symbols.
5. Do not add a new execution path when an existing boundary can be extended safely.

## Change discipline

- One concern per branch and pull request.
- Explain intent, affected services, risks, validation, rollback, and whether trading logic changed.
- Keep production behavior changes separate from repository cleanup and research work.
- Never edit timestamped backups as if they were source.
- Do not commit generated data, runtime state, logs, credentials, dependency directories, or deployment snapshots.
- Add an entry to `docs/CHANGELOG_AI.md` for material AI-assisted changes.

## JavaScript

- Use strict mode in service modules.
- Validate and normalize every inbound webhook field.
- Bound numeric values and reject non-finite input.
- Use constant-time comparison or an established authentication library for secrets where applicable.
- Avoid shell interpolation with external or environment-controlled values.
- Keep broker side effects behind small, testable functions.
- Log structured events without credentials, tokens, full account identifiers, or sensitive payloads.
- Handle broker disconnects, duplicate signals, retries, and partial fills explicitly.

## Python

- Add type hints to new interfaces and safety-critical helpers.
- Separate pure strategy calculations from I/O, scheduling, broker calls, and signal delivery.
- Pin dependencies in a reviewed project manifest.
- Use timezone-aware datetimes and name the market timezone explicitly.
- Preserve backtest/live parity with shared code or contract tests; do not copy strategy constants between implementations without verification.

## Tests

Every trading-path change should include broker-free tests for relevant behavior:

- payload validation and authentication;
- symbol/action normalization;
- sizing and maximum limits;
- duplicate and stale-signal handling;
- target-position delta calculations;
- pause, entry-disable, and safety-lock behavior;
- reconciliation mismatches;
- restart/state recovery;
- timeout, disconnect, retry, and partial-fill cases;
- strategy parity where a production parameter claims to match a backtest.

External broker tests must use demo/paper accounts and require an explicit opt-in flag.

## Configuration

- Add new settings to a redacted `.env.example` and documentation.
- State units in names or comments: seconds, minutes, points, percent, contracts, and timezone.
- Do not use real account IDs as source defaults.
- Production should fail safely when a required credential or account is absent.
- Document every port and cross-service URL.

## Review gates

A pull request touching trading behavior must answer:

- Can this place, cancel, resize, reroute, or alter an order?
- Does it affect an open-position exit or risk limit?
- What happens on duplicate delivery, restart, or broker disconnect?
- Which account and environment were used for validation?
- How is it rolled back?
- What observable evidence confirms success?

Human approval is required before merge and again before production deployment.

