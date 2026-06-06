# AG Coder

**An auditable coding agent built on ActiveGraph.**

AG Coder is a web-based coding agent where every meaningful action — planning, file reads, file writes, bash commands, LLM calls, patches, and test runs — becomes a live, inspectable object in a causal graph.

Most coding agents show you the final diff. Maybe they show you a chat transcript. AG Coder is an experiment in showing the actual runtime structure underneath the agent: what goal created which plan, which task triggered which tool call, which model call produced which patch, and what happened after that patch was tested.

The result is a developer cockpit for watching an agent work. You give it a goal, the agent runs, and the UI fills in with a graph, event stream, conversation, and file changes as the run unfolds.

This repo is not trying to be a production IDE or a Cursor replacement. It is a reference implementation for a different way to build agents: graph-native, event-driven, and auditable by default.

---

## Why this exists

Agent work is usually trapped in the wrong shape.

A transcript is useful, but it is linear. Logs are useful, but they are usually untyped. Diffs are useful, but they only show the final artifact. Real agent execution is not linear. A goal creates a plan. A plan creates tasks. Tasks read context, call models, run tools, produce edits, run tests, and sometimes trigger new tasks.

That is a graph.

AG Coder uses [ActiveGraph](https://activegraph.ai) to make that graph explicit. ActiveGraph is an event-driven graph runtime for building agents around typed objects, relations, events, and behaviors. Instead of treating memory and logs as side effects, the runtime state is the thing the agent operates on.

In this repo, that means every agent run leaves behind a structured audit trail:

- what the agent was asked to do
- what plan it created
- which files it inspected
- what it asked the model
- which patch was produced
- which commands ran
- what succeeded, failed, or was skipped
- how each step relates causally to the others

If you have ever wished your coding agent could actually show its work, this is a small implementation of what that looks like.

---

## What it does

1. You type a goal ("write a prime-number checker with tests").
2. The agent plans, reads files, writes code, and runs commands — all in real time.
3. The UI updates live as the run unfolds, across four panels:
   - **Causal graph** — the goal → plan → task → tool-call → patch → test-run structure as it forms
   - **Agent conversation** — the messages exchanged with the model
   - **File changes** — the patches the agent produced
   - **Event stream** — a live, timestamped log of every step
4. When it's done, you have a full audit trail of every decision the agent made.

Without an LLM key, the app runs in **demo mode** — it still populates a real graph and event stream, just with a deterministic scripted scenario instead of a live model. This makes it easy to explore the UI before wiring up a model.

---

## What is ActiveGraph?

[ActiveGraph](https://activegraph.ai) is an event-driven graph runtime for building agents.

The basic idea is simple:

- agent state is represented as typed graph objects
- relationships describe how those objects connect
- events record what changed
- behaviors react to events and create the next useful state transition
- the runtime drives the system forward under a budget

In AG Coder, that means a coding run is not just a loop hidden inside a Python script. It becomes a graph of goals, plans, tasks, model calls, tool calls, patches, test runs, and outcomes.

For example:

```text
Goal
  └── Plan
        └── Task
              ├── FileRead
              ├── ModelCall
              │     └── Patch
              └── TestRun
```

This is the core ActiveGraph pattern: make the work visible as structured runtime state, then let behaviors operate over that state.

ActiveGraph is published on PyPI: [`activegraph`](https://pypi.org/project/activegraph/).

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/yoheinakajima/ag-coder.git
cd ag-coder
pnpm install
pip install -r scripts/agent/requirements.txt
```

Requirements:

- **Node.js 24+** and **pnpm**
- **Python 3** (for the agent subprocess)
- **PostgreSQL**
- The Python agent's dependencies (`pip install -r scripts/agent/requirements.txt`)

### 2. Set up environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ **required** | Postgres connection string |
| `ANTHROPIC_API_KEY` | optional | Enables the Anthropic-powered agent (takes priority if both are set) |
| `OPENAI_API_KEY` | optional | Enables the OpenAI-powered agent |
| `SESSION_SECRET` | optional | Express session secret (auto-generated if omitted) |

> If neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is set, the agent runs in deterministic **demo mode**.

### 3. Push the database schema

```bash
pnpm --filter @workspace/db run push
```

Optionally run the preflight check to confirm your environment is wired up
(required env vars, a reachable Postgres, `python3` + agent deps, and which
agent mode is active):

```bash
pnpm run check
```

### 4. Start the servers

```bash
# Terminal 1 — API
pnpm --filter @workspace/api-server run dev

# Terminal 2 — Frontend
pnpm --filter @workspace/ag-code-agent run dev
```

Then open the frontend in your browser (Vite prints the URL on startup). In local
dev the frontend proxies `/api` to the API server, so a plain `pnpm dev` works
without any extra proxy setup.

---

## Configuration & security

Sensible defaults work out of the box; these env vars let you harden a public
deployment (see [`.env.example`](./.env.example) for the full list):

| Variable | Description |
|---|---|
| `CORS_ORIGINS` | Extra allowed CORS origins (comma-separated). localhost and Replit domains are always allowed. |
| `AGENT_API_KEY` | If set, mutating endpoints require this key (`x-api-key` header or `Authorization: Bearer`). Off by default. |
| `RUN_RATE_LIMIT_MAX` / `RUN_RATE_LIMIT_WINDOW_MS` | Rate limit for creating/forking runs. Defaults to 10 per 60s. |

The server also derives each run's working directory server-side under `runs/`
and only accepts `https://github.com/<owner>/<repo>` URLs for cloning.

---

## Architecture

```text
Browser (React + Vite)
   │  submit goal
   ▼
Express API (POST /api/runs)
   │  spawn subprocess
   ▼
run_agent.py (Python + ActiveGraph)
   │  one listener mirrors the runtime's event stream
   ▼
PostgreSQL  ◀── API reads + streams via SSE ──▶  Browser
```

- **Frontend** — React + Vite + Tailwind + shadcn/ui. The 4-panel run-detail view renders the graph, conversation, file patches, and event stream, streaming live updates over SSE (`GET /api/runs/:id/stream`).
- **API** — Express 5 + TypeScript, contract-first via an OpenAPI spec with Orval generating typed React Query hooks and Zod schemas. It spawns the agent as a detached subprocess and exposes runs, events, graph objects, file trees, and diffs.
- **Agent** — a Python process using ActiveGraph, event-driven end to end: creating an object wakes a behavior (goal → plan/task → execute → test → bounded fix loop). In LLM mode the runtime itself owns the think→act→observe loop via ActiveGraph `@tool`s and an `@llm_behavior` (no hand-rolled SDK loop).
- **Authoritative log** — ActiveGraph's native `PostgresEventStore` is attached to the runtime, so every event is durably persisted to the framework's own schema-versioned, forkable, replayable tables (in a dedicated `activegraph` Postgres schema).
- **UI projection** — a single listener (`PostgresMirror`) *projects* that same event stream into the denormalized tables the UI reads (`runs`, `agent_events`, `graph_objects`, `graph_relations`) — a derived view, not a parallel source of truth. It can be rebuilt from the authoritative log at any time.

**The framework's event log is the source of truth for each run**, and the UI tables are a projection of it — which is what makes the live UI, the audit trail, and features like real fork + replay the same underlying thing. See the [deeper docs](#deeper-docs) for how each piece maps onto ActiveGraph.

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

```text
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
pnpm run test                                     # run package tests
pnpm run build                                    # typecheck + build everything
pnpm run check                                    # preflight env/DB/Python check
pnpm run format                                   # format with Prettier (format:check to verify)
pnpm --filter @workspace/api-spec run codegen     # regenerate hooks after editing openapi.yaml
pnpm --filter @workspace/db run push              # push schema changes to dev DB
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contract-first workflow and contribution guidelines.

---

## What this is / is not

AG Coder is a reference implementation for auditable agent execution.

It is designed to show how a coding agent can be built around a live graph of actions, artifacts, and causal relationships. The important part is not that it edits code. The important part is that every meaningful step is represented as inspectable state.

This is not intended to be a full production coding environment, IDE replacement, or hardened sandbox. If you use it with real code, treat it as an experimental developer tool. The goal of the repo is to make the architecture legible, hackable, and easy to extend.

---

## Deeper docs

- [Building a coding agent you can actually audit — with ActiveGraph](./docs/building-with-activegraph.md) — the deeper technical walkthrough of how AG Coder is built on ActiveGraph.
- How AG Coder leans on ActiveGraph's own primitives (recent architecture work):
  - [Native event store as the authoritative log](./docs/tier1-native-event-store.md)
  - [The runtime owns the LLM + tool loop (`@tool` / `@llm_behavior`)](./docs/tier1-tools-and-llm-behavior.md)
  - [Real fork + replay built on `PostgresEventStore.fork_run`](./docs/tier1-native-fork.md)
- [Contributing](./CONTRIBUTING.md) — setup, conventions, and the contract-first API workflow.
- [ActiveGraph](https://activegraph.ai) · [`activegraph` on PyPI](https://pypi.org/project/activegraph/)

---

## License

[MIT](./LICENSE)
