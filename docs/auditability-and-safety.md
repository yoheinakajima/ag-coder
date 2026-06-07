# Auditability + safety

Three features that make the README's "show its work" and "stay safe" claims
concrete, each built on an ActiveGraph primitive: native `causal_chain()`,
`Policy` + human-in-the-loop approvals, and `Frame` + a cost budget. They build on
the native event store and the runtime owning the LLM/tool loop.

## 1. Native `causal_chain()` in the UI

The README's pitch is "walk the edge back from the patch to the model call to the
task to the goal." That walk is a built-in ActiveGraph function
(`activegraph.trace.causal.causal_chain`), and the UI surfaces the framework's own
chain.

- **Agent:** `--causal-chain <objectId>` replays a run's authoritative event log
  and prints `causal_chain()` as JSON (accepts scoped or local ids).
- **API:** `GET /runs/:runId/causal-chain?objectId=…` shells out to that mode
  (contract-first: `openapi.yaml` + regenerated hooks).
- **UI:** `CausalChainPanel` renders the chain under the Causal Graph; selecting
  a node traces it back through its LLM/tool calls to the goal. Example output:

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

This works because the runtime owns the loop and stamps provenance — the chain is
real `caused_by` lineage, not hand-built edges.

## 2. Policy + human-in-the-loop approvals

Capabilities are declared as an ActiveGraph `Policy`, and a real "approve before
commit" gate sits in front of any committed change.

- **Policy:** a `Policy` is attached to the Runtime declaring the agent's
  capabilities (`can_call_tool`, `can_create`, `requires_approval`). Blocked
  writes/commands surface as `policy.denied` events in the trace.
- **Approval gate:** when a run is created with `requireApproval`, the agent runs
  to completion in its isolated work dir but pauses at **`awaiting_approval`**:
  it records a pending approval, emits `approval.requested`, and leaves the
  changes uncommitted. A reviewer approves (commit) or rejects (discard
  worktree). `finalize_run` resolves it, emitting the framework approval events:
  - approve → `approval.granted` → commit → `run.completed`
  - reject → `approval.denied` → discard → `run.rejected`
- **API/UI:** `GET /runs/:id/approvals`, `POST /runs/:id/approvals/:id`
  `{decision}`; an `ApprovalBanner` (Approve/Reject) on a paused run and a
  "require my approval" checkbox on the new-run form.

**Why the gate is at run completion, not mid-loop:** the runtime owns the LLM→tool
turn loop (`@llm_behavior`), so the natural human checkpoint is the finished
patch-set, not an individual tool call. The agent makes changes in a per-run work
dir and nothing is committed/pushed until a human approves.

## 3. `Frame` + `max_cost_usd` cost budgeting

- **Frame:** a `Frame(goal, constraints, success_criteria)` is attached to the
  Runtime, so the framework stamps `frame_id` provenance on every
  object/relation/event — the whole run is tagged with the mission it served.
- **Cost budget:** `max_cost_usd` (env `AGENT_MAX_COST_USD`, default `$1.00`)
  enables the runtime's token-based pre-call cost gate; a run that would exceed the
  ceiling stops with `budget.cost_exhausted` before spending.

### A framework bug this surfaced (and the fix)

Enabling `max_cost_usd` makes the runtime call the provider's `count_tokens`
before each LLM call. ActiveGraph 1.0.5's `AnthropicProvider.count_tokens`
serializes messages with `m.to_dict()`, which leaves tool-result messages as
`role="tool"` — a role the Anthropic API rejects (`complete()` correctly maps
them). Without a fix, turning on cost gating breaks every multi-turn tool run.
We wrap the provider to make `count_tokens` use the same message conversion
`complete()` does (`_anthropic_provider` in `run_agent.py`).

## Setup

The approval flow requires a `runs.require_approval` column and an
`agent_approvals` table. Apply the schema with:

```bash
pnpm --filter @workspace/db run push
```
