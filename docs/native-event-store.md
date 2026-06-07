# ActiveGraph's native event store as the authoritative log

AG Coder treats ActiveGraph's durable, schema-versioned, forkable, replayable
event log — `PostgresEventStore` — as the **source of truth** for every run. The
UI tables are a projection over it, not a parallel source of truth.

## Why the store is authoritative

ActiveGraph ships `PostgresEventStore`, and `Graph.emit` persists every event to
an attached store automatically. Building on that directly — rather than
re-deriving the trace into the UI tables by hand — means:

- persistence comes from the framework instead of being reimplemented,
- the UI tables are a derived view that can always be rebuilt, never a second
  artifact that has to be kept in sync, and
- the framework's flagship features (replay, fork) are available, because they're
  built on top of that same log.

## How it works

In `scripts/agent/run_agent.py`:

1. **The native store is the authoritative log.** `_open_native_store()` opens a
   `PostgresEventStore` and `graph.attach_store()` wires it in _before_ any event
   is emitted. The runtime persists its complete event stream — including the
   framework lifecycle events (`behavior.started/completed`, `relation.created`,
   framework `patch.applied`, …) that the UI projection deliberately drops — to
   the framework's own tables.

2. **Isolated schema, one database.** The store's `events` / `runs` / `meta`
   tables live in a dedicated `activegraph` Postgres schema so they never collide
   with the application's `public.runs` (which has a different shape). Same
   `DATABASE_URL`; only the schema namespace differs.

3. **`PostgresMirror` is a projection.** Its dispatch method is `project(event)`:
   a downstream view of the authoritative log. The live listener and the rebuild
   path (below) call the same `project`, so the projection is identical whether it
   runs live or is reconstructed.

4. **`rebuild_ui_projection()` proves the projection claim.** It replays the
   native store's events into a fresh `Graph` and re-projects each one,
   reconstructing the UI tables for a run **purely from the framework's log**.
   Exposed as `run_agent.py --run-id <id> --rebuild-projection`. This is the same
   mechanism a `Runtime.load` / `Runtime.fork` uses.

5. **Best-effort / non-breaking.** If `psycopg` 3 / `activegraph[postgres]` is
   missing or the store can't open, `_open_native_store` returns `(None, None)`
   and the run proceeds on the UI projection alone.

## Verification (local Postgres, demo mode)

A demo run produces:

| Surface                             | Result                                                    |
| ----------------------------------- | --------------------------------------------------------- |
| App status                          | `completed`                                               |
| UI projection                       | 25 `agent_events`, 6 `graph_objects`, 5 `graph_relations` |
| Native store (`activegraph.events`) | **38** events (full lifecycle trace)                      |
| Native store (`activegraph.runs`)   | run row with goal                                         |

Rebuilding the UI tables from the native store alone (`--rebuild-projection`)
reproduces the live projection **byte-for-byte** — events, objects, and relations
all identical (including row ids). The UI tables are a pure, reproducible function
of ActiveGraph's authoritative log.

## What the authoritative log enables

Because the framework's log is the source of truth, the higher-level features are
plain framework operations rather than bespoke code:

- **Fork** (`docs/fork-and-replay.md`): `PostgresEventStore.fork_run()` copies the
  parent's native event log up to the chosen event into the new run (shared
  lineage), replays it into the graph and projects it into the UI, then the agent
  continues forward with the parent's LLM/tool responses pre-loaded into
  `replay_llm_cache` / `replay_tool_cache`.
- **Replay / time-travel**: `rebuild_ui_projection` replays a stored run's events
  to reconstruct the UI byte-for-byte; the fork path uses the framework replay
  caches so an identical re-derivation serves from cache instead of the API.
- **A thin projection write-path**: pointing the API reads at a
  view/materialization over `activegraph.events` would let the mirror shrink to a
  thin read-model mapper.
