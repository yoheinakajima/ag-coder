# Building a coding agent you can actually audit — with ActiveGraph

Most coding agents are black boxes. You give them a goal, they churn for a while,
and at the end you get a diff (or an apology). What happened in between — which
files it read, what it asked the model, why it chose that edit — is gone, buried
in a scrollback of log lines if it was captured at all.

**AG Code Agent** is an experiment in the opposite direction: an agent where
*every action is a node in a live causal graph*. File reads, writes, bash
commands, model calls, patches, test runs — each is an object with explicit
relationships to the things that caused it and the things it produced. The UI is
a developer cockpit: a causal graph on the left, the conversation in the center,
file changes on the right, and a live event stream along the bottom. You watch
the agent think, and when it's done you have a complete audit trail.

This post explains what the project is, how it's put together, and — the part I
found most interesting to build — what it's actually like to write an agent on top
of [ActiveGraph](https://pypi.org/project/activegraph/).

---

## The idea: actions as a causal graph

The core bet is that an agent's execution is naturally a graph, not a transcript.
A goal produces a plan. A plan has tasks. A task reads files, calls a model, and
the model call produces a patch. A patch gets tested. Each of those is a *node*,
and the edges (`PLAN_HAS_TASK`, `TASK_HAS_MODEL_CALL`, `MODEL_CALL_PRODUCED_PATCH`,
`TASK_HAS_TEST_RUN`) are the causal story.

Once you model it that way, auditability is free. You don't have to reconstruct
"why did it edit this file?" from logs — you walk the edge back from the patch to
the model call to the task to the plan to the goal. The graph *is* the explanation.

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
   │  write events + graph objects in real time
   ▼
PostgreSQL  ◀── API reads + streams via SSE ──▶  Browser (live graph + events)
```

- **Frontend** — React + Vite + Tailwind + shadcn/ui. A 4-panel run-detail view
  renders the graph, conversation, file patches, and event stream. It opens an
  SSE connection (`GET /api/runs/:id/stream`) for live updates while a run is
  active, and falls back to polling for snapshot consistency.
- **API** — Express 5 + TypeScript, contract-first via an OpenAPI spec with Orval
  generating typed React Query hooks and Zod schemas. The API spawns the agent as
  a detached subprocess and exposes runs, events, graph objects, file trees, and
  diffs.
- **Agent** — a Python process using ActiveGraph. It writes everything it does
  directly to Postgres as it goes, so the UI can render the graph as it forms.
- **Database** — PostgreSQL via Drizzle ORM, with four tables: `runs`,
  `agent_events`, `graph_objects`, and `graph_relations`.

A deliberate design choice: the agent **persists to the database, not to stdout**.
The subprocess's stdio is suppressed; the source of truth for what the agent did
is the graph and event rows in Postgres. That keeps the live UI and the audit
trail as the same thing.

---

## Building with ActiveGraph

ActiveGraph is an event-driven graph runtime. You build up a graph of objects and
relations, register **behaviors** that react to events, and let a **runtime** drive
the whole thing toward a goal under a budget. Here's how the pieces showed up in
practice.

### Objects and relations

You create nodes with `graph.add_object(type, data)`, which returns a node with an
`.id` and `.data`. You connect them with `graph.add_relation(source_id, target_id,
relation_type)`:

```python
from activegraph import Graph

graph = Graph()

plan = graph.add_object("plan", {"title": f"Plan: {goal}", "status": "active"})
task = graph.add_object("task", {"title": goal, "status": "open", "plan_id": plan.id})

graph.add_relation(plan.id, task.id, "PLAN_HAS_TASK")
```

Mutating a node later is `graph.patch_object(task_id, {"status": "in_progress"})`.
This maps cleanly onto a relational store — each `add_object` becomes a row in
`graph_objects`, each `add_relation` a row in `graph_relations`.

### Behaviors react to events

The agent's logic lives in behaviors — functions decorated with `@behavior` that
fire when matching events appear. The flow is a small cascade: the runtime emits
`goal.created`, a planner behavior turns it into plan + task nodes and emits
`task.ready`, and an executor behavior picks that up and does the work.

```python
from activegraph import behavior

@behavior(name="goal_planner", on=["goal.created"])
def goal_planner(event, graph, ctx):
    goal_text = event.payload.get("goal", "")
    plan = graph.add_object("plan", {"title": f"Plan: {goal_text}", "status": "active"})
    task = graph.add_object("task", {"title": goal_text, "status": "open"})
    graph.add_relation(plan.id, task.id, "PLAN_HAS_TASK")
    graph.emit("task.ready", {"task_id": task.id, "task": task})

@behavior(name="task_executor", on=["task.ready"])
def task_executor(event, graph, ctx):
    graph.patch_object(event.payload["task_id"], {"status": "in_progress"})
    # ... read files, call the model, propose a patch, run tests ...
```

This decomposition is the thing that makes the codebase pleasant. Each behavior is
a small, testable reaction to a fact. Adding a new capability is "register a
behavior that listens for event X and produces node Y," not "thread another step
through a monolithic loop."

### The runtime and budgets

You hand the graph to a `Runtime`, give it a budget, and call `run_goal`:

```python
from activegraph import Runtime

runtime = Runtime(graph, budget={"max_events": 500, "max_seconds": 300}, llm_provider=llm_provider)
runtime.run_goal(goal)
```

The budget is a guardrail against runaway agents — a hard ceiling on events and
wall-clock time. After the run, you can walk `runtime.store.events()` to capture
the framework-level trace (LLM requests/responses, tool calls, patch lifecycle)
and `graph.objects()` to sync anything the runtime created internally.

### LLM providers (and a demo mode)

ActiveGraph ships provider adapters; the agent picks one based on which key is
present, with Anthropic taking priority:

```python
if os.environ.get("ANTHROPIC_API_KEY"):
    from activegraph.llm import AnthropicProvider
    llm_provider = AnthropicProvider()
elif os.environ.get("OPENAI_API_KEY"):
    from activegraph.llm import OpenAIProvider
    llm_provider = OpenAIProvider()
else:
    llm_provider = None  # demo mode
```

When there's no key, `llm_provider` is `None` and the agent runs a deterministic
**demo scenario** — it still reads files, creates a model-call node, proposes a
patch, and records a skipped test run. Crucially, demo mode produces a *real* graph
and event stream. That made UI development possible without spending tokens on
every reload, and it gives newcomers something to look at immediately.

---

## Lessons learned

A few things that weren't obvious going in:

- **Mirror the graph to your store as you build it, not at the end.** The live UI
  is only possible because every `add_object` / `add_relation` is written to
  Postgres immediately. The graph forming on screen is the database filling up in
  real time. Batching the writes until run completion would have killed the whole
  "watch it think" experience.

- **Scope your node IDs.** ActiveGraph hands out local IDs like `plan#1` that are
  only unique within a single run. The moment you persist many runs into one table
  you get collisions. The fix is to namespace every ID with a short run prefix
  (`{run_id[:8]}:{local_id}`) — and remember to apply the same scoping to the
  `source`/`target` of relations, not just the objects.

- **Treat the database as the log.** Suppressing the subprocess's stdout felt
  wrong at first — how do you debug a silent process? But forcing all state
  through `graph_objects`, `graph_relations`, and `agent_events` meant the audit
  trail and the debugging surface became the same thing. When a run misbehaves,
  you query its rows.

- **Budgets are not optional.** An event-driven runtime where behaviors emit events
  that trigger behaviors is exactly the kind of system that can loop. The
  `max_events` / `max_seconds` budget is what makes it safe to let it run
  unattended.

- **Demo mode pays for itself.** A no-key path that still exercises the full graph
  pipeline is the single best thing you can do for both developer velocity and new
  contributor onboarding.

---

## Try it

The project is open source. Clone it, point it at a Postgres database, and either
add an LLM key or just run it in demo mode to see the graph fill in. The setup
steps are in the [README](../README.md), and the contribution workflow is in
[CONTRIBUTING.md](../CONTRIBUTING.md).

If you've ever wished your coding agent could *show its work*, this is what that
looks like when the work is a graph.
