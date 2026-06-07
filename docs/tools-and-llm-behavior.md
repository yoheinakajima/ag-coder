# The runtime owns the LLM + tool loop

The agent's core think→act→observe loop runs _inside_ ActiveGraph rather than in
hand-rolled provider SDK code. The LLM and tool calls are native framework events,
so they're instrumented, cacheable, replayable, and budgeted by the runtime — and
the causal graph is real `caused_by` lineage rather than a trace reconstructed by
hand. (Demo mode, with no key, takes a separate scripted path.)

## How it works

`scripts/agent/run_agent.py` uses ActiveGraph's tool + LLM-behavior system:

1. **`@tool`s with Pydantic schemas.** `read_file`, `write_file`, `edit_file`,
   `bash` are first-class `Tool`s with typed input/output (`_build_tools` binds
   them to the run's work dir). The runtime validates I/O against the schemas.
   Tool bodies never raise on expected failures — they return `ok=False` so the
   model can see and react, instead of failing the whole behavior.

2. **An `@llm_behavior` executor.** In LLM mode the executor is declared with
   `tools=[…]` and the runtime owns the entire turn loop: prompt assembly →
   `llm.requested` → provider call → `llm.responded` → `tool.requested` →
   tool dispatch → `tool.responded` → repeat, all as native events, with
   `max_tool_turns` bounding it. The developer handler runs _once_, after the
   loop.

3. **Graph objects from recorded events.** The handler
   (`_materialize_tool_objects`) reads this invocation's `tool.requested` /
   `tool.responded` events (the runtime stamps their ids on the BehaviorGraph)
   and creates the UI's `patch` / `file_snapshot` / `command_result` objects,
   plus a `model_call` summary. `BehaviorGraph` auto-stamps provenance, so every
   object links back to the tool/LLM events that produced it.

4. **Conversation from `llm.responded`.** The mirror derives
   `assistant.message.added` from `llm.responded.raw_text`, so the conversation
   panel stays populated without the behavior emitting it by hand.

5. **Demo mode.** With no provider, a plain `@behavior` executor runs the
   deterministic scripted scenario. `@llm_behavior` is only registered when a
   provider exists (it requires one).

## Verification (local Postgres + live provider)

Goal: _"Create a file hello.py that prints 'Hello, ActiveGraph'."_

- The run **completed** and actually wrote `hello.py` with the right contents.
- The trace shows the runtime owning the loop: native `llm.requested` /
  `llm.responded` (with cost) and `tool.requested` / `tool.responded` events.
- The handler materialized a `patch` object → the mirror derived the UI's
  `patch.applied` (path `hello.py`, +1 line) and a `model_call` summary.
- The projection **rebuilds byte-for-byte** from the native store.
- Demo mode: still completes with its 6 objects and `patch.proposed`.

### The auditability payoff

Because the runtime owns the loop and stamps provenance, ActiveGraph's own
`causal_chain()` renders the full lineage of a file edit:

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

This is the README's "show its work" claim made real: the LLM and tool calls are
framework events with `caused_by` provenance, so the chain is the framework's, not
a hand-built reconstruction.

## Notes / limitations

- The model is the configured provider's `default_model` (the behavior doesn't
  pin one); set it explicitly on `@llm_behavior(model=…)` if you need to.
- The `model_call` token summary is per-handler-invocation and approximate when
  a fix task triggers a second executor pass.
- The system prompt is carried as the behavior `description`; the task text
  reaches the model via the triggering event and the scoped view.
