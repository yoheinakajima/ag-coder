# Contributing to AG Code Agent

Thanks for your interest in contributing! This document covers how to get set up,
the conventions the codebase follows, and the contract-first workflow you'll need
when changing the API.

## Prerequisites

- Node.js 24+ and [pnpm](https://pnpm.io/)
- Python 3 with `psycopg2` and `activegraph` available on the path (used by the agent subprocess)
- A PostgreSQL database

## Getting started

```bash
pnpm install
cp .env.example .env          # fill in DATABASE_URL and (optionally) an LLM key
pnpm --filter @workspace/db run push
```

Then run the two services in separate terminals:

```bash
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/ag-code-agent run dev
```

If you don't set an LLM key, the agent runs in demo mode — useful for working on
the UI without burning tokens.

## Project layout

This is a pnpm workspace monorepo:

- `artifacts/ag-code-agent` — React + Vite frontend
- `artifacts/api-server` — Express 5 API
- `lib/api-spec` — the OpenAPI spec (`openapi.yaml`), the source of truth for all API contracts
- `lib/api-client-react` — generated React Query hooks + Zod schemas (do **not** edit by hand)
- `lib/db` — Drizzle ORM schema
- `scripts/agent` — the Python agent (`run_agent.py`)
- `runs/` — per-run working directories, generated at runtime and gitignored

## Contract-first API workflow

The API is defined contract-first. Never hand-edit generated clients. Instead:

1. Edit the OpenAPI spec in `lib/api-spec/openapi.yaml`.
2. Regenerate the typed hooks and Zod schemas:
   ```bash
   pnpm --filter @workspace/api-spec run codegen
   ```
3. Rebuild library declarations so dependent packages see the new types:
   ```bash
   pnpm run typecheck:libs
   ```
4. Implement the server route (validate inputs/outputs with the generated Zod schemas)
   and consume the generated hooks on the frontend.

## Database changes

Edit the Drizzle schema under `lib/db/src/schema/`, then push to your dev database:

```bash
pnpm --filter @workspace/db run push
```

## Before opening a pull request

Run the full typecheck and make sure it passes:

```bash
pnpm run typecheck
```

Guidelines:

- Keep changes focused and follow the existing structure and conventions.
- Don't commit secrets — `.env` is gitignored; `.env.example` documents the variables.
- Don't commit anything under `runs/` (agent working output) — it's gitignored.
- Server code uses structured logging (`req.log` in handlers, the shared `logger`
  elsewhere) — avoid `console.log` in server packages.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).
