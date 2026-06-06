# Tier 1 prototype — ActiveGraph's native event store as the authoritative log

> Status: prototype. This is the first of the "make AG Coder a true ActiveGraph
> showcase" changes. It is intentionally additive and non-breaking: the UI and
> API are untouched, and a run still works if the new dependency is absent.

## The problem this addresses

AG Coder originally treated a hand-written `PostgresMirror` as the **source of
truth** for a run: a `graph.add_listener` that projected the runtime's event
stream into the UI tables (`agent_events` / `graph_objects` /
`graph_relations`) with raw `psycopg2` inserts.

But ActiveGraph already ships a durable, schema-versioned, forkable, replayable
event log — `PostgresEventStore` — and `Graph.emit` persists every event to an
attached store automatically. Re-deriving the trace by hand meant:

- reimplementing persistence the framework gives away for free,
- making the UI tables a _parallel_ artifact that has to be kept in sync, and
- foreclosing the framework's flagship features (replay, fork) that are built on
  top of that log.

## What changed

`scripts/agent/run_agent.py`:

1. **Attach the native store as the authoritative log.** `_open_native_store()`
   opens a `PostgresEventStore` and `graph.attach_store()` wires it in _before_
   any event is emitted. The runtime now persists its complete event stream —
   including the framework lifecycle events (`behavior.started/completed`,
   `relation.created`, framework `patch.applied`, …) that the UI projection
   deliberately drops — to the framework's own tables.

2. **Isolated schema, one database.** The store's `events` / `runs` / `meta`
   tables live in a dedicated `activegraph` Postgres schema so they never
   collide with the application's `public.runs` (which has a different shape).
   Same `DATABASE_URL`; only the schema namespace differs.

3. **Reframe `PostgresMirror` as a projection, not a source of truth.** Its
   dispatch method is now `project(event)` and its docstring says what it is: a
   downstream view of the authoritative log. The live listener and the rebuild
   path (below) call the same `project`, so the projection is identical whether
   it runs live or is reconstructed.

4. **Prove the projection claim: `rebuild_ui_projection()`.** Replays the native
   store's events into a fresh `Graph` and re-projects each one, reconstructing
   the UI tables for a run **purely from the framework's log**. Exposed as
   `run_agent.py --run-id <id> --rebuild-projection`. This is the same mechanism
   a real `Runtime.load` / `Runtime.fork` uses.

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

Rebuilding the UI tables from the native store alone
(`--rebuild-projection`) reproduces the live projection **byte-for-byte** —
events, objects, and relations all identical (including row ids). That is the
prototype's thesis made concrete: the UI tables are a pure, reproducible
function of ActiveGraph's authoritative log.

## What this unlocks

With the framework's log now authoritative, the remaining Tier-1 items become
tractable rather than bespoke:

- **Real fork — done** (`docs/tier1-native-fork.md`). The cosmetic "spawn a new
  run" fork is replaced with `PostgresEventStore.fork_run()`: the parent's
  native event log up to the chosen event is copied into the new run (shared
  lineage), replayed into the graph and projected into the UI, then the agent
  continues forward with the parent's LLM/tool responses pre-loaded into
  `replay_llm_cache` / `replay_tool_cache`.
- **Replay / time-travel — partial.** `rebuild_ui_projection` already replays a
  stored run's events to reconstruct the UI byte-for-byte; the fork path uses
  the framework replay caches so an identical re-derivation serves from cache
  instead of the API.
- **Retire the bespoke projection write-path** — once the API reads can be
  pointed at a view/materialization over `activegraph.events`, the hand-written
  mirror can shrink to a thin read-model mapper.
