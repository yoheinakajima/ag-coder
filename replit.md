# AG Coder

> Public project name: **AG Coder**. Internal workspace package/artifact identifiers (`@workspace/ag-code-agent`, the `ag-code-agent` artifact dir, the Python agent's git commit author) intentionally remain `ag-code-agent` to avoid risky renames.

A web-based coding agent UI where every action (file reads, writes, bash commands, LLM calls) is a traceable node in a live causal graph. Think developer cockpit: graph-first auditability meets real-time observability.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, proxied at `/api`)
- `pnpm --filter @workspace/ag-code-agent run dev` — run the frontend (port 24669, proxied at `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` — enables real LLM-powered agent (falls back to demo mode without)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind + shadcn/ui + wouter + react-resizable-panels
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Agent: Python 3 + ActiveGraph + psycopg2 (spawned as subprocess per run)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for all API contracts)
- `lib/api-client-react/src/generated/` — generated React Query hooks + Zod schemas (do not edit)
- `lib/db/src/schema/` — Drizzle ORM schema (`runs.ts` has all 4 tables)
- `artifacts/api-server/src/routes/runs.ts` — all run/event/graph/diff endpoints + SSE stream
- `artifacts/api-server/src/routes/files.ts` — file listing/content endpoints
- `scripts/agent/run_agent.py` — Python agent (ActiveGraph demo mode + LLM mode)
- `artifacts/ag-code-agent/src/pages/` — frontend pages (dashboard, run-detail, run-diff)

## Architecture decisions

- **Subprocess per run**: The Python agent runs as a detached child process spawned by Express. stdio is suppressed — errors only visible via DB state.
- **Native event store is authoritative**: ActiveGraph's `PostgresEventStore` is attached to the runtime (`graph.attach_store`) so the framework durably persists every event to its own `events`/`runs`/`meta` tables in a dedicated `activegraph` Postgres schema (isolated from the app's `public.*`). This is the source of truth; see `docs/tier1-native-event-store.md`.
- **UI tables are a projection**: ONE listener (`PostgresMirror`, registered via `graph.add_listener` before the Runtime) projects that same event stream into the UI tables (`agent_events`/`graph_objects`/`graph_relations`). It's a derived view — `rebuild_ui_projection` / `--rebuild-projection` reconstructs the UI tables byte-for-byte from the native log.
- **Runtime owns the LLM+tool loop**: In LLM mode the executor is an `@llm_behavior` declaring `@tool`s (read/write/edit/bash, Pydantic-typed); the runtime drives the turn loop and emits native `llm.*`/`tool.*` events. The handler materializes patch/file_snapshot/command_result/model_call objects from those events with auto-stamped provenance (so `causal_chain()` works). Demo mode (no key) keeps a plain `@behavior` executor. See `docs/tier1-tools-and-llm-behavior.md`.
- **Real fork + replay**: `/runs/:id/fork` copies the parent's native event log up to the chosen event into the new run (`PostgresEventStore.fork_run`), replays it, projects the inherited prefix, then continues forward with `replay_llm_cache`/`replay_tool_cache` preloaded. Degrades to a fresh continuation for parents predating the native store. See `docs/tier1-native-fork.md`.
- **Event-driven cascade**: object creation emits ActiveGraph events that wake behaviors (`goal.created`→plan/task→`task.ready`→execute→`edits.completed`→test→`test.run.completed`→bounded fix loop).
- **Auditability + safety (Tier 2)**: native `causal_chain()` surfaced via `GET /runs/:id/causal-chain` + the CausalChainPanel; a `Policy` declares capabilities and blocked ops emit `policy.denied`; `requireApproval` pauses a run at `awaiting_approval` (approval.requested→granted/denied) resolved via `/runs/:id/approvals`; a `Frame` (goal/constraints) stamps frame_id provenance and `max_cost_usd` (AGENT_MAX_COST_USD) adds token-based cost gating. New DB: `runs.require_approval` + `agent_approvals`. See `docs/tier2-auditability-and-safety.md`.
- **Reserved event types**: ActiveGraph's `apply_event` projector reserves `object.created/removed`, `relation.created/removed`, `patch.proposed/applied/rejected` and requires its own Patch/Object payload shape. The agent never emits those names with domain payloads (it would crash the projector). The UI's `patch.applied`/`patch.proposed` events are *derived in the mirror* from the patch object's data; framework field-patches are surfaced as `object.patched` to avoid colliding with the file-patch UI.
- **Graph object IDs are run-scoped**: IDs like `plan#1` from ActiveGraph are stored as `{run_id[:8]}:{local_id}` (e.g. `0e83e11d:plan#1`) to avoid cross-run collisions in the `graph_objects` table.
- **SSE + polling hybrid**: The run-detail page uses SSE (`EventSource`) for live events while a run is active, combined with React Query polling for snapshot consistency. Events are merged by ID in a Map.
- **Demo mode**: Without an LLM API key, the agent runs a deterministic demo scenario — reads files, calls a mock model, proposes a patch — producing real events and graph objects for UI testing.
- **Agent script path**: The API server runs from `artifacts/api-server/` so the Python script path uses `path.resolve(process.cwd(), "../..")` to find `scripts/agent/run_agent.py` at the workspace root.

## Product

- **Dashboard**: Stats summary (total/active/completed/failed runs) + run history list + "New Agent Run" form to submit a goal
- **Run Detail** (4-panel layout): Causal graph tree (left), agent conversation/messages (center), file patches (right), live event stream (bottom). Resizable panels, SSE streaming, Fork Run button.
- **Run Diff**: Side-by-side comparison of two runs showing event/object/tool call differences

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Run graph object IDs are scoped: `{run_id[:8]}:{activegraph_id}` — relations source/target also use scoped IDs
- The agent subprocess has suppressed stdio — check DB state (`agent_events`, `runs` tables) to debug agent failures
- `process.cwd()` in the API server = `artifacts/api-server/` not workspace root — use `path.resolve(process.cwd(), "../..")` for workspace-relative paths
- Always rebuild the API server (`pnpm --filter @workspace/api-server run build`) before restarting the workflow after code changes
- Codegen: run `pnpm --filter @workspace/api-spec run codegen` after editing `openapi.yaml`, then `pnpm run typecheck:libs` to rebuild

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
