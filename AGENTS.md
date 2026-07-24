# Repository Agent Guidance

This repository is an active production trading platform under continuous development. Production stability comes first.

## Required context

Before making changes, read:

1. `docs/START_HERE.md`
2. `docs/PROJECT_CONTEXT.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DEPLOYMENT.md`
5. `docs/CODING_STANDARDS.md`
6. `docs/ROADMAP.md`
7. `docs/CHANGELOG_AI.md`

If repository behavior conflicts with the documentation, treat the code and verified deployment state as evidence, document the discrepancy, and ask the project owner before changing safety-critical behavior.

## Agent role

The agent may:

- investigate and explain the repository;
- implement explicitly approved changes;
- add and run broker-free tests;
- improve documentation;
- refactor when behavior preservation is demonstrated;
- create branches, commits, and pull requests;
- build isolated research tooling.

The agent must not:

- redesign architecture without project-owner approval;
- modify production trading logic unless explicitly instructed;
- merge directly into `main`;
- deploy or restart production services without explicit approval;
- expose, copy, or commit credentials;
- connect tests or research defaults to live broker execution;
- treat backup, generated, or runtime files as authoritative source.

## Project boundaries

The repository contains several distinct systems:

1. Futures automated trading
   - VWAP reclaim/rejection research and signals
   - TradingView alerts
   - webhook validation
   - Tradovate and IBKR execution paths
2. Directional options automation
   - entries and exits
   - dashboards and reporting
   - IBKR connectivity
3. Quantitative research
   - Databento and other historical data
   - replay and simulation
   - feature engineering and trade labeling
   - walk-forward validation and optimization
   - machine-learning experiments

Research and production must remain separated. New research pipelines must default to offline or paper-only behavior and live under a clearly named research boundary. Promotion to production requires a separate architectural decision, validation evidence, and explicit approval.

## Development principles

- Evidence beats opinions.
- Research drives production; research code does not silently become production code.
- Documentation is part of the change.
- Prefer reproducible automation over one-off manual procedures.
- Every significant change goes through a pull request.
- Record material AI-assisted work in `docs/CHANGELOG_AI.md`.
- If uncertain, document the uncertainty instead of guessing.

## Safe change workflow

1. Confirm the requested outcome and whether trading behavior is in scope.
2. Inspect the relevant production, research, runtime, and historical files.
3. Create a dedicated branch from current `main`.
4. Keep production, research, cleanup, and documentation concerns in separate pull requests.
5. Add tests or reproducible validation proportional to risk.
6. Review the diff for credentials, generated artifacts, and unintended trading changes.
7. Commit and open a pull request with:
   - purpose and scope;
   - affected services;
   - trading-logic impact;
   - validation evidence;
   - risks and rollback;
   - deployment requirements.
8. Leave merge and production deployment to the project owner.

## Safety-critical changes

Explicit approval is required before changing:

- order placement, cancellation, exits, sizing, or routing;
- account, environment, or broker selection;
- webhook authentication or authorization;
- risk limits, strategy parameters, or live signal rules;
- reconciliation, persisted position state, or safety locks;
- PM2, cron, deployment, rollback, or production environment behavior.

For those changes, verify duplicate delivery, stale signals, restarts, disconnects, partial fills, market-session timing, and rollback behavior.

## Research requirements

Research work must:

- state the instrument universe, session, timezone, and data schema;
- prevent look-ahead and survivorship leakage;
- separate train, validation, and held-out test periods chronologically;
- use realistic commissions, spread, slippage, latency, and fill assumptions;
- report trade count, expectancy, drawdown, stability, and sensitivity;
- preserve configuration and random seeds;
- write generated results to ignored output locations;
- produce paper-only signals unless live execution is explicitly approved.
