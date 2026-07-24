# AI Change Log

This file records material repository work performed with an AI coding agent. It is not a substitute for Git history, pull-request review, or deployment records.

## 2026-07-24 — Durable repository agent guidance

### Scope

- Added root `AGENTS.md`.
- Captured project-owner approval boundaries, production/research separation, pull-request workflow, safety-critical change gates, and quantitative-research requirements.
- Linked future agents to the onboarding documentation before they make changes.

### Safety

- Documentation only.
- No production code, trading logic, configuration, runtime state, or deployment behavior was changed.

## 2026-07-24 — Repository onboarding documentation

### Scope

- Added the initial documentation set:
  - `START_HERE.md`
  - `PROJECT_CONTEXT.md`
  - `ARCHITECTURE.md`
  - `DEPLOYMENT.md`
  - `CODING_STANDARDS.md`
  - `ROADMAP.md`
  - `CHANGELOG_AI.md`
- Audited production and research code, runtime artifacts, backups, duplicates, ignore rules, deployment scripts, and PM2 references.

### Evidence reviewed

- Git-tracked file inventory and recent history
- Node package manifests
- `.gitignore`
- production service entry points and route/listener definitions
- research and monitoring script headers
- deployment, backup, health-check, and rollback scripts
- PM2 names referenced throughout the repository
- file sizes and exact-content duplicate hashes

### Safety

- Documentation only.
- No production trading logic, strategy parameters, deployment scripts, environment files, or runtime artifacts were changed.
- No credentials were opened or reproduced.
- No deployment was performed.

### Follow-up

The highest-priority actions are credential rotation/history remediation, capture of authoritative VPS process configuration, and separation of source code from tracked dependencies, datasets, runtime artifacts, and backups.
