# AG Code Agent

A web-based coding agent where every action — file reads, writes, bash commands, LLM calls — is a live, traceable node in a causal graph. Think developer cockpit: you give it a goal, watch it think, and see exactly what it did and why.

The UI is a 4-panel layout: the **causal graph** (left), the **agent conversation** (center), **file changes** (right), and a **live event stream** (bottom).

---

## What it does

1. You type a goal ("write a prime-number checker with tests").
2. The agent plans, reads files, writes code, runs tests — all in real time.
3. Every step appears in the causal graph on the left and the live event stream below.
4. When it's done you have a full audit trail of every decision the agent made.

Without an LLM key, the app runs in **demo mode** — it still populates a real graph and event stream, just with a scripted scenario instead of a live model. This makes it easy to explore the UI before wiring up a model.

---

## Quick start

### 1. Clone and install

```bash
git clone <your-repo-url>
cd ag-code-agent
pnpm install
```

Requires Node.js 24+ and pnpm. The Python agent needs Python 3 with `psycopg2` and `activegraph` available on the path.

### 2. Set up environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string |
| `OPENAI_API_KEY` | one of these | Enables the OpenAI-powered agent |
| `ANTHROPIC_API_KEY` | one of these | Enables the Anthropic-powered agent (takes priority if both are set) |
| `SESSION_SECRET` | optional | Express session secret (auto-generated if omitted) |

> If neither LLM key is set, the app runs in demo mode.

### 3. Push the database schema

```bash
pnpm --filter @workspace/db run push
```

### 4. Start the servers

```bash
# Terminal 1 — API
pnpm --filter @workspace/api-server run dev

# Terminal 2 — Frontend
pnpm --filter @workspace/ag-code-agent run dev
```

Then open the frontend in your browser (Vite prints the URL on startup).

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + Tailwind + shadcn/ui |
| API | Express 5 + TypeScript |
| Agent | Python 3 + ActiveGraph |
| Database | PostgreSQL + Drizzle ORM |
| Validation | Zod + drizzle-zod |
| API contract | OpenAPI → Orval codegen |

---

## Project layout

```
artifacts/
  ag-code-agent/     # React frontend (dashboard, run detail, run diff)
  api-server/        # Express API (runs, events, graph, file endpoints, SSE)
lib/
  api-spec/          # openapi.yaml — source of truth for all API contracts
  api-client-react/  # generated React Query hooks + Zod schemas (don't edit)
  db/                # Drizzle schema (runs, agent_events, graph_objects, graph_relations)
scripts/
  agent/             # run_agent.py — Python agent (OpenAI / Anthropic / demo)
runs/                # per-run working directories (generated, gitignored)
```

---

## Development commands

```bash
pnpm run typecheck                               # full typecheck (libs + all packages)
pnpm run build                                    # typecheck + build everything
pnpm --filter @workspace/api-spec run codegen     # regenerate hooks after editing openapi.yaml
pnpm --filter @workspace/db run push              # push schema changes to dev DB
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contract-first workflow and contribution guidelines.

---

## How the agent works

```
Goal submitted via UI
  └─▶ POST /api/runs  →  spawns Python subprocess
        └─▶ run_agent.py
              ├─ creates Plan + Task nodes in ActiveGraph
              ├─ calls OpenAI / Anthropic with tool-calling
              │     tools: read_file, write_file, edit_file, bash
              ├─ writes every event + graph object to Postgres in real time
              └─ emits run.completed
```

Each run gets an isolated working directory under `runs/<run-id>/`. The frontend streams events via SSE (`GET /api/runs/:id/stream`) and renders them as they arrive — no polling needed while a run is live.

Want the deeper story, including hands-on notes on building the agent with ActiveGraph? See [docs/building-with-activegraph.md](./docs/building-with-activegraph.md).

---

## License

[MIT](./LICENSE)
