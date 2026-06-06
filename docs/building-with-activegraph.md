# Building a coding agent you can actually audit — with ActiveGraph

Most coding agents are black boxes. You give them a goal, they churn for a while,
and at the end you get a diff (or an apology). What happened in between — which
files it read, what it asked the model, why it chose that edit — is gone, buried
in a scrollback of log lines if it was captured at all.

**AG Coder** is an experiment in the opposite direction: an agent where *every
action is a node in a live causal graph*. File reads, writes, bash commands,
model calls, patches, test runs — each is an object or event with explicit
provenance back to the things that caused it. The UI is a developer cockpit: a
causal graph on the left, the conversation in the center, file changes on the
right, and a live event stream along the bottom. You watch the agent think, and
when it's done you have a complete audit trail.

This is the deeper technical walkthrough for the [AG Coder](../README.md) repo.
The interesting part isn't that it edits code — it's how thoroughly it leans on
[ActiveGraph](https://activegraph.ai)'s own primitives (published on PyPI as
[`activegraph`](https://pypi.org/project/activegraph/)) so that the audit trail,
the live UI, and features like fork + replay are all the *same* underlying thing.

---

## The idea: actions as a causal graph

The core bet is that an agent's execution is naturally a graph, not a transcript.
A goal produces a plan. A plan has tasks. A task reads files, calls a model, and
the model call produces a patch. A patch gets tested. Each of those is a node,
and the edges are the causal story.

ActiveGraph makes that literal: it's an event-sourced graph runtime. You declare
typed objects and relations, register behaviors that react to events, and let the
runtime drive the whole thing under a budget — persisting every event to a
durable log as it goes. Auditability isn't something you bolt on; it's the
substrate.

---

## Architecture at a glance

```
Browser (React + Vite)
   │  submit goal
   ▼
Express API (POST /api/runs)
   │  spawn subprocess
   ▼
run_agent.py (Python + ActiveGraph)
   │  the runtime persists its own event log…
   ▼
PostgreSQL
   ├── activegraph.*  — the framework's authoritative event store (source of truth)
   └── public.*       — a projection of that log, shaped for the UI
   ◀── API reads + streams via SSE ──▶  Browser (live graph + events)
```

- **Authoritative log:** ActiveGraph's native `PostgresEventStore` is attached to
  the runtime, so every event is durably persisted to the framework's own
  schema-versioned tables (in a dedicated `activegraph` Postgres schema).
- **UI projection:** one listener (`PostgresMirror`) *projects* that same stream
  into the denormalized tables the UI reads. It's a derived view — it can be
  rebuilt from the authoritative log at any time — not a parallel source of truth.

---

## Building with ActiveGraph

Here's how each piece of the agent maps onto a framework primitive.

### A typed domain — declared as a Pack

The coding-agent domain (`plan`, `task`, `patch`, `file_snapshot`, `model_call`,
`command_result`, `test_run`, …) is declared as an ActiveGraph **Pack**
(`scripts/agent/coding_pack.py`): `ObjectType`s with Pydantic schemas and
`RelationType`s with endpoint constraints. Loading it
(`runtime.load_pack(coding_pack)`) makes the graph *typed* — `add_object("patch",
…)` validates against `PatchSchema`, and `add_relation(task, patch,
"TASK_HAS_PATCH")` is checked against the declared source/target types. Schemas
use `extra="allow"` so the rich UI fields pass through while the declared fields
are type-checked; malformed data raises `PackSchemaViolation`.

### Behaviors and the event cascade

The agent's control flow is a cascade of small behaviors, each reacting to a
fact: `goal.created` → plan/task → `task.ready` → execute → `edits.completed` →
test → `test.run.completed` → a bounded fix loop. Each behavior is a tiny,
testable reaction; adding a capability is "register a behavior that listens for
event X," not "thread another step through a monolithic loop."

One of them is **pattern-triggered**: the pack's `verification_marker` fires via a
Cypher-subset graph pattern — `(t:task)-[:TASK_HAS_TEST_RUN]->(tr:test_run)` —
instead of a bare event subscription, so it only runs when the graph actually has
that shape.

### The runtime owns the LLM + tool loop

This is the part most agents hand-roll. AG Coder doesn't. `read_file`,
`write_file`, `edit_file`, and `bash` are first-class `@tool`s with Pydantic
input/output schemas, and the executor is an `@llm_behavior`. The **runtime**
owns the turn loop: it assembles the prompt, calls the provider, emits
`llm.requested` / `llm.responded`, dispatches `tool.requested` /
`tool.responded`, validates I/O against the schemas, and stamps provenance. The
developer handler runs once, at the end, and turns the recorded tool events into
the graph's `patch` / `file_snapshot` / `command_result` objects.

The payoff is that the LLM and tool activity *is* the trace — typed framework
events with `caused_by` lineage — not a parallel narrative reconstructed by hand.

### Durable, forkable, replayable — for free

Because the native `PostgresEventStore` is attached, `graph.emit` persists every
event automatically. That single fact unlocks:

- **Replay:** the run's event log can be replayed into a fresh graph to rebuild
  state exactly (the UI projection is regenerated this way — byte-for-byte).
- **Fork:** `PostgresEventStore.fork_run` copies the parent's log up to a chosen
  event into a new run (shared lineage), which the agent then continues forward
  on — with the parent's LLM/tool responses pre-loaded into `replay_llm_cache` /
  `replay_tool_cache` so identical re-derivations don't re-spend. The Fork UI is
  backed by a real lineage fork, not a cosmetic re-run.

### Safety as Policy + human-in-the-loop approvals

The agent's capabilities are declared as an ActiveGraph `Policy`
(`can_call_tool`, `can_create`, `requires_approval`); blocked writes/commands
surface as `policy.denied` events. With `requireApproval` on, a run pauses at
`awaiting_approval` after producing its changes (uncommitted) and emits
`approval.requested`; a reviewer approves (`approval.granted` → commit →
`completed`) or rejects (`approval.denied` → discard → `rejected`).

### Frame + budgets

A `Frame(goal, constraints, success_criteria)` tags every object/relation/event
with `frame_id` provenance. The budget includes `max_cost_usd`, so the runtime
estimates each LLM call's cost before spending and stops with
`budget.cost_exhausted` before blowing the ceiling.

### Provenance + `causal_chain`

Because the runtime stamps `caused_by` (and the LLM/tool request ids) on
everything, the README's pitch — "walk the edge back from the patch to the model
call to the task to the goal" — is a built-in function, `causal_chain()`, surfaced
in the UI:

```
patch#3 (patch)
  ← task_executor (evt_015) llm.requested  model=claude-sonnet-4-5
    (evt_016) llm.responded cost=$0.006
  ← task_executor (evt_017) tool.requested  tool=write_file
    (evt_018) tool.responded cost=$0.000
  ← task_executor (evt_021) object.created
    ← goal_planner (evt_008) task.ready
      ← user (evt_002) goal.created
```

### Observability

The runtime is fed a `PrometheusMetrics` backend, JSON logging goes to a per-run
file, and each run emits an `ops.status` snapshot (`runtime.status()`) with the
budget (real cost spent) and registered behaviors. The framework's own
`activegraph inspect` / `export-trace` / `migrate` CLIs run directly against the
store. See [operating AG Coder](./operating-ag-coder.md).

---

## The one real integration seam: the UI projection

ActiveGraph owns the authoritative log; the UI wants denormalized tables it can
render and stream. The bridge is a single listener — `PostgresMirror` — that
projects the runtime's event stream into `agent_events` / `graph_objects` /
`graph_relations`. The important property is that it's a *pure function of the
log*: drop those tables and `--rebuild-projection` reconstructs them from the
native store, byte-for-byte. The projection is a read-model, not a competing
write-path.

There's one sharp edge worth naming: ActiveGraph's projector reserves a few event
names (`object.*`, `relation.*`, `patch.proposed/applied/rejected`) and owns
their payload shape. The mirror respects that — it never re-emits those names with
domain payloads; it *derives* the UI's file-patch events from the `patch` objects
and the `tool.responded` events. Let the framework own its event vocabulary and
translate at the projection boundary.

---

## Lessons learned

- **Let the runtime own the loop.** Moving the LLM/tool loop into `@tool` +
  `@llm_behavior` deleted ~300 lines of hand-rolled SDK plumbing and made the
  trace native — which is what makes `causal_chain` real.
- **The store is the audit trail.** Attaching `PostgresEventStore` means the
  durable log, replay, and fork are the framework's, not the app's. The UI tables
  are a projection over it; nothing competes to be the source of truth.
- **Declare the domain.** A Pack turns "untyped dicts" into validated objects and
  relations, so behaviors and patterns can rely on shapes.
- **Budgets and approvals are safety, not afterthoughts.** `max_cost_usd` caps
  spend; the approval flow puts a human between "agent changed files" and "changes
  are committed."
- **Replay caches make experimentation cheap.** Forking a run and re-deriving an
  identical prompt serves from cache instead of the API.

---

## Try it

The project is open source. Point it at a Postgres database, add an LLM key (or
run in demo mode), and submit a goal. The setup steps are in the
[README](../README.md); the architecture is documented in the
[tier-1](./tier1-native-event-store.md),
[tier-2](./tier2-auditability-and-safety.md), and
[operations](./operating-ag-coder.md) docs.

If you've ever wished your coding agent could *show its work*, this is what that
looks like when the work is a graph — and the graph is the framework's.
