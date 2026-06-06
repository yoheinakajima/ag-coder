#!/usr/bin/env python3
"""
AG Coder - ActiveGraph-powered coding agent.

Runs as a subprocess: python3 scripts/agent/run_agent.py --run-id <id> --goal "<goal>" [--work-dir <dir>]

The agent is genuinely event-driven: object creation emits events that wake
behaviors (goal -> plan/task -> execute -> test -> fix loop), and the
ActiveGraph runtime's own event stream is the single source of truth. A single
listener (PostgresMirror) is the ONLY writer of the Postgres tables the UI reads
(agent_events / graph_objects / graph_relations) — those rows are a byproduct of
the runtime trace, not a parallel hand-rolled log.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import traceback
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import psycopg2
import psycopg2.extras

# ── DB primitives ──────────────────────────────────────────────────────────────
# These are low-level Postgres helpers. During a run, the ONLY writer of the
# trace tables is PostgresMirror (below). The bare _insert_event / _next_seq
# helpers exist solely for the catastrophic-failure path in main(), where the
# runtime (and therefore the mirror) may never have been constructed.

DATABASE_URL = os.environ.get("DATABASE_URL", "")


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def _scoped(run_id: str, local_id: str) -> str:
    """Prefix a local graph ID with the run's short ID for global uniqueness.

    Graph object IDs from ActiveGraph look like ``task#2`` / ``plan#1``; run IDs
    are ULIDs (no ``:``), so the scoped form ``{run_id[:8]}:{local_id}`` splits
    back cleanly on the first ``:`` — which is exactly how the UI recovers the
    local id for replay matching.
    """
    return f"{run_id[:8]}:{local_id}"


def _next_seq(conn, run_id: str) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COALESCE(MAX(seq), 0) FROM agent_events WHERE run_id = %s", (run_id,))
        row = cur.fetchone()
    return int(row[0] or 0) + 1


def _insert_event(conn, run_id: str, event_type: str, seq: int, payload: dict) -> str:
    event_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO agent_events (id, run_id, type, seq, payload, created_at)
            VALUES (%s, %s, %s, %s, %s, NOW())
            ON CONFLICT (id) DO NOTHING
            """,
            (event_id, run_id, event_type, seq, json.dumps(payload, default=str)),
        )
    conn.commit()
    return event_id


def update_run_status(conn, run_id: str, status: str):
    with conn.cursor() as cur:
        if status in ("completed", "failed", "cancelled"):
            cur.execute(
                "UPDATE runs SET status = %s, completed_at = NOW() WHERE id = %s",
                (status, run_id),
            )
        else:
            cur.execute(
                "UPDATE runs SET status = %s WHERE id = %s",
                (status, run_id),
            )
    conn.commit()


def update_run_repo_branch(conn, run_id: str, branch: str):
    with conn.cursor() as cur:
        cur.execute("UPDATE runs SET repo_branch = %s WHERE id = %s", (branch, run_id))
    conn.commit()


# ── The native ActiveGraph event store (authoritative log) ──────────────────────
# Tier-1 of the "make this a true ActiveGraph showcase" work: rather than treating
# the hand-written PostgresMirror as the source of truth, we attach ActiveGraph's
# OWN PostgresEventStore to the graph. The runtime then persists every event it
# emits to that store automatically (Graph.emit -> store.append), giving us the
# framework's durable, schema-versioned, forkable, replayable event log for free.
#
# The store keeps its tables (events / runs / meta) in a dedicated Postgres schema
# so they never collide with the application's public.* tables — in particular the
# app already owns a `runs` table with a different shape. Everything still lives in
# one database (one DATABASE_URL); only the schema namespace differs.

NATIVE_STORE_SCHEMA = "activegraph"


def _open_native_store(run_id: str):
    """Open ActiveGraph's native PostgresEventStore in an isolated schema.

    Returns ``(store, conn)`` on success or ``(None, None)`` if the optional
    psycopg 3 / store dependency is missing or the connection fails. The native
    log is *additive* — a faithful, framework-owned copy of the run — so failing
    to open it must never break a run; the UI projection (PostgresMirror) still
    works on its own.
    """
    if not DATABASE_URL:
        return None, None
    try:
        import psycopg  # psycopg 3.x, required by PostgresEventStore
        from activegraph.store.postgres import PostgresEventStore
    except Exception:
        return None, None

    sconn = None
    try:
        # autocommit=True mirrors how PostgresEventStore manages a URL-owned
        # connection: each append() commits on its own.
        sconn = psycopg.connect(DATABASE_URL, autocommit=True)
        with sconn.cursor() as cur:
            cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{NATIVE_STORE_SCHEMA}"')
            # Pin the session to the store's schema so the store's
            # CREATE TABLE IF NOT EXISTS events/runs/meta land there and never
            # resolve to the app's public.runs.
            cur.execute(f'SET search_path TO "{NATIVE_STORE_SCHEMA}"')
        store = PostgresEventStore(sconn, run_id)  # runs _ensure_schema()
        return store, sconn
    except Exception:
        if sconn is not None:
            try:
                sconn.close()
            except Exception:
                pass
        return None, None


def _open_native_store_conn():
    """Open a psycopg 3 connection scoped to the native store's schema, or None."""
    if not DATABASE_URL:
        return None
    try:
        import psycopg
    except Exception:
        return None
    try:
        conn = psycopg.connect(DATABASE_URL, autocommit=True)
        with conn.cursor() as cur:
            cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{NATIVE_STORE_SCHEMA}"')
            cur.execute(f'SET search_path TO "{NATIVE_STORE_SCHEMA}"')
        return conn
    except Exception:
        return None


def _read_native_events(run_id: str) -> list:
    """Read a run's full native event log (for pre-populating replay caches)."""
    conn = _open_native_store_conn()
    if conn is None:
        return []
    try:
        from activegraph.store.postgres import PostgresEventStore
        store = PostgresEventStore(conn, run_id)
        return list(store.iter_events())
    except Exception:
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _resolve_native_event_id(app_conn, parent_run_id: str, ui_event_id: str) -> Optional[str]:
    """Map a UI event id (agent_events.id) to the framework's native event id.

    The mirror stamps ``_src_event_id`` (the native event id) into every
    projected event's payload; this reads it back so a fork can target the
    framework's authoritative log. If the value already looks like a native id
    (``evt_*``), it is used as-is.
    """
    if ui_event_id and ui_event_id.startswith("evt_"):
        return ui_event_id
    with app_conn.cursor() as cur:
        cur.execute(
            "SELECT payload->>'_src_event_id' FROM agent_events WHERE run_id = %s AND id = %s",
            (parent_run_id, ui_event_id),
        )
        row = cur.fetchone()
    return row[0] if row and row[0] else None


def _fork_native_log(new_run_id: str, parent_run_id: str, at_native_event_id: str,
                     label: Optional[str] = None):
    """Branch a run by copying the parent's native event log up to and including
    ``at_native_event_id`` into ``new_run_id`` — ActiveGraph's real fork
    primitive (``PostgresEventStore.fork_run``), the Postgres analogue of the
    SQLite-only ``Runtime.fork``.

    Returns ``(store, conn, copied_count)``; raises on failure (a fork that
    can't branch the lineage should fail loudly, unlike the additive store).
    """
    import psycopg  # noqa: F401 — ensure the dep is present before we promise a fork
    from activegraph.store.postgres import PostgresEventStore

    conn = _open_native_store_conn()
    if conn is None:
        raise RuntimeError("native PostgresEventStore unavailable — cannot fork")
    copied = PostgresEventStore.fork_run(
        conn,
        parent_run_id=parent_run_id,
        new_run_id=new_run_id,
        at_event_id=at_native_event_id,
        label=label,
        created_at=now_iso(),
    )
    store = PostgresEventStore(conn, new_run_id)
    return store, conn, copied


def _causal_chain_json(run_id: str, object_id: str) -> dict:
    """Compute ActiveGraph's native causal_chain for an object in a stored run.

    Replays the run's authoritative event log into a fresh Graph and calls the
    framework's ``causal_chain`` — the same provenance walk the runtime records,
    not the app's hand-built relations. Accepts a scoped (``<run8>:patch#3``) or
    local (``patch#3``) object id. Returns ``{run_id, object_id, chain}``.
    """
    conn = _open_native_store_conn()
    if conn is None:
        return {"error": "native event store unavailable", "run_id": run_id, "object_id": object_id}
    try:
        from activegraph import Graph
        from activegraph.store.postgres import PostgresEventStore
        from activegraph.trace.causal import causal_chain

        store = PostgresEventStore(conn, run_id)
        graph = Graph(run_id=run_id)
        n = 0
        for ev in store.iter_events():
            graph._replay_event(ev)  # noqa: SLF001 — framework replay seam
            n += 1
        if n == 0:
            return {"error": "no native event log for this run", "run_id": run_id, "object_id": object_id}
        local_id = object_id.split(":", 1)[1] if ":" in object_id else object_id
        return {"run_id": run_id, "object_id": local_id, "chain": causal_chain(graph, local_id)}
    except Exception as exc:  # pragma: no cover - defensive
        return {"error": str(exc), "run_id": run_id, "object_id": object_id}
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _clear_ui_rows(app_conn, run_id: str) -> None:
    with app_conn.cursor() as cur:
        cur.execute("DELETE FROM agent_events WHERE run_id = %s", (run_id,))
        cur.execute("DELETE FROM graph_objects WHERE run_id = %s", (run_id,))
        cur.execute("DELETE FROM graph_relations WHERE run_id = %s", (run_id,))
    app_conn.commit()


# ── The UI projection mirror ────────────────────────────────────────────────────


class PostgresMirror:
    """Projects the runtime's event stream into the UI's read-model tables.

    The AUTHORITATIVE log is ActiveGraph's own ``PostgresEventStore`` (attached
    to the graph via ``_open_native_store``); the runtime persists every event
    there automatically. This mirror is a *downstream projection* of that same
    stream into the denormalized tables the UI reads — ``agent_events`` /
    ``graph_objects`` / ``graph_relations`` — not a parallel, hand-maintained
    source of truth. Because the projection is a pure function of the event
    stream, the UI tables can be dropped and rebuilt from the native store at
    any time (see ``rebuild_ui_projection``), which is what makes replay and
    fork tractable.

    Subscribed via ``graph.add_listener``, ``project`` fires synchronously inside
    ``graph.emit`` for EVERY event the runtime produces, AFTER the event has been
    appended to the native log and applied to graph state. The same ``project``
    method is reused by ``rebuild_ui_projection`` to re-derive the tables from
    the stored log.

    Event handling:
      * ``object.created``  -> upsert graph_objects (scoped id) + emit an
        ``object.created`` agent_event carrying the UNSCOPED local id (the UI
        replay matches on that).
      * ``relation.created`` -> upsert graph_relations (scoped ids). No
        agent_event row: the UI renders edges from graph_relations, not the log.
      * framework ``patch.applied`` (object field update; identified by the
        ``patch``+``target`` payload keys) -> re-project the patched object and
        surface as ``object.patched`` so it never collides with the UI's
        file-patch view (which keys off ``patch.applied`` + ``payload.path``).
      * pure runtime bookkeeping (behavior.started/completed, runtime.*,
        pattern.*, approval.*, object/relation.removed) -> dropped from the
        stream.
      * everything else (assistant.message.added, tool.*, llm.*, file.*,
        bash.*, the domain ``patch.applied``, test.run.*, task.*, run.*,
        behavior.failed) -> written through verbatim.
    """

    _SUPPRESSED_EVENT_TYPES = frozenset(
        {
            "behavior.started",
            "behavior.completed",
            "relation_behavior.started",
            "relation_behavior.completed",
            "behavior.scheduled",
            "runtime.idle",
            "object.removed",
            "relation.removed",
        }
    )
    _SUPPRESSED_PREFIXES = ("pattern.", "runtime.", "approval.")

    def __init__(self, conn, run_id: str, graph) -> None:
        self._conn = conn
        self._run_id = run_id
        self._graph = graph
        self._seq = 0
        # The native event id currently being projected. Stamped into every
        # agent_events row so a UI-selected event can be mapped back to the
        # framework's authoritative event log (enables native fork — see
        # _resolve_native_event_id).
        self._src_event_id: Optional[str] = None

    # The listener entry point. Must never raise into graph.emit / the runtime
    # loop, so failures are caught and surfaced as a mirror.error event.
    def __call__(self, event) -> None:
        try:
            self.project(event)
        except Exception as exc:  # pragma: no cover - defensive
            try:
                self._record(
                    "mirror.error",
                    {"event_type": getattr(event, "type", "?"), "error": str(exc)},
                )
            except Exception:
                pass

    # ---- writers ----

    def _record(self, event_type: str, payload: dict) -> str:
        self._seq += 1
        event_id = str(uuid.uuid4())
        # Carry the source native event id so the UI/API can fork at this point
        # by mapping back to the framework's event log. Non-destructive: the UI
        # ignores unknown payload keys.
        if self._src_event_id is not None and "_src_event_id" not in payload:
            payload = {**payload, "_src_event_id": self._src_event_id}
        with self._conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO agent_events (id, run_id, type, seq, payload, created_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (id) DO NOTHING
                """,
                (event_id, self._run_id, event_type, self._seq, json.dumps(payload, default=str)),
            )
        self._conn.commit()
        return event_id

    def _upsert_object(self, scoped_id: str, obj_type: str, data: dict) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO graph_objects (id, run_id, object_type, data)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET run_id = EXCLUDED.run_id, data = EXCLUDED.data
                """,
                (scoped_id, self._run_id, obj_type, json.dumps(data, default=str)),
            )
        self._conn.commit()

    def _upsert_relation(self, scoped_id: str, scoped_source: str, scoped_target: str, rel_type: str) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO graph_relations (id, run_id, source, target, relation_type)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
                """,
                (scoped_id, self._run_id, scoped_source, scoped_target, rel_type),
            )
        self._conn.commit()

    # ---- dispatch ----

    def project(self, event) -> None:
        """Project a single runtime event into the UI read-model tables.

        Pure function of the event (plus current graph state, for framework
        field-patches) — the live listener and the ``rebuild_ui_projection``
        replay path both call this, so the projection is identical whether it
        runs live or is reconstructed from the native store.
        """
        self._src_event_id = getattr(event, "id", None)
        etype = event.type
        payload = event.payload or {}

        if etype == "object.created":
            obj = payload.get("object", {}) or {}
            local_id = obj.get("id")
            if local_id:
                obj_type = obj.get("type", "unknown")
                data = obj.get("data", {}) or {}
                self._upsert_object(self._scoped_id(local_id), obj_type, data)
                # UI replay matches payload.id (UNSCOPED) against the local part
                # of the scoped graph_objects id.
                self._record("object.created", {"type": obj_type, "id": local_id, "data": data})
                # Derive the UI's file-patch events from patch objects here, in
                # the mirror, instead of emitting them through the runtime.
                # patch.applied / patch.proposed are framework-RESERVED event
                # types (apply_event projects them and demands a full Patch
                # payload), so emitting our domain-shaped versions through
                # graph.emit crashes the projector. The patch object already
                # carries every field the UI needs, so we synthesize the domain
                # event from it.
                if obj_type == "patch":
                    self._derive_patch_event(local_id, data)
            return

        if etype == "relation.created":
            rel = payload.get("relation", {}) or {}
            rid, src, tgt = rel.get("id"), rel.get("source"), rel.get("target")
            if rid and src and tgt:
                self._upsert_relation(
                    self._scoped_id(rid),
                    self._scoped_id(src),
                    self._scoped_id(tgt),
                    rel.get("type", "REL"),
                )
            return

        # Framework field-patch (e.g. task status open -> in_progress). Identified
        # by the framework payload shape; re-project the object and surface under
        # a distinct type so it doesn't pollute the file-patch UI.
        if etype == "patch.applied" and "patch" in payload and "target" in payload:
            target = payload.get("target")
            obj = self._graph.get_object(target) if target else None
            if obj is not None:
                self._upsert_object(self._scoped_id(obj.id), obj.type, obj.data)
            self._record("object.patched", {"id": target, "changes": payload.get("diff", {})})
            return

        if etype in self._SUPPRESSED_EVENT_TYPES or etype.startswith(self._SUPPRESSED_PREFIXES):
            return

        # Domain + behavior.failed events pass straight through to the stream.
        self._record(etype, payload)

        # When the runtime owns the LLM turn loop (@llm_behavior), the assistant's
        # prose lives in llm.responded.raw_text, not in a domain
        # assistant.message.added. Derive the conversation message from it so the
        # UI's conversation panel stays populated without the behavior emitting
        # one by hand. (Demo mode emits assistant.message.added directly and has
        # no raw_text on its llm.responded, so this never double-counts.)
        if etype == "llm.responded":
            text = (payload.get("raw_text") or "").strip()
            if text:
                self._record("assistant.message.added", {"role": "assistant", "content": text})

    def _derive_patch_event(self, local_id: str, data: dict) -> None:
        """Synthesize the UI's file-patch event from a patch object's data.

        The patch_id carries the UNSCOPED local id; the UI scopes it itself when
        fetching patch detail.
        """
        status = data.get("status")
        if status == "applied" and data.get("path"):
            self._record("patch.applied", {
                "patch_id": local_id,
                "path": data.get("path"),
                "type": data.get("type"),
                "lines_added": data.get("lines_added", 0),
                "lines_removed": data.get("lines_removed", 0),
            })
        elif status == "proposed":
            self._record("patch.proposed", {
                "patch_id": local_id,
                "description": data.get("description", ""),
            })

    def _scoped_id(self, local_id: str) -> str:
        return _scoped(self._run_id, local_id)


def rebuild_ui_projection(app_conn, store, run_id: str) -> int:
    """Re-derive a run's UI tables purely from ActiveGraph's native event store.

    This is the concrete payoff of attaching the native store: the UI tables are
    a projection, so we can throw them away and reconstruct them byte-for-byte
    from the framework's authoritative log. Same mechanism a true fork/replay
    would use (``Runtime.load`` / ``Runtime.fork`` replay the log; this replays
    it through the UI projection).

    Replays the stored events into a fresh ``Graph`` (so the framework
    field-patch branch can read post-patch object state) and feeds each event
    through ``PostgresMirror.project``. Returns the number of events replayed.
    """
    from activegraph import Graph

    # Fresh graph carries object/relation state as we walk the log; it is NOT
    # persisted (we never attach a store to it) and fires no behaviors.
    graph = Graph()

    with app_conn.cursor() as cur:
        cur.execute("DELETE FROM agent_events WHERE run_id = %s", (run_id,))
        cur.execute("DELETE FROM graph_objects WHERE run_id = %s", (run_id,))
        cur.execute("DELETE FROM graph_relations WHERE run_id = %s", (run_id,))
    app_conn.commit()

    mirror = PostgresMirror(app_conn, run_id, graph)
    n = 0
    for ev in store.iter_events():
        graph._replay_event(ev)  # noqa: SLF001 — framework's blessed replay seam
        mirror.project(ev)
        n += 1
    return n


def _emit_event(graph, event_type: str, payload: dict, actor: str = "system"):
    """Emit a custom event on the raw graph from outside a behavior.

    Used by the procedural git phases and run lifecycle so they flow through the
    same single mirror as everything the runtime emits. ``graph.emit`` fires
    listeners synchronously regardless of whether the runtime loop is running.
    """
    from activegraph.core.event import Event

    event = Event(
        id=graph.ids.event(),
        type=event_type,
        payload=dict(payload),
        actor=actor,
        timestamp=graph.clock.now(),
    )
    graph.emit(event)
    return event


# ── Tool implementations ───────────────────────────────────────────────────────

PROTECTED_PATHS = [".env", ".git/", "node_modules/", "package-lock.json", ".secrets"]
DANGEROUS_COMMANDS = ["rm -rf", "sudo ", "chmod -R", "curl | sh", "curl | bash", "npm publish", "git push --force", "docker system prune", "> /dev/null 2>&1 &&"]


def is_protected(path: str) -> bool:
    for p in PROTECTED_PATHS:
        if path.startswith(p) or p in path:
            return True
    return False


def is_dangerous(command: str) -> Optional[str]:
    for d in DANGEROUS_COMMANDS:
        if d in command:
            return d
    return None


@dataclass
class ToolResult:
    ok: bool
    output: str
    error: Optional[str] = None


def tool_read(path: str, start_line: Optional[int] = None, end_line: Optional[int] = None, work_dir: str = ".") -> ToolResult:
    try:
        full_path = Path(work_dir) / path
        if not full_path.exists():
            return ToolResult(ok=False, output="", error=f"File not found: {path}")
        content = full_path.read_text(encoding="utf-8", errors="replace")
        lines = content.splitlines()
        if start_line is not None or end_line is not None:
            s = (start_line or 1) - 1
            e = end_line or len(lines)
            lines = lines[s:e]
            content = "\n".join(lines)
        return ToolResult(ok=True, output=content)
    except Exception as e:
        return ToolResult(ok=False, output="", error=str(e))


def tool_write(path: str, content: str, work_dir: str = ".") -> ToolResult:
    if is_protected(path):
        return ToolResult(ok=False, output="", error=f"Protected path: {path}")
    try:
        full_path = Path(work_dir) / path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content, encoding="utf-8")
        return ToolResult(ok=True, output=f"Written {len(content)} bytes to {path}")
    except Exception as e:
        return ToolResult(ok=False, output="", error=str(e))


def tool_edit(path: str, search: str, replace: str, work_dir: str = ".") -> ToolResult:
    if is_protected(path):
        return ToolResult(ok=False, output="", error=f"Protected path: {path}")
    try:
        full_path = Path(work_dir) / path
        if not full_path.exists():
            return ToolResult(ok=False, output="", error=f"File not found: {path}")
        content = full_path.read_text(encoding="utf-8", errors="replace")
        if search not in content:
            return ToolResult(ok=False, output="", error=f"Search string not found in {path}")
        new_content = content.replace(search, replace, 1)
        full_path.write_text(new_content, encoding="utf-8")
        return ToolResult(ok=True, output=f"Edited {path}")
    except Exception as e:
        return ToolResult(ok=False, output="", error=str(e))


def tool_bash(command: str, cwd: Optional[str] = None, timeout: int = 30) -> ToolResult:
    danger = is_dangerous(command)
    if danger:
        return ToolResult(ok=False, output="", error=f"Dangerous command blocked: {danger}")
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
        output = result.stdout + (("\n--- stderr ---\n" + result.stderr) if result.stderr.strip() else "")
        return ToolResult(ok=result.returncode == 0, output=output.strip(), error=result.stderr if result.returncode != 0 else None)
    except subprocess.TimeoutExpired:
        return ToolResult(ok=False, output="", error=f"Command timed out after {timeout}s")
    except Exception as e:
        return ToolResult(ok=False, output="", error=str(e))


# ── Git operations ─────────────────────────────────────────────────────────────

def _run_git_cmd(args: list[str], cwd: str, timeout: int = 120) -> ToolResult:
    """Run a git command directly (no safety filter — controlled internal use only)."""
    try:
        result = subprocess.run(
            ["git"] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
        output = (result.stdout + (("\n" + result.stderr) if result.stderr.strip() else "")).strip()
        return ToolResult(
            ok=result.returncode == 0,
            output=output,
            error=result.stderr.strip() if result.returncode != 0 else None,
        )
    except subprocess.TimeoutExpired:
        return ToolResult(ok=False, output="", error=f"git command timed out after {timeout}s")
    except Exception as e:
        return ToolResult(ok=False, output="", error=str(e))


def _git_clone_and_branch(run_id: str, repo_url: str, work_dir: str, conn, graph) -> tuple[str | None, bool]:
    """
    Clone the repo into work_dir (if not already cloned) and create the agent branch.
    Fork runs reuse the parent work_dir which already has .git — clone is skipped.
    Returns (branch_name, success). On failure, emits tool.error.

    All graph objects / events flow through ``graph`` so the single mirror is the
    only Postgres writer.
    """
    branch_name = f"agent/{run_id[:8]}"

    # ── Clone (skip if work_dir already has a .git — e.g. forked run) ─────────
    already_cloned = os.path.isdir(os.path.join(work_dir, ".git"))
    if not already_cloned:
        # Embed GITHUB_TOKEN into the clone URL for private repos. The
        # authenticated URL is NEVER passed to an event — only the public URL.
        github_token = os.environ.get("GITHUB_TOKEN", "")
        clone_url = repo_url
        if github_token and "github.com" in repo_url:
            clone_url = repo_url.replace(
                "https://github.com/",
                f"https://x-access-token:{github_token}@github.com/",
            )

        _emit_event(graph, "tool.called", {"tool": "git_clone", "input": {"repo_url": repo_url, "dir": "."}})
        clone_result = _run_git_cmd(["clone", clone_url, "."], cwd=work_dir, timeout=180)
        # Redact any token that might appear in git's output before storing in DB
        safe_output = clone_result.output.replace(github_token, "[REDACTED]") if github_token else clone_result.output
        safe_error = (clone_result.error or "").replace(github_token, "[REDACTED]") if github_token else (clone_result.error or "")
        _emit_event(graph, "tool.responded", {"tool": "git_clone", "output": safe_output[:1000], "ok": clone_result.ok})

        if not clone_result.ok:
            err = safe_error or "git clone failed"
            _emit_event(graph, "tool.error", {"tool": "git_clone", "error": err})
            return None, False
    else:
        # Fork reusing parent dir — fetch latest to get a clean base
        _emit_event(graph, "tool.called", {"tool": "git_fetch", "input": {"args": "--all"}})
        fetch_result = _run_git_cmd(["fetch", "--all"], cwd=work_dir, timeout=60)
        _emit_event(graph, "tool.responded", {"tool": "git_fetch", "output": fetch_result.output, "ok": fetch_result.ok})

    # ── Branch ─────────────────────────────────────────────────────────────────
    _emit_event(graph, "tool.called", {"tool": "git_branch", "input": {"branch": branch_name}})
    branch_result = _run_git_cmd(["checkout", "-b", branch_name], cwd=work_dir)
    _emit_event(graph, "tool.responded", {"tool": "git_branch", "output": branch_result.output, "ok": branch_result.ok})

    if not branch_result.ok:
        err = branch_result.error or "git checkout -b failed"
        _emit_event(graph, "tool.error", {"tool": "git_branch", "error": err})
        return None, False

    # Persist branch name to DB immediately (runs table, not the trace).
    update_run_repo_branch(conn, run_id, branch_name)

    # Graph node for the clone+branch operation (object.created -> mirror).
    graph.add_object("git_clone", {
        "repo_url": repo_url,
        "branch": branch_name,
        "already_cloned": already_cloned,
        "status": "completed",
    })

    return branch_name, True


def _git_commit(run_id: str, goal: str, branch_name: str, work_dir: str, conn, graph) -> bool:
    """
    Configure git identity and commit all changes to the local branch.

    The commit is NOT pushed from here. The API server reads this commit from
    the work dir and replays it to GitHub via the REST Git Data API (the Replit
    connector proxy never exposes a raw token, so HTTPS `git push` cannot
    authenticate). Returns True on success (including the no-changes case).
    """
    # ── Identity config ────────────────────────────────────────────────────────
    _run_git_cmd(["config", "user.email", "agent@agcode.local"], cwd=work_dir)
    _run_git_cmd(["config", "user.name", "AG Coder"], cwd=work_dir)

    # ── Check for changes ──────────────────────────────────────────────────────
    status_result = _run_git_cmd(["status", "--porcelain"], cwd=work_dir)
    if not status_result.output.strip():
        _emit_event(graph, "assistant.message.added", {
            "content": "No file changes detected — skipping git commit.",
            "role": "assistant",
        })
        return True

    # ── git add -A ─────────────────────────────────────────────────────────────
    _emit_event(graph, "tool.called", {"tool": "git_add", "input": {"args": "-A"}})
    add_result = _run_git_cmd(["add", "-A"], cwd=work_dir)
    _emit_event(graph, "tool.responded", {"tool": "git_add", "output": add_result.output, "ok": add_result.ok})

    if not add_result.ok:
        err = add_result.error or "git add -A failed"
        _emit_event(graph, "tool.error", {"tool": "git_add", "error": err})
        return False

    # ── git commit ─────────────────────────────────────────────────────────────
    commit_msg = f"[AG Coder] {goal}"
    _emit_event(graph, "tool.called", {"tool": "git_commit", "input": {"message": commit_msg}})
    commit_result = _run_git_cmd(["commit", "-m", commit_msg], cwd=work_dir)
    _emit_event(graph, "tool.responded", {"tool": "git_commit", "output": commit_result.output, "ok": commit_result.ok})

    if not commit_result.ok:
        err = commit_result.error or "git commit failed"
        _emit_event(graph, "tool.error", {"tool": "git_commit", "error": err})
        return False

    # Graph node for the commit operation (object.created -> mirror). The push to
    # the remote is recorded by the API server once it replays this commit.
    graph.add_object("git_commit", {
        "branch": branch_name,
        "message": commit_msg,
        "status": "committed",
    })

    return True


# ── Native ActiveGraph tools (@tool) ────────────────────────────────────────────
# In LLM mode the agent does NOT hand-roll the provider SDK loop. It registers
# these as first-class ActiveGraph Tools and lets the runtime own the turn loop:
# prompt assembly, llm.requested/responded, tool.requested/responded, schema
# validation, caching and replay all flow through the framework. The tool bodies
# are pure (path in, structured result out) so they're cacheable/replayable; the
# graph objects (patch / file_snapshot / command_result) are created afterwards
# by the @llm_behavior handler from the recorded tool events.

from pydantic import BaseModel  # noqa: E402 — hard dep via activegraph


class _ReadFileIn(BaseModel):
    path: str
    start_line: Optional[int] = None
    end_line: Optional[int] = None


class _ReadFileOut(BaseModel):
    ok: bool
    content: str = ""
    error: Optional[str] = None


class _WriteFileIn(BaseModel):
    path: str
    content: str


class _PatchOut(BaseModel):
    ok: bool
    path: str
    diff: str = ""
    lines_added: int = 0
    lines_removed: int = 0
    error: Optional[str] = None


class _EditFileIn(BaseModel):
    path: str
    search: str
    replace: str


class _BashIn(BaseModel):
    command: str
    timeout: int = 30


class _BashOut(BaseModel):
    ok: bool
    output: str = ""
    error: Optional[str] = None


def _diff_stats(before: str, after: str, path: str) -> tuple[str, int, int]:
    diff_lines = list(difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="",
    ))
    text = "\n".join(diff_lines)
    added = sum(1 for l in diff_lines if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in diff_lines if l.startswith("-") and not l.startswith("---"))
    return text, added, removed


def _build_tools(work_dir: str) -> list:
    """Build the ActiveGraph Tool objects bound to this run's work dir.

    Tools never raise on expected failures (missing file, blocked command):
    they return ``ok=False`` so the model can see the error and react, rather
    than failing the whole behavior.
    """
    from activegraph import tool

    @tool(name="read_file", description="Read the contents of a file.",
          input_schema=_ReadFileIn, output_schema=_ReadFileOut)
    def read_file(args: _ReadFileIn, ctx) -> _ReadFileOut:
        r = tool_read(args.path, args.start_line, args.end_line, work_dir)
        return _ReadFileOut(ok=r.ok, content=r.output if r.ok else "", error=r.error)

    @tool(name="write_file", description="Write content to a file, creating it if needed.",
          input_schema=_WriteFileIn, output_schema=_PatchOut)
    def write_file(args: _WriteFileIn, ctx) -> _PatchOut:
        full = Path(work_dir) / args.path
        before = full.read_text(encoding="utf-8", errors="replace") if full.is_file() else ""
        r = tool_write(args.path, args.content, work_dir)
        if not r.ok:
            return _PatchOut(ok=False, path=args.path, error=r.error)
        diff, added, removed = _diff_stats(before, args.content, args.path)
        return _PatchOut(ok=True, path=args.path, diff=diff, lines_added=added, lines_removed=removed)

    @tool(name="edit_file", description="Edit a file by replacing the first occurrence of a string.",
          input_schema=_EditFileIn, output_schema=_PatchOut)
    def edit_file(args: _EditFileIn, ctx) -> _PatchOut:
        full = Path(work_dir) / args.path
        before = full.read_text(encoding="utf-8", errors="replace") if full.is_file() else ""
        r = tool_edit(args.path, args.search, args.replace, work_dir)
        if not r.ok:
            return _PatchOut(ok=False, path=args.path, error=r.error)
        after = full.read_text(encoding="utf-8", errors="replace") if full.is_file() else before
        diff, added, removed = _diff_stats(before, after, args.path)
        return _PatchOut(ok=True, path=args.path, diff=diff, lines_added=added, lines_removed=removed)

    @tool(name="bash", description="Execute a shell command. Dangerous commands are blocked.",
          input_schema=_BashIn, output_schema=_BashOut)
    def bash(args: _BashIn, ctx) -> _BashOut:
        danger = is_dangerous(args.command)
        if danger:
            return _BashOut(ok=False, error=f"Blocked dangerous command: {danger}")
        r = tool_bash(args.command, work_dir, args.timeout)
        return _BashOut(ok=r.ok, output=r.output, error=r.error)

    return [read_file, write_file, edit_file, bash]


def _materialize_tool_objects(graph, bgraph, task_id) -> None:
    """Turn the tool/LLM events the runtime recorded during an @llm_behavior
    turn loop into the graph objects the UI renders.

    The runtime stamps this invocation's ``tool.requested`` event ids onto
    ``bgraph``; we pair each with its ``tool.responded`` and create the matching
    domain object (patch / file_snapshot / command_result), plus one model_call
    summarizing the LLM round-trips. BehaviorGraph auto-stamps provenance, so
    each object links back to the tool/LLM events for causal-chain walks.
    """
    tr_ids = list(getattr(bgraph, "_tool_request_event_ids", []) or [])
    by_id = {e.id: e for e in graph.events}
    resp_by_req = {
        e.caused_by: e
        for e in graph.events
        if e.type == "tool.responded" and e.caused_by in tr_ids
    }

    for tr_id in tr_ids:
        req = by_id.get(tr_id)
        if req is None:
            continue
        tool_name = req.payload.get("tool")
        args = req.payload.get("args") or {}
        resp = resp_by_req.get(tr_id)
        out = (resp.payload.get("output") if resp else None) or {}
        ok = bool(out.get("ok", True))

        if tool_name in ("write_file", "edit_file") and ok:
            patch = bgraph.add_object("patch", {
                "path": out.get("path") or args.get("path"),
                "type": "write" if tool_name == "write_file" else "edit",
                "status": "applied",
                "task_id": task_id,
                "diff": out.get("diff", ""),
                "lines_added": out.get("lines_added", 0),
                "lines_removed": out.get("lines_removed", 0),
            })
            bgraph.add_relation(task_id, patch.id, "TASK_HAS_PATCH")
        elif tool_name == "read_file" and ok:
            snap = bgraph.add_object("file_snapshot", {
                "path": args.get("path"),
                "content_preview": (out.get("content") or "")[:200],
                "task_id": task_id,
            })
            bgraph.add_relation(task_id, snap.id, "TASK_HAS_FILE_SNAPSHOT")
        elif tool_name == "bash":
            cmd = bgraph.add_object("command_result", {
                "command": args.get("command"),
                "ok": ok,
                "output_preview": (out.get("output") or "")[:300],
                "task_id": task_id,
            })
            bgraph.add_relation(task_id, cmd.id, "TASK_HAS_COMMAND_RESULT")

    # Summarize the LLM round-trips as a model_call node (UI continuity).
    model = None
    in_tok = out_tok = turns = 0
    for e in graph.events:
        if e.type == "llm.responded" and e.payload.get("behavior") == "task_executor":
            turns += 1
            model = e.payload.get("model", model)
            in_tok += int(e.payload.get("input_tokens", 0) or 0)
            out_tok += int(e.payload.get("output_tokens", 0) or 0)
    if turns:
        mc = bgraph.add_object("model_call", {
            "model": model or "?",
            "status": "completed",
            "task_id": task_id,
            "input_tokens": in_tok,
            "output_tokens": out_tok,
            "turns": turns,
        })
        bgraph.add_relation(task_id, mc.id, "TASK_HAS_MODEL_CALL")


# ── Event-driven ActiveGraph agent ──────────────────────────────────────────────

# How many automatic fix passes to attempt when tests fail. Bounds the
# test.run.completed(failed) -> task.ready fix loop so a persistently-red suite
# can't spin forever (the runtime budget is a second backstop).
MAX_FIX_ATTEMPTS = 1


def run_with_activegraph(run_id: str, goal: str, work_dir: str, conn,
                         repo_url: str | None = None,
                         fork_from: tuple[str, str] | None = None):
    """Run the coding agent using the ActiveGraph runtime, event-driven end to end.

    When ``fork_from=(parent_run_id, ui_event_id)`` is given, the run is a real
    ActiveGraph fork: the parent's native event log up to that event is copied
    into this run (shared lineage), replayed into the graph, and projected into
    the UI tables — then the agent continues forward on top of that inherited
    history, with the parent's LLM/tool responses pre-loaded into replay caches.
    """
    try:
        from activegraph import Graph, Runtime, behavior
        from activegraph.core.ids import IDGen
    except ImportError as e:
        raise RuntimeError(f"activegraph not installed: {e}")

    native_store = None
    native_store_conn = None
    replay_caches: dict[str, Any] = {}
    fork_lineage: tuple[str, str] | None = None

    # A real lineage fork requires the parent's native event log. If anything in
    # the branch fails (parent predates the native store, event not found, store
    # unavailable), degrade to a fresh continuation and note why — never fail the
    # run over an un-forkable parent.
    fork_degraded: tuple[str, str, str] | None = None
    graph = None
    if fork_from is not None:
        parent_run_id, ui_event_id = fork_from
        try:
            at_native = _resolve_native_event_id(conn, parent_run_id, ui_event_id)
            if at_native is None:
                raise RuntimeError("parent has no native lineage for this event")
            native_store, native_store_conn, copied = _fork_native_log(run_id, parent_run_id, at_native)
            fork_lineage = (parent_run_id, at_native)
            copied_events = list(native_store.iter_events())

            # Rebuild graph state from the copied prefix and continue from there.
            graph = Graph(ids=IDGen(), run_id=run_id)
            for ev in copied_events:
                graph._replay_event(ev)  # noqa: SLF001 — framework replay seam
            graph.ids.reseed_from_events(copied_events)
            graph.attach_store(native_store)

            # Project the inherited prefix into the UI tables through ONE mirror
            # so the seq counter stays monotonic when live events follow.
            mirror = PostgresMirror(conn, run_id, graph)
            _clear_ui_rows(conn, run_id)
            for ev in copied_events:
                mirror.project(ev)
            graph.add_listener(mirror)

            # Pre-load replay caches from the PARENT's full log so any identical
            # LLM/tool call on the fork serves from cache instead of re-spending.
            parent_events = _read_native_events(parent_run_id)
            try:
                from activegraph.llm.cache import LLMCache
                from activegraph.tools.cache import ToolCache
                replay_caches = dict(
                    replay_llm_cache=True,
                    llm_cache=LLMCache.from_events(parent_events),
                    replay_tool_cache=True,
                    tool_cache=ToolCache.from_events(parent_events),
                )
            except Exception:
                replay_caches = {}
        except Exception as exc:
            # Could not branch lineage — degrade to a fresh continuation.
            fork_degraded = (parent_run_id, ui_event_id, str(exc))
            fork_lineage = None
            replay_caches = {}
            graph = None
            if native_store_conn is not None:
                try:
                    native_store_conn.close()
                except Exception:
                    pass
            native_store = None
            native_store_conn = None

    if graph is None:
        # ── Fresh run: native store as authoritative log + UI projection ───────
        graph = Graph()
        native_store, native_store_conn = _open_native_store(run_id)
        if native_store is not None:
            graph.attach_store(native_store)
        mirror = PostgresMirror(conn, run_id, graph)
        graph.add_listener(mirror)
        if fork_degraded is not None:
            _emit_event(graph, "assistant.message.added", {
                "role": "assistant",
                "content": (
                    f"Note: parent run {fork_degraded[0]} has no native event log for "
                    f"event {fork_degraded[1]}, so this run could not inherit its lineage. "
                    f"Running as a fresh continuation instead."
                ),
            })

    # Check for an LLM provider; absent one, the agent runs the deterministic demo.
    has_anthropic = bool(os.environ.get("ANTHROPIC_API_KEY"))
    has_openai = bool(os.environ.get("OPENAI_API_KEY"))

    llm_provider = None
    if has_anthropic:
        try:
            from activegraph.llm import AnthropicProvider
            llm_provider = AnthropicProvider()
        except Exception:
            pass
    elif has_openai:
        try:
            from activegraph.llm import OpenAIProvider
            llm_provider = OpenAIProvider()
        except Exception:
            pass

    # ── Behaviors: goal -> plan/task -> execute -> test -> fix loop ───────────
    # Each object creation emits an event; behaviors react to events, never to
    # direct calls. The runtime chains them via its queue until idle.

    @behavior(name="goal_planner", on=["goal.created"])
    def goal_planner(event, bgraph, ctx):
        """Break the goal into a plan with one primary task, then arm it."""
        goal_text = event.payload.get("goal", "")

        plan = bgraph.add_object("plan", {
            "title": f"Plan: {goal_text[:80]}",
            "status": "active",
            "goal": goal_text,
        })
        task = bgraph.add_object("task", {
            "title": goal_text[:120],
            "description": goal_text,
            "status": "open",
            "plan_id": plan.id,
        })
        bgraph.add_relation(plan.id, task.id, "PLAN_HAS_TASK")

        bgraph.emit("task.created", {"task_id": task.id, "title": task.data["title"], "plan_id": plan.id})
        bgraph.emit("task.ready", {"task_id": task.id})

    @behavior(name="task_claimer", on=["task.ready"])
    def task_claimer(event, bgraph, ctx):
        """Mark a task in-progress before either executor runs."""
        task_id = event.payload.get("task_id")
        task_obj = bgraph.get_object(task_id)
        if task_obj is None:
            return
        description = task_obj.data.get("description", task_obj.data.get("title", ""))
        bgraph.emit("task.claimed", {"task_id": task_id, "description": description})
        bgraph.patch_object(task_id, {"status": "in_progress"})

    def _finish_task(bgraph, task_id):
        bgraph.patch_object(task_id, {"status": "completed"})
        bgraph.emit("task.completed", {"task_id": task_id})
        # Debounced hand-off: one signal per implementation pass wakes the
        # test_runner (rather than waking it on every individual patch).
        bgraph.emit("edits.completed", {"task_id": task_id})

    runtime_tools = None

    if llm_provider is None:
        # ── Demo executor: no provider, deterministic scripted trace ──────────
        @behavior(name="task_executor", on=["task.ready"])
        def task_executor(event, bgraph, ctx):
            task_id = event.payload.get("task_id")
            task_obj = bgraph.get_object(task_id)
            if task_obj is None:
                return
            description = task_obj.data.get("description", task_obj.data.get("title", ""))
            _run_demo_mode(bgraph, task_id, description, work_dir)
            _finish_task(bgraph, task_id)
    else:
        # ── LLM executor: the RUNTIME owns the turn loop (@llm_behavior). ──────
        # The framework assembles the prompt, calls the provider, drives the
        # read/write/edit/bash tool loop, validates I/O, and emits native
        # llm.* / tool.* events. Our handler runs once at the end and turns the
        # recorded tool events into the graph objects the UI renders.
        from activegraph import llm_behavior

        executor_tools = _build_tools(work_dir)
        runtime_tools = executor_tools

        system_prompt = (
            "You are AG Coder, a coding agent built on ActiveGraph. Complete the "
            "task described in the triggering event by editing files in the work "
            "directory.\n"
            "Rules:\n"
            "- Read a file before editing it.\n"
            "- Prefer focused edits over large rewrites; write working code.\n"
            "- Never touch: .env, .git/, node_modules/, package-lock.json.\n"
            "- Do NOT run git commands — commit/push is handled automatically "
            "after you finish. Just edit the files.\n"
            "- When the task is done, reply with a short summary of what you changed."
        )

        @llm_behavior(
            name="task_executor",
            on=["task.ready"],
            description=system_prompt,
            tools=executor_tools,
            max_tool_turns=12,
            max_tokens=4096,
            temperature=0,
        )
        def task_executor(event, bgraph, ctx, llm_output):
            """Runs AFTER the runtime's LLM+tool loop; materializes graph objects
            from the recorded tool events, then completes the task."""
            task_id = event.payload.get("task_id")
            _materialize_tool_objects(graph, bgraph, task_id)
            _finish_task(bgraph, task_id)

    @behavior(name="test_runner", on=["edits.completed"])
    def test_runner(event, bgraph, ctx):
        """React to a finished implementation pass by running the test suite."""
        task_id = event.payload.get("task_id")

        if llm_provider is None:
            # Demo mode performs no real edits, so there is nothing to verify.
            test_node = bgraph.add_object("test_run", {
                "status": "skipped",
                "reason": "Demo mode (no LLM key configured)",
                "task_id": task_id,
                "passed": 0,
                "failed": 0,
                "total": 0,
            })
            bgraph.add_relation(task_id, test_node.id, "TASK_HAS_TEST_RUN")
            bgraph.emit("test.run.completed", {
                "test_run_id": test_node.id,
                "task_id": task_id,
                "status": "skipped",
                "passed": 0,
                "failed": 0,
                "total": 0,
            })
            return

        test_files = tool_bash(
            "find . -name 'test_*.py' -o -name '*_test.py' -o -name '*.test.ts' -o -name '*.spec.ts' | head -5",
            cwd=work_dir,
        )
        if not (test_files.ok and test_files.output.strip()):
            # No tests to run → behavior chain goes idle and the run completes.
            return

        bgraph.emit("test.run.requested", {"test_files": test_files.output})
        is_pytest = "test_" in test_files.output or "_test" in test_files.output
        if is_pytest:
            # No pipe to head — preserve real exit code; truncate output in Python.
            test_result = tool_bash("python3 -m pytest -x --tb=short", cwd=work_dir, timeout=60)
        else:
            test_result = tool_bash("npx jest --passWithNoTests", cwd=work_dir, timeout=60)
        counts = _parse_test_output(test_result.output, "pytest" if is_pytest else "jest")
        status = "passed" if test_result.ok and counts["failed"] == 0 else "failed"

        test_node = bgraph.add_object("test_run", {
            "status": status,
            "output": test_result.output[:5000],
            "task_id": task_id,
            "passed": counts["passed"],
            "failed": counts["failed"],
            "total": counts["total"],
        })
        bgraph.add_relation(task_id, test_node.id, "TASK_HAS_TEST_RUN")
        bgraph.emit("test.run.completed", {
            "test_run_id": test_node.id,
            "task_id": task_id,
            "status": status,
            "passed": counts["passed"],
            "failed": counts["failed"],
            "total": counts["total"],
            "output": test_result.output[:5000],
        })

    @behavior(name="fix_planner", on=["test.run.completed"])
    def fix_planner(event, bgraph, ctx):
        """On a failing test run, spawn a bounded fix task to re-enter the loop."""
        if event.payload.get("status") != "failed":
            return

        prior_fixes = sum(1 for o in graph.objects(type="task") if o.data.get("is_fix"))
        if prior_fixes >= MAX_FIX_ATTEMPTS:
            bgraph.emit("assistant.message.added", {
                "role": "assistant",
                "content": (
                    f"Tests are still failing after {MAX_FIX_ATTEMPTS} automatic fix "
                    f"attempt(s); stopping the fix loop. Review the latest test_run for details."
                ),
            })
            return

        failing_output = event.payload.get("output", "")
        orig_task_id = event.payload.get("task_id")

        fix_task = bgraph.add_object("task", {
            "title": "Fix failing tests",
            "description": (
                "The previous changes left the test suite failing. Diagnose and fix "
                "the failures, then stop.\n\nFailing test output:\n" + failing_output[:2000]
            ),
            "status": "open",
            "is_fix": True,
        })
        if orig_task_id:
            bgraph.add_relation(orig_task_id, fix_task.id, "TASK_HAS_FIX")
        bgraph.emit("task.created", {"task_id": fix_task.id, "title": fix_task.data["title"]})
        bgraph.emit("task.ready", {"task_id": fix_task.id})

    # ── Frame: the run's mission context (goal + constraints + success criteria).
    # Attaching a Frame stamps frame_id provenance on every object/relation/event
    # the runtime creates, so the whole run is tagged with the mission it served.
    from activegraph import Frame
    frame = Frame(
        goal=goal,
        constraints=[
            "Never modify .env, .git/, node_modules/, or package-lock.json",
            "Do not run git commands — commit/push is handled after the run",
            "Prefer focused edits over large rewrites",
        ],
        success_criteria=[
            "The requested change is implemented",
            "Any project tests still pass",
        ],
    )

    # ── Budget: hard ceilings. max_cost_usd adds real token-based cost gating —
    # the runtime estimates each LLM call's cost before spending and stops the run
    # if it would exceed the ceiling (CONTRACT v0.6 #9). Configurable via env.
    budget = {"max_events": 500, "max_seconds": 300}
    try:
        _cost_cap = float(os.environ.get("AGENT_MAX_COST_USD", "1.00"))
        if _cost_cap > 0:
            budget["max_cost_usd"] = _cost_cap
    except (TypeError, ValueError):
        pass

    runtime = Runtime(graph, budget=budget, frame=frame, llm_provider=llm_provider,
                      tools=runtime_tools, **replay_caches)

    try:
        # ── Git: clone + branch before the task loop ──────────────────────────
        branch_name: str | None = None
        if repo_url:
            branch_name, ok = _git_clone_and_branch(run_id, repo_url, work_dir, conn, graph)
            if not ok:
                raise RuntimeError("git clone or branch creation failed — see tool.error events")

        if fork_lineage is not None:
            _emit_event(graph, "run.forked", {
                "run_id": run_id,
                "goal": goal,
                "parent_run_id": fork_lineage[0],
                "forked_at_event_id": fork_lineage[1],
            })
        else:
            _emit_event(graph, "run.started", {"run_id": run_id, "goal": goal})
        runtime.run_goal(goal)

        # run_goal's internal upsert_run nulls the fork lineage columns; re-assert
        # them so the native store records the parent linkage (CONTRACT v0.5 #11).
        if fork_lineage is not None and native_store is not None:
            try:
                native_store.upsert_run(
                    parent_run_id=fork_lineage[0],
                    forked_at_event_id=fork_lineage[1],
                    created_at=now_iso(),
                    goal=goal,
                )
            except Exception:
                pass

        # ── Git: commit changes locally after the task loop ───────────────────
        # The commit is pushed to the remote by the API server via the GitHub
        # REST API. A commit failure is logged via tool.error but does NOT fail
        # the run.
        if repo_url and branch_name:
            _git_commit(run_id, goal, branch_name, work_dir, conn, graph)

        _emit_event(graph, "run.completed", {"run_id": run_id})
    finally:
        # The native store owns its own connection; close it once the run ends.
        if native_store_conn is not None:
            try:
                native_store_conn.close()
            except Exception:
                pass


def _run_demo_mode(bgraph, task_id, task_description, work_dir):
    """Run without an LLM — a deterministic scenario producing a real trace."""
    bgraph.emit("assistant.message.added", {
        "content": f"I'll analyze the goal and work on it step by step.\n\nGoal: {task_description}\n\nStarting by reading relevant files...",
        "role": "assistant",
        "task_id": task_id,
    })

    # Snapshot the current directory.
    snap_result = tool_bash("find . -name '*.py' -o -name '*.ts' -o -name '*.js' | head -20", cwd=work_dir)
    bgraph.emit("tool.requested", {"tool": "bash", "input": {"command": "find . -name '*.py' -o -name '*.ts' | head -20"}})
    bgraph.emit("tool.responded", {"tool": "bash", "output": snap_result.output, "ok": snap_result.ok})

    snap = bgraph.add_object("file_snapshot", {
        "path": work_dir,
        "files": snap_result.output,
        "task_id": task_id,
    })
    bgraph.add_relation(task_id, snap.id, "TASK_HAS_FILE_SNAPSHOT")
    bgraph.emit("file.snapshot.created", {"snapshot_id": snap.id, "file_count": snap_result.output.count('\n')})

    model_call = bgraph.add_object("model_call", {
        "model": "demo",
        "prompt": task_description[:500],
        "status": "completed",
        "task_id": task_id,
    })
    bgraph.add_relation(task_id, model_call.id, "TASK_HAS_MODEL_CALL")
    bgraph.emit("llm.requested", {"model": "demo", "prompt_chars": len(task_description)})

    patch_content = (
        f"# Changes for: {task_description[:60]}\n"
        f"# Generated by AG Coder in demo mode\n"
        f"# (No LLM API key configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY for real AI responses)\n"
    )
    patch = bgraph.add_object("patch", {
        "description": f"Demo patch for: {task_description[:80]}",
        "content": patch_content,
        "status": "proposed",
        "task_id": task_id,
        "model_call_id": model_call.id,
    })
    bgraph.add_relation(model_call.id, patch.id, "MODEL_CALL_PRODUCED_PATCH")
    # The mirror derives the UI's patch.proposed event from this object.

    bgraph.emit("llm.responded", {
        "model": "demo",
        "response": "Demo mode: No LLM key configured. Add ANTHROPIC_API_KEY to enable real AI-powered coding.",
        "tokens": 0,
    })

    bgraph.emit("assistant.message.added", {
        "content": "**Demo mode complete.** The agent graph has been populated with the execution trace.\n\nTo enable real AI-powered coding:\n1. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your environment\n2. Submit a new goal\n\nThe graph on the left shows the causal structure of this run. Every node is traceable to the original goal.",
        "role": "assistant",
        "task_id": task_id,
    })


def _parse_test_output(output: str, framework: str) -> dict:
    """Extract passed/failed/total counts from pytest or jest output."""
    passed = 0
    failed = 0
    total = 0
    if framework == "pytest":
        m = re.search(r"(\d+) passed", output)
        if m:
            passed = int(m.group(1))
        m = re.search(r"(\d+) failed", output)
        if m:
            failed = int(m.group(1))
        m = re.search(r"(\d+) error", output)
        if m:
            failed += int(m.group(1))
        total = passed + failed
    elif framework == "jest":
        m = re.search(r"Tests:.*?(\d+) passed", output)
        if m:
            passed = int(m.group(1))
        m = re.search(r"Tests:.*?(\d+) failed", output)
        if m:
            failed = int(m.group(1))
        m = re.search(r"Tests:.*?(\d+) total", output)
        if m:
            total = int(m.group(1))
        if total == 0:
            total = passed + failed
    return {"passed": passed, "failed": failed, "total": total or (passed + failed)}


def main():
    parser = argparse.ArgumentParser(description="AG Coder runner")
    parser.add_argument("--run-id", required=True, help="Run ID")
    parser.add_argument("--goal", default=None, help="Agent goal (required unless --rebuild-projection)")
    parser.add_argument("--work-dir", default=".", help="Working directory")
    parser.add_argument("--repo-url", default=None, help="Optional GitHub repo URL to clone, branch, and PR")
    parser.add_argument(
        "--rebuild-projection",
        action="store_true",
        help=(
            "Don't run the agent: rebuild the UI projection tables for --run-id "
            "purely from ActiveGraph's native event store. Demonstrates that the "
            "UI tables are a derived view of the framework's authoritative log."
        ),
    )
    parser.add_argument(
        "--fork-from",
        default=None,
        help=(
            "Parent run id to fork from. Copies the parent's native event log up "
            "to --at-event into this run (shared lineage) and continues forward."
        ),
    )
    parser.add_argument(
        "--at-event",
        default=None,
        help="Event id (UI agent_events.id or native evt_*) to fork at. Requires --fork-from.",
    )
    parser.add_argument(
        "--causal-chain",
        default=None,
        metavar="OBJECT_ID",
        help=(
            "Don't run the agent: print (as JSON) ActiveGraph's own causal_chain "
            "for the given object in --run-id, walking provenance back through the "
            "tool/LLM calls to the goal. Accepts a scoped or local object id."
        ),
    )
    args = parser.parse_args()

    # ── Causal-chain mode: framework-native provenance walk for one object ─────
    if args.causal_chain:
        print(json.dumps(_causal_chain_json(args.run_id, args.causal_chain)))
        return

    # ── Rebuild mode: re-project an existing run from the native store ─────────
    if args.rebuild_projection:
        store, store_conn = _open_native_store(args.run_id)
        if store is None:
            print(
                "Cannot rebuild: native ActiveGraph PostgresEventStore is "
                "unavailable (missing psycopg 3 / activegraph[postgres], or no "
                "DATABASE_URL).",
                file=sys.stderr,
            )
            sys.exit(1)
        app_conn = get_conn()
        try:
            n = rebuild_ui_projection(app_conn, store, args.run_id)
            print(f"Rebuilt UI projection for run {args.run_id} from {n} stored events.")
        finally:
            app_conn.close()
            store_conn.close()
        return

    if not args.goal:
        parser.error("--goal is required unless --rebuild-projection is set")

    fork_from = None
    if args.fork_from or args.at_event:
        if not (args.fork_from and args.at_event):
            parser.error("--fork-from and --at-event must be provided together")
        fork_from = (args.fork_from, args.at_event)

    # Disable interactive git credential prompts. GIT_ASKPASS (Replit's
    # replit-git-askpass) has no TTY in a detached subprocess and would cause
    # local git operations (clone over public HTTPS, status, commit) to hang.
    # This agent never pushes — pushing is handled by the API server via the
    # GitHub REST API — so no credentials are needed here.
    os.environ.pop("GIT_ASKPASS", None)
    os.environ["GIT_TERMINAL_PROMPT"] = "0"

    conn = None
    try:
        conn = get_conn()
        update_run_status(conn, args.run_id, "running")

        run_with_activegraph(args.run_id, args.goal, args.work_dir, conn,
                             repo_url=args.repo_url, fork_from=fork_from)
        update_run_status(conn, args.run_id, "completed")

    except KeyboardInterrupt:
        if conn:
            try:
                update_run_status(conn, args.run_id, "cancelled")
            except Exception:
                pass
        sys.exit(0)
    except Exception as e:
        tb = traceback.format_exc()
        if conn:
            # Failure path: the runtime/mirror may never have started, so write
            # the terminal event directly. This is the ONLY non-mirror trace
            # write, reserved for catastrophic startup/runtime failure.
            try:
                _insert_event(conn, args.run_id, "run.failed", _next_seq(conn, args.run_id), {
                    "error": str(e),
                    "traceback": tb[-2000:],
                })
                update_run_status(conn, args.run_id, "failed")
            except Exception:
                pass
        print(f"Agent failed: {e}\n{tb}", file=sys.stderr)
        sys.exit(1)
    finally:
        if conn:
            conn.close()


if __name__ == "__main__":
    main()
