# Fork + replay on ActiveGraph's event log

The Fork UI performs a real lineage fork: it branches a run at any event and
explores an alternate path, with the new run sharing its parent's history. It's
built on the native event store (`docs/native-event-store.md`); forks of runs that
predate the native store degrade gracefully to a fresh continuation.

## How it works

ActiveGraph's high-level `Runtime.fork(at_event)` is SQLite-only, but the
primitive it's built on — `PostgresEventStore.fork_run()` — works on Postgres (it
copies events up to a `seq` cutoff in a single transaction). The fork is built
directly on that.

In `scripts/agent/run_agent.py`:

1. **Map the UI event → the framework's event.** The mirror stamps each projected
   `agent_events` row with `_src_event_id` (the native event id), so a UI-selected
   event resolves back to the authoritative log (`_resolve_native_event_id`).

2. **Branch the native log.** `_fork_native_log()` calls
   `PostgresEventStore.fork_run()` to copy the parent's events up to and including
   the fork point into the new run id — real shared lineage in the framework's
   `activegraph.runs` (`parent_run_id`, `forked_at_event_id`) and
   `activegraph.events`.

3. **Replay + continue.** The copied prefix is replayed into a fresh `Graph` (ids
   reseeded so new ids don't collide), the prefix is projected into the UI tables
   through one mirror (so `seq` stays monotonic), and the agent continues forward —
   emitting a `run.forked` marker, then a fresh `goal.created` on top of the
   inherited history.

4. **Replay caches.** The parent's full log pre-populates `LLMCache` / `ToolCache`,
   so any identical LLM/tool call on the fork serves from cache instead of
   re-spending (`replay_llm_cache` / `replay_tool_cache`).

5. **Graceful degradation.** If the parent predates the native store (or the event
   can't be resolved), the fork degrades to a fresh continuation with an
   explanatory note rather than failing the run.

`artifacts/api-server/src/routes/runs.ts`: the `/runs/:runId/fork` route passes
`--fork-from <parentRunId> --at-event <atEventId>` to the agent.

CLI: `run_agent.py --run-id <new> --goal <g> --fork-from <parent> --at-event <evt>`.

## Verification (local Postgres, demo mode)

The figures below are from one sample fork — exact counts and event ids vary by
run. What's invariant is the lineage: the fork inherits the parent's prefix up to
the fork point, continues forward from there, and its UI projection rebuilds from
its own native log.

Forking a completed parent at its `task.ready` event (sample native id `evt_008`):

| Check                               | Result                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Fork status                         | `completed`                                                               |
| Native lineage (`activegraph.runs`) | `fork → parent`, `forked_at_event_id = evt_008`                           |
| Inherited prefix                    | UI seq 1–6 = the parent's events up to the fork point                     |
| Continuation                        | seq 7 = `run.forked`, then a fresh `goal.created` and new task/patch/test |
| Native event count                  | parent 38 → fork 46 (8 copied + new)                                      |
| Rebuild from store                  | fork's UI projection rebuilds from its 46-event native log                |

Degraded case (parent has no native log): the run still **completes**, starting
fresh with an `assistant.message.added` note explaining the lineage couldn't be
inherited.

## Known limitation

The fork branches the **event/graph lineage**, not the filesystem. The work
directory continues from its current state; files are not rewound to the fork
point. Reconstructing working-tree state at an arbitrary event is out of scope —
the audit trail (graph + events) is what forks deterministically.
