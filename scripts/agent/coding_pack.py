"""The AG Coder domain, packaged as an ActiveGraph Pack.

A Pack is the framework's unit for declaring a typed domain: object-type
schemas, relation-type constraints, and (pack-scoped) behaviors, bundled so the
runtime validates every object/relation created against the declared shapes.

Loading this pack (``runtime.load_pack(coding_pack)``) turns the coding agent's
graph into a *typed* graph — `graph.add_object("patch", …)` is validated against
`PatchSchema`, and `add_relation(task, patch, "TASK_HAS_PATCH")` is checked
against the declared endpoint types. It also contributes one pack behavior,
``verification_marker``, that fires via a Cypher-subset graph *pattern* rather
than a plain event subscription (CONTRACT v0.7 patterns).

Schemas use ``extra="allow"`` so the rich UI fields the agent attaches (diffs,
previews, token counts) pass through untouched — the pack adds type checking on
the declared fields without constraining the rest.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict

from activegraph.packs import ObjectType, Pack, RelationType
from activegraph.packs import behavior as pack_behavior


# ── Object schemas ───────────────────────────────────────────────────────────
# Only fields the agent always sets are declared (so validation never injects
# surprise nulls); everything else flows through via extra="allow".

class _Base(BaseModel):
    model_config = ConfigDict(extra="allow")


class PlanSchema(_Base):
    title: str
    status: str
    goal: Optional[str] = None


class TaskSchema(_Base):
    title: str
    description: Optional[str] = None
    status: str


class PatchSchema(_Base):
    status: str  # "applied" | "proposed"


class FileSnapshotSchema(_Base):
    path: str


class ModelCallSchema(_Base):
    model: str
    status: str


class CommandResultSchema(_Base):
    command: str
    ok: bool


class TestRunSchema(_Base):
    status: str  # passed | failed | skipped
    passed: int
    failed: int
    total: int


class GitOpSchema(_Base):
    status: str


OBJECT_TYPES = [
    ObjectType(name="plan", schema=PlanSchema, description="A plan derived from a goal."),
    ObjectType(name="task", schema=TaskSchema, description="A unit of work under a plan."),
    ObjectType(name="patch", schema=PatchSchema, description="A file change (applied or proposed)."),
    ObjectType(name="file_snapshot", schema=FileSnapshotSchema, description="A file read during a task."),
    ObjectType(name="model_call", schema=ModelCallSchema, description="An LLM round-trip summary."),
    ObjectType(name="command_result", schema=CommandResultSchema, description="A shell command result."),
    ObjectType(name="test_run", schema=TestRunSchema, description="A test-suite execution."),
    ObjectType(name="git_clone", schema=GitOpSchema, description="A clone/branch operation."),
    ObjectType(name="git_commit", schema=GitOpSchema, description="A local commit operation."),
]


# ── Relation constraints (endpoint object types) ─────────────────────────────

RELATION_TYPES = [
    RelationType(name="PLAN_HAS_TASK", source_types=("plan",), target_types=("task",),
                 description="A plan contains a task."),
    RelationType(name="TASK_HAS_PATCH", source_types=("task",), target_types=("patch",),
                 description="A task produced a patch."),
    RelationType(name="TASK_HAS_FILE_SNAPSHOT", source_types=("task",), target_types=("file_snapshot",),
                 description="A task read a file."),
    RelationType(name="TASK_HAS_MODEL_CALL", source_types=("task",), target_types=("model_call",),
                 description="A task made LLM calls."),
    RelationType(name="TASK_HAS_COMMAND_RESULT", source_types=("task",), target_types=("command_result",),
                 description="A task ran a command."),
    RelationType(name="TASK_HAS_TEST_RUN", source_types=("task",), target_types=("test_run",),
                 description="A task triggered a test run."),
    RelationType(name="TASK_HAS_FIX", source_types=("task",), target_types=("task",),
                 description="A task spawned a fix task."),
    RelationType(name="MODEL_CALL_PRODUCED_PATCH", source_types=("model_call",), target_types=("patch",),
                 description="A model call produced a patch."),
]


# ── A pattern-triggered pack behavior (CONTRACT v0.7 patterns) ───────────────
# Instead of subscribing to an event and re-deriving structure in Python, this
# behavior fires only when the graph actually contains the shape
# (task)-[:TASK_HAS_TEST_RUN]->(test_run) at the moment a test run completes.
# The runtime compiles the Cypher-subset pattern once at registration and
# matches it against live graph state (bindings arrive in ctx.matches).

@pack_behavior(
    name="verification_marker",
    on=["test.run.completed"],
    pattern="(t:task)-[:TASK_HAS_TEST_RUN]->(tr:test_run)",
)
def verification_marker(event, graph, ctx):
    """Record that a task's work was verified by a linked test run — fired by a
    graph pattern, not a bare event subscription."""
    graph.emit("verification.recorded", {
        "task_id": event.payload.get("task_id"),
        "test_run_id": event.payload.get("test_run_id"),
        "status": event.payload.get("status"),
        "matched_via": "pattern (task)-[:TASK_HAS_TEST_RUN]->(test_run)",
    })


coding_pack = Pack(
    name="ag_coder",
    version="1.0.0",
    description="The AG Coder coding-agent domain: typed plan/task/patch/test graph + a pattern behavior.",
    object_types=OBJECT_TYPES,
    relation_types=RELATION_TYPES,
    behaviors=[verification_marker],
)
