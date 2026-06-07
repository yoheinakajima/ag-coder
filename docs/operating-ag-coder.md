# Operating AG Coder — observability with ActiveGraph

AG Coder opts into ActiveGraph's three operator-facing pillars (all framework-
native, all per run). Because the agent runs as a subprocess per run, these are
captured into the run's record and work dir rather than scraped from a
long-lived process.

## 1. Runtime status snapshot (`ops.status`)

At the end of every run the agent calls `runtime.status()` and emits the
framework's `RuntimeStatus` (serialized via `status_to_dict`) as an `ops.status`
event in the trace. It carries:

- `state` (idle / exhausted / stopped),
- `events_processed`,
- the **budget** snapshot — including the real cost spent
  (`cost_used_usd`) against `max_cost_usd`, and `exhausted_by` if a ceiling was
  hit,
- `registered_behaviors` — including the pack's pattern-triggered
  `ag_coder.verification_marker  [pattern]`.

It's visible in the run's event stream; to read it directly:

```sql
SELECT payload FROM agent_events WHERE run_id = '<id>' AND type = 'ops.status';
```

## 2. Metrics (`PrometheusMetrics`)

When `prometheus_client` is installed, the runtime is given a `PrometheusMetrics`
backend (otherwise `NoOpMetrics`). It records the standard ActiveGraph
instruments — `activegraph_events_emitted_total`,
`activegraph_behaviors_invoked_total`, `activegraph_behaviors_duration_seconds`,
`activegraph_queue_depth`, … The exposition for the run is written to:

```
<work_dir>/.ag-metrics.prom
```

> **Scrape model:** the agent is a subprocess per run, so its in-process metrics
> aren't live-scrapable. The `.ag-metrics.prom` dump is the per-run artifact. For
> a live `/metrics` endpoint you'd run the agent as a long-lived worker and serve
> the same `PrometheusMetrics` registry — a future enhancement.

## 3. Structured logging (`configure_logging`)

The agent enables ActiveGraph's JSON-line logger to a per-run file (the
subprocess's stdio is suppressed, so a file is where it's useful):

```
<work_dir>/.ag-agent.log
```

Each line follows the documented schema (`timestamp`, `level`, `logger`,
`message`, `run_id`, `event_id`, …).

## 4. The `activegraph` CLI on the native store

The authoritative event log lives in the **`activegraph` Postgres schema** (see
`docs/native-event-store.md`). Point the framework's own CLI at it by
setting the search path in the connection URL:

```bash
URL='postgresql://USER@HOST:5432/DB?options=-c%20search_path%3Dactivegraph'

# Status snapshot for a run (the CLI behind ops.status)
activegraph inspect "$URL" --run-id <id> --tail 20

# Dump a run's event log (text or JSONL)
activegraph export-trace "$URL" --run-id <id>

# Rebuild graph state from the log (no behaviors re-fired)
activegraph replay "$URL" --run-id <id>

# Structural diff between two runs
activegraph diff "$URL" --run-id <a> --other <b>

# Fork a run at an event into a new run (the primitive behind the Fork UI)
activegraph fork "$URL" --run-id <id> --at-event <evt_id>

# Migrate runs to another store (e.g. Postgres -> a portable SQLite file)
activegraph migrate "$URL" sqlite:///backup.db
```

Because the store is the framework's own schema, every one of these works out of
the box — the audit trail is ActiveGraph's, not a bespoke export.

## 5. List installed packs

```bash
activegraph pack list      # shows discovered packs (the ag_coder domain pack)
```
