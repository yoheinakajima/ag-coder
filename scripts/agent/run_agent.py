#!/usr/bin/env python3
"""
AG Code Agent - ActiveGraph-powered coding agent.

Runs as a subprocess: python3 scripts/agent/run_agent.py --run-id <id> --goal "<goal>" [--work-dir <dir>]

Writes events to PostgreSQL as the agent executes.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import time
import traceback
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import psycopg2
import psycopg2.extras

# ── DB helpers ────────────────────────────────────────────────────────────────

DATABASE_URL = os.environ.get("DATABASE_URL", "")

def get_conn():
    return psycopg2.connect(DATABASE_URL)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def write_event(conn, run_id: str, event_type: str, seq: int, payload: dict):
    event_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO agent_events (id, run_id, type, seq, payload, created_at)
            VALUES (%s, %s, %s, %s, %s, NOW())
            ON CONFLICT (id) DO NOTHING
            """,
            (event_id, run_id, event_type, seq, json.dumps(payload)),
        )
    conn.commit()
    return event_id


def _scoped(run_id: str, local_id: str) -> str:
    """Prefix a local graph ID with the run's short ID for global uniqueness."""
    return f"{run_id[:8]}:{local_id}"


def write_graph_object(conn, run_id: str, local_id: str, obj_type: str, data: dict):
    db_id = _scoped(run_id, local_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO graph_objects (id, run_id, object_type, data)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET run_id = EXCLUDED.run_id, data = EXCLUDED.data
            """,
            (db_id, run_id, obj_type, json.dumps(data)),
        )
    conn.commit()


def write_graph_relation(conn, run_id: str, rel_id: str, source: str, target: str, rel_type: str):
    db_source = _scoped(run_id, source)
    db_target = _scoped(run_id, target)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO graph_relations (id, run_id, source, target, relation_type)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (id) DO NOTHING
            """,
            (rel_id, run_id, db_source, db_target, rel_type),
        )
    conn.commit()


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


def _git_clone_and_branch(
    run_id: str, repo_url: str, work_dir: str, conn, emit, graph
) -> tuple[str | None, bool]:
    """
    Clone the repo into work_dir (if not already cloned) and create the agent branch.
    Fork runs reuse the parent work_dir which already has .git — clone is skipped.
    Returns (branch_name, success). On failure, emits tool.error.
    """
    branch_name = f"agent/{run_id[:8]}"

    # ── Clone (skip if work_dir already has a .git — e.g. forked run) ─────────
    already_cloned = os.path.isdir(os.path.join(work_dir, ".git"))
    if not already_cloned:
        # Embed GITHUB_TOKEN into the clone URL for private repos (self-hosted /
        # CI / local). On Replit the public clone URL works for public repos;
        # private repos still require a token even on Replit because git clone
        # goes over HTTPS directly (not through the connector proxy).
        # The authenticated URL is NEVER passed to emit — only the public URL.
        github_token = os.environ.get("GITHUB_TOKEN", "")
        clone_url = repo_url
        if github_token and "github.com" in repo_url:
            clone_url = repo_url.replace(
                "https://github.com/",
                f"https://x-access-token:{github_token}@github.com/",
            )

        emit("tool.called", {"tool": "git_clone", "input": {"repo_url": repo_url, "dir": "."}})
        clone_result = _run_git_cmd(["clone", clone_url, "."], cwd=work_dir, timeout=180)
        # Redact any token that might appear in git's output before storing in DB
        safe_output = clone_result.output.replace(github_token, "[REDACTED]") if github_token else clone_result.output
        safe_error = (clone_result.error or "").replace(github_token, "[REDACTED]") if github_token else (clone_result.error or "")
        emit("tool.responded", {"tool": "git_clone", "output": safe_output[:1000], "ok": clone_result.ok})

        if not clone_result.ok:
            err = safe_error or "git clone failed"
            emit("tool.error", {"tool": "git_clone", "error": err})
            return None, False
    else:
        # Fork reusing parent dir — fetch latest to get a clean base
        emit("tool.called", {"tool": "git_fetch", "input": {"args": "--all"}})
        fetch_result = _run_git_cmd(["fetch", "--all"], cwd=work_dir, timeout=60)
        emit("tool.responded", {"tool": "git_fetch", "output": fetch_result.output, "ok": fetch_result.ok})

    # ── Branch ─────────────────────────────────────────────────────────────────
    emit("tool.called", {"tool": "git_branch", "input": {"branch": branch_name}})
    branch_result = _run_git_cmd(["checkout", "-b", branch_name], cwd=work_dir)
    emit("tool.responded", {"tool": "git_branch", "output": branch_result.output, "ok": branch_result.ok})

    if not branch_result.ok:
        err = branch_result.error or "git checkout -b failed"
        emit("tool.error", {"tool": "git_branch", "error": err})
        return None, False

    # Persist branch name to DB immediately
    update_run_repo_branch(conn, run_id, branch_name)

    # Graph node for the clone+branch operation
    clone_node = graph.add_object("git_clone", {
        "repo_url": repo_url,
        "branch": branch_name,
        "already_cloned": already_cloned,
        "status": "completed",
    })
    write_graph_object(conn, run_id, clone_node.id, "git_clone", clone_node.data)
    emit("object.created", {"type": "git_clone", "id": clone_node.id, "data": clone_node.data})

    return branch_name, True


def _git_commit(
    run_id: str, goal: str, branch_name: str, work_dir: str, conn, emit, graph
) -> bool:
    """
    Configure git identity and commit all changes to the local branch.

    The commit is NOT pushed from here. The API server reads this commit from
    the work dir and replays it to GitHub via the REST Git Data API (the Replit
    connector proxy never exposes a raw token, so HTTPS `git push` cannot
    authenticate). Returns True on success (including the no-changes case).
    """
    # ── Identity config ────────────────────────────────────────────────────────
    _run_git_cmd(["config", "user.email", "agent@agcode.local"], cwd=work_dir)
    _run_git_cmd(["config", "user.name", "AG Code Agent"], cwd=work_dir)

    # ── Check for changes ──────────────────────────────────────────────────────
    status_result = _run_git_cmd(["status", "--porcelain"], cwd=work_dir)
    if not status_result.output.strip():
        emit("assistant.message.added", {
            "content": "No file changes detected — skipping git commit.",
            "role": "assistant",
        })
        return True

    # ── git add -A ─────────────────────────────────────────────────────────────
    emit("tool.called", {"tool": "git_add", "input": {"args": "-A"}})
    add_result = _run_git_cmd(["add", "-A"], cwd=work_dir)
    emit("tool.responded", {"tool": "git_add", "output": add_result.output, "ok": add_result.ok})

    if not add_result.ok:
        err = add_result.error or "git add -A failed"
        emit("tool.error", {"tool": "git_add", "error": err})
        return False

    # ── git commit ─────────────────────────────────────────────────────────────
    commit_msg = f"[AG Code Agent] {goal}"
    emit("tool.called", {"tool": "git_commit", "input": {"message": commit_msg}})
    commit_result = _run_git_cmd(["commit", "-m", commit_msg], cwd=work_dir)
    emit("tool.responded", {"tool": "git_commit", "output": commit_result.output, "ok": commit_result.ok})

    if not commit_result.ok:
        err = commit_result.error or "git commit failed"
        emit("tool.error", {"tool": "git_commit", "error": err})
        return False

    # Graph node for the commit operation (the push to the remote is recorded by
    # the API server once it replays this commit via the GitHub API).
    commit_node = graph.add_object("git_commit", {
        "branch": branch_name,
        "message": commit_msg,
        "status": "committed",
    })
    write_graph_object(conn, run_id, commit_node.id, "git_commit", commit_node.data)
    emit("object.created", {"type": "git_commit", "id": commit_node.id, "data": commit_node.data})

    return True


# ── ActiveGraph-based agent ────────────────────────────────────────────────────

def run_with_activegraph(run_id: str, goal: str, work_dir: str, conn, repo_url: str | None = None):
    """Run the coding agent using ActiveGraph runtime."""
    try:
        from activegraph import Graph, Runtime, behavior, llm_behavior
        from activegraph.packs import behavior as pack_behavior
    except ImportError as e:
        raise RuntimeError(f"activegraph not installed: {e}")

    seq = [0]
    perm_requests: dict[str, dict] = {}

    def emit(event_type: str, payload: dict) -> str:
        seq[0] += 1
        eid = write_event(conn, run_id, event_type, seq[0], payload)
        return eid

    graph = Graph()
    
    # Check for LLM provider
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

    # ── Behaviors ────────────────────────────────────────────────────────────

    @behavior(name="goal_planner", on=["goal.created"])
    def goal_planner(event, graph, ctx):
        """Break goal into a plan with tasks."""
        goal_text = event.payload.get("goal", "")
        
        # Create plan node
        plan = graph.add_object("plan", {
            "title": f"Plan: {goal_text[:80]}",
            "status": "active",
            "goal": goal_text,
        })
        emit("object.created", {"type": "plan", "id": plan.id, "data": plan.data})
        write_graph_object(conn, run_id, plan.id, "plan", plan.data)
        
        # Create primary task node
        task = graph.add_object("task", {
            "title": goal_text[:120],
            "description": goal_text,
            "status": "open",
            "plan_id": plan.id,
        })
        emit("object.created", {"type": "task", "id": task.id, "data": task.data})
        write_graph_object(conn, run_id, task.id, "task", task.data)
        
        rel_id = str(uuid.uuid4())
        graph.add_relation(plan.id, task.id, "PLAN_HAS_TASK")
        write_graph_relation(conn, run_id, rel_id, plan.id, task.id, "PLAN_HAS_TASK")
        
        emit("task.created", {"task_id": task.id, "title": task.data["title"], "plan_id": plan.id})
        graph.emit("task.ready", {"task_id": task.id, "task": task})

    @behavior(name="task_executor", on=["task.ready"])
    def task_executor(event, graph, ctx):
        """Execute the task using available tools."""
        task_id = event.payload.get("task_id")
        task_obj = event.payload.get("task")
        if task_obj is None:
            return
        
        task_data = task_obj.data if hasattr(task_obj, 'data') else task_obj.get("data", {})
        task_description = task_data.get("description", task_data.get("title", ""))
        
        emit("task.claimed", {"task_id": task_id, "description": task_description})
        
        # Update task status
        graph.patch_object(task_id, {"status": "in_progress"})

        if llm_provider is None:
            # Demo mode: simulate agent actions
            _run_demo_mode(graph, ctx, run_id, task_id, task_description, work_dir, conn, emit, seq, repo_url)
        else:
            _run_llm_mode(graph, ctx, run_id, task_id, task_description, work_dir, conn, emit, seq, llm_provider, repo_url)
        
        # Mark task complete
        graph.patch_object(task_id, {"status": "completed"})
        emit("task.completed", {"task_id": task_id})

    budget = {"max_events": 500, "max_seconds": 300}
    runtime = Runtime(graph, budget=budget, llm_provider=llm_provider)

    # ── Git: clone + branch before the task loop ──────────────────────────────
    branch_name: str | None = None
    if repo_url:
        branch_name, ok = _git_clone_and_branch(run_id, repo_url, work_dir, conn, emit, graph)
        if not ok:
            raise RuntimeError("git clone or branch creation failed — see tool.error events")

    emit("run.started", {"run_id": run_id, "goal": goal})
    runtime.run_goal(goal)

    # Capture all events from the runtime trace
    try:
        trace_events = list(runtime.store.events()) if hasattr(runtime, 'store') and hasattr(runtime.store, 'events') else []
        for te in trace_events:
            te_type = getattr(te, 'type', None) or te.get('type', 'unknown')
            te_payload = getattr(te, 'payload', None) or te.get('payload', {}) or {}
            # Only emit framework-level events we haven't already emitted
            if te_type in ("llm.requested", "llm.responded", "tool.requested", "tool.responded",
                          "behavior.started", "behavior.completed", "behavior.failed",
                          "patch.proposed", "patch.applied", "patch.rejected"):
                emit(te_type, dict(te_payload) if te_payload else {})
    except Exception:
        pass

    # Sync any graph objects that ActiveGraph created internally
    try:
        objects = list(graph.objects()) if hasattr(graph, 'objects') else []
        for obj in objects:
            obj_id = getattr(obj, 'id', None) or obj.get('id', str(uuid.uuid4()))
            obj_type = getattr(obj, 'type', None) or obj.get('type', 'unknown')
            obj_data = getattr(obj, 'data', None) or obj.get('data', {}) or {}
            write_graph_object(conn, run_id, obj_id, obj_type, obj_data)
    except Exception as e:
        emit("warning", {"message": f"Could not sync graph state: {e}"})

    # ── Git: commit changes locally after the task loop ───────────────────────
    # The commit is pushed to the remote by the API server via the GitHub REST
    # API (the connector proxy never exposes a raw push token). A commit failure
    # is logged via tool.error but does NOT fail the run — the run still produced
    # a valid graph, and downstream push simply finds no agent commit.
    if repo_url and branch_name:
        _git_commit(run_id, goal, branch_name, work_dir, conn, emit, graph)

    emit("run.completed", {"run_id": run_id})


def _run_demo_mode(graph, ctx, run_id, task_id, task_description, work_dir, conn, emit, seq, repo_url: str | None = None):
    """Run without an LLM - simulates the agent flow with real tool calls."""
    
    emit("assistant.message.added", {
        "content": f"I'll analyze the goal and work on it step by step.\n\nGoal: {task_description}\n\nStarting by reading relevant files...",
        "role": "assistant",
        "task_id": task_id,
    })
    
    # Snapshot the current directory
    snap_result = tool_bash("find . -name '*.py' -o -name '*.ts' -o -name '*.js' | head -20", cwd=work_dir)
    
    emit("tool.requested", {"tool": "bash", "input": {"command": "find . -name '*.py' -o -name '*.ts' | head -20"}})
    emit("tool.responded", {"tool": "bash", "output": snap_result.output, "ok": snap_result.ok})

    # Create a file snapshot node
    snap = graph.add_object("file_snapshot", {
        "path": work_dir,
        "files": snap_result.output,
        "task_id": task_id,
    })
    snap_id = snap.id
    write_graph_object(conn, run_id, snap_id, "file_snapshot", snap.data)
    rel_id = str(uuid.uuid4())
    graph.add_relation(task_id, snap_id, "TASK_HAS_FILE_SNAPSHOT")
    write_graph_relation(conn, run_id, rel_id, task_id, snap_id, "TASK_HAS_FILE_SNAPSHOT")
    emit("file.snapshot.created", {"snapshot_id": snap_id, "file_count": snap_result.output.count('\n')})
    
    # Create a model call node
    model_call = graph.add_object("model_call", {
        "model": "demo",
        "prompt": task_description[:500],
        "status": "completed",
        "task_id": task_id,
    })
    write_graph_object(conn, run_id, model_call.id, "model_call", model_call.data)
    rel_id = str(uuid.uuid4())
    graph.add_relation(task_id, model_call.id, "TASK_HAS_MODEL_CALL")
    write_graph_relation(conn, run_id, rel_id, task_id, model_call.id, "TASK_HAS_MODEL_CALL")
    emit("llm.requested", {"model": "demo", "prompt_chars": len(task_description)})
    
    # Simulate a patch proposal
    patch_content = f"# Changes for: {task_description[:60]}\n# Generated by AG Code Agent in demo mode\n# (No LLM API key configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY for real AI responses)\n"
    
    patch = graph.add_object("patch", {
        "description": f"Demo patch for: {task_description[:80]}",
        "content": patch_content,
        "status": "proposed",
        "task_id": task_id,
        "model_call_id": model_call.id,
    })
    write_graph_object(conn, run_id, patch.id, "patch", patch.data)
    rel_id = str(uuid.uuid4())
    graph.add_relation(model_call.id, patch.id, "MODEL_CALL_PRODUCED_PATCH")
    write_graph_relation(conn, run_id, rel_id, model_call.id, patch.id, "MODEL_CALL_PRODUCED_PATCH")
    emit("patch.proposed", {"patch_id": patch.id, "description": patch.data["description"]})
    
    emit("llm.responded", {
        "model": "demo",
        "response": "Demo mode: No LLM key configured. Add ANTHROPIC_API_KEY to enable real AI-powered coding.",
        "tokens": 0,
    })
    
    # Simulate test run
    test_result = graph.add_object("test_run", {
        "status": "skipped",
        "reason": "Demo mode",
        "task_id": task_id,
        "patch_id": patch.id,
    })
    write_graph_object(conn, run_id, test_result.id, "test_run", test_result.data)
    rel_id = str(uuid.uuid4())
    graph.add_relation(task_id, test_result.id, "TASK_HAS_TEST_RUN")
    write_graph_relation(conn, run_id, rel_id, task_id, test_result.id, "TASK_HAS_TEST_RUN")
    emit("test.run.completed", {"test_run_id": test_result.id, "status": "skipped", "passed": 0, "failed": 0})
    
    # Final assistant message
    emit("assistant.message.added", {
        "content": "**Demo mode complete.** The agent graph has been populated with the execution trace.\n\nTo enable real AI-powered coding:\n1. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your environment\n2. Submit a new goal\n\nThe graph on the left shows the causal structure of this run. Every node is traceable to the original goal.",
        "role": "assistant",
        "task_id": task_id,
    })


def _execute_tool_call(graph, conn, run_id, task_id, tool_name, tool_input, work_dir, emit):
    """Execute a single tool call and record graph nodes. Returns (result, output_content)."""
    if tool_name == "read_file":
        result = tool_read(
            tool_input["path"],
            tool_input.get("start_line"),
            tool_input.get("end_line"),
            work_dir,
        )
        if result.ok:
            snap = graph.add_object("file_snapshot", {
                "path": tool_input["path"],
                "content_preview": result.output[:200],
                "task_id": task_id,
            })
            write_graph_object(conn, run_id, snap.id, "file_snapshot", snap.data)
            rel_id = str(uuid.uuid4())
            graph.add_relation(task_id, snap.id, "TASK_HAS_FILE_SNAPSHOT")
            write_graph_relation(conn, run_id, rel_id, task_id, snap.id, "TASK_HAS_FILE_SNAPSHOT")
            emit("file.snapshot.created", {"snapshot_id": snap.id, "path": tool_input["path"]})

    elif tool_name == "write_file":
        # Read existing content before overwriting so we can produce a real diff
        _before_content = ""
        _write_full_path = Path(work_dir) / tool_input["path"]
        if _write_full_path.is_file():
            try:
                _before_content = _write_full_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                _before_content = ""

        result = tool_write(tool_input["path"], tool_input["content"], work_dir)
        if result.ok:
            _after_content = tool_input["content"]
            _diff_lines = list(difflib.unified_diff(
                _before_content.splitlines(keepends=True),
                _after_content.splitlines(keepends=True),
                fromfile=f"a/{tool_input['path']}",
                tofile=f"b/{tool_input['path']}",
                lineterm="",
            ))
            _diff_text = "\n".join(_diff_lines)
            _lines_added = sum(1 for l in _diff_lines if l.startswith("+") and not l.startswith("+++"))
            _lines_removed = sum(1 for l in _diff_lines if l.startswith("-") and not l.startswith("---"))
            patch = graph.add_object("patch", {
                "path": tool_input["path"],
                "type": "write",
                "status": "applied",
                "task_id": task_id,
                "content_preview": tool_input["content"][:200],
                "diff": _diff_text,
                "lines_added": _lines_added,
                "lines_removed": _lines_removed,
            })
            write_graph_object(conn, run_id, patch.id, "patch", patch.data)
            rel_id = str(uuid.uuid4())
            graph.add_relation(task_id, patch.id, "TASK_HAS_PATCH")
            write_graph_relation(conn, run_id, rel_id, task_id, patch.id, "TASK_HAS_PATCH")
            emit("patch.applied", {
                "patch_id": patch.id, "path": tool_input["path"], "type": "write",
                "lines_added": _lines_added, "lines_removed": _lines_removed,
            })

    elif tool_name == "edit_file":
        # Read existing content before editing for a real diff
        _before_content = ""
        _edit_full_path = Path(work_dir) / tool_input["path"]
        if _edit_full_path.is_file():
            try:
                _before_content = _edit_full_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                _before_content = ""

        result = tool_edit(tool_input["path"], tool_input["search"], tool_input["replace"], work_dir)
        if result.ok:
            # Read the file again after the edit to get the real after-content
            _after_content = ""
            try:
                _after_content = _edit_full_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                _after_content = _before_content.replace(tool_input["search"], tool_input["replace"], 1)
            _diff_lines = list(difflib.unified_diff(
                _before_content.splitlines(keepends=True),
                _after_content.splitlines(keepends=True),
                fromfile=f"a/{tool_input['path']}",
                tofile=f"b/{tool_input['path']}",
                lineterm="",
            ))
            _diff_text = "\n".join(_diff_lines)
            _lines_added = sum(1 for l in _diff_lines if l.startswith("+") and not l.startswith("+++"))
            _lines_removed = sum(1 for l in _diff_lines if l.startswith("-") and not l.startswith("---"))
            patch = graph.add_object("patch", {
                "path": tool_input["path"],
                "type": "edit",
                "status": "applied",
                "search_preview": tool_input["search"][:100],
                "replace_preview": tool_input["replace"][:100],
                "task_id": task_id,
                "diff": _diff_text,
                "lines_added": _lines_added,
                "lines_removed": _lines_removed,
            })
            write_graph_object(conn, run_id, patch.id, "patch", patch.data)
            rel_id = str(uuid.uuid4())
            graph.add_relation(task_id, patch.id, "TASK_HAS_PATCH")
            write_graph_relation(conn, run_id, rel_id, task_id, patch.id, "TASK_HAS_PATCH")
            emit("patch.applied", {
                "patch_id": patch.id, "path": tool_input["path"], "type": "edit",
                "lines_added": _lines_added, "lines_removed": _lines_removed,
            })

    elif tool_name == "bash":
        danger = is_dangerous(tool_input["command"])
        if danger:
            emit("dangerous_command.detected", {"command": tool_input["command"], "matched": danger})
            result = ToolResult(ok=False, output="", error=f"Blocked: {danger}")
        else:
            result = tool_bash(tool_input["command"], work_dir, tool_input.get("timeout", 30))
            cmd_result = graph.add_object("command_result", {
                "command": tool_input["command"],
                "ok": result.ok,
                "output_preview": result.output[:300],
                "task_id": task_id,
            })
            write_graph_object(conn, run_id, cmd_result.id, "command_result", cmd_result.data)
            rel_id = str(uuid.uuid4())
            graph.add_relation(task_id, cmd_result.id, "TASK_HAS_COMMAND_RESULT")
            write_graph_relation(conn, run_id, rel_id, task_id, cmd_result.id, "TASK_HAS_COMMAND_RESULT")
            emit("bash.command.completed", {"ok": result.ok, "command": tool_input["command"]})
    else:
        result = ToolResult(ok=False, output="", error=f"Unknown tool: {tool_name}")

    output_content = result.output if result.ok else f"Error: {result.error}"
    emit("tool.responded", {"tool": tool_name, "ok": result.ok, "output": output_content[:500]})
    return output_content


# ── Tool schemas ───────────────────────────────────────────────────────────────

_TOOL_PROPS = {
    "read_file": {
        "description": "Read the contents of a file.",
        "properties": {
            "path": {"type": "string", "description": "File path relative to work directory"},
            "start_line": {"type": "integer", "description": "First line to read (1-indexed)"},
            "end_line": {"type": "integer", "description": "Last line to read (inclusive)"},
        },
        "required": ["path"],
    },
    "write_file": {
        "description": "Write content to a file, creating it if needed.",
        "properties": {
            "path": {"type": "string", "description": "File path relative to work directory"},
            "content": {"type": "string", "description": "Full file content to write"},
        },
        "required": ["path", "content"],
    },
    "edit_file": {
        "description": "Edit a file by replacing the first occurrence of a string.",
        "properties": {
            "path": {"type": "string", "description": "File path relative to work directory"},
            "search": {"type": "string", "description": "Exact string to find"},
            "replace": {"type": "string", "description": "Replacement string"},
        },
        "required": ["path", "search", "replace"],
    },
    "bash": {
        "description": "Execute a shell command. Dangerous commands are blocked.",
        "properties": {
            "command": {"type": "string", "description": "Shell command to run"},
            "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"},
        },
        "required": ["command"],
    },
}

def _anthropic_tools():
    return [
        {"name": name, "description": spec["description"],
         "input_schema": {"type": "object", "properties": spec["properties"], "required": spec["required"]}}
        for name, spec in _TOOL_PROPS.items()
    ]

def _openai_tools():
    return [
        {"type": "function", "function": {
            "name": name,
            "description": spec["description"],
            "parameters": {"type": "object", "properties": spec["properties"], "required": spec["required"]},
        }}
        for name, spec in _TOOL_PROPS.items()
    ]


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


def _run_llm_mode(graph, ctx, run_id, task_id, task_description, work_dir, conn, emit, seq, llm_provider, repo_url: str | None = None):
    """Run with a real LLM. Auto-selects Anthropic or OpenAI based on available keys."""
    use_openai = bool(os.environ.get("OPENAI_API_KEY")) and not bool(os.environ.get("ANTHROPIC_API_KEY"))

    system_prompt = (
        f"You are AG Code Agent, a coding agent powered by ActiveGraph.\n"
        f"Work directory: {work_dir}\n\n"
        f"Rules:\n"
        f"- Read files before editing them\n"
        f"- Write working, tested code\n"
        f"- Run tests after making changes\n"
        f"- Be concise — focused changes over large rewrites\n"
        f"- Never touch: .env, .git/, node_modules/, package-lock.json\n"
        f"- Do NOT run any git commands (commit, push, branch, etc.) — committing "
        f"your changes and pushing to GitHub is handled automatically after you "
        f"finish. Just edit the files.\n\n"
        f"Task: {task_description}"
    )

    emit("assistant.message.added", {"role": "system", "content": system_prompt, "task_id": task_id})

    if use_openai:
        _run_openai_loop(graph, conn, run_id, task_id, task_description, work_dir, emit, system_prompt)
    else:
        _run_anthropic_loop(graph, conn, run_id, task_id, task_description, work_dir, emit, system_prompt)

    # Run tests if any test files exist
    test_files = tool_bash(
        "find . -name 'test_*.py' -o -name '*_test.py' -o -name '*.test.ts' -o -name '*.spec.ts' | head -5",
        cwd=work_dir,
    )
    if test_files.ok and test_files.output.strip():
        emit("test.run.requested", {"test_files": test_files.output})
        is_pytest = "test_" in test_files.output or "_test" in test_files.output
        if is_pytest:
            # No pipe to head — preserve real exit code; truncate output in Python
            test_result = tool_bash("python3 -m pytest -x --tb=short", cwd=work_dir, timeout=60)
        else:
            test_result = tool_bash("npx jest --passWithNoTests", cwd=work_dir, timeout=60)
        counts = _parse_test_output(test_result.output, "pytest" if is_pytest else "jest")
        status = "passed" if test_result.ok and counts["failed"] == 0 else "failed"
        test_node = graph.add_object("test_run", {
            "status": status,
            "output": test_result.output[:5000],
            "task_id": task_id,
            "passed": counts["passed"],
            "failed": counts["failed"],
            "total": counts["total"],
        })
        write_graph_object(conn, run_id, test_node.id, "test_run", test_node.data)
        rel_id = str(uuid.uuid4())
        graph.add_relation(task_id, test_node.id, "TASK_HAS_TEST_RUN")
        write_graph_relation(conn, run_id, rel_id, task_id, test_node.id, "TASK_HAS_TEST_RUN")
        emit("test.run.completed", {
            "test_run_id": test_node.id,
            "status": status,
            "passed": counts["passed"],
            "failed": counts["failed"],
            "total": counts["total"],
            "output": test_result.output[:5000],
        })


def _run_anthropic_loop(graph, conn, run_id, task_id, task_description, work_dir, emit, system_prompt):
    import anthropic
    client = anthropic.Anthropic()
    model = "claude-3-5-haiku-20241022"
    tools = _anthropic_tools()
    messages = [{"role": "user", "content": task_description}]

    for i in range(10):
        emit("llm.requested", {"model": model, "iteration": i + 1, "messages": len(messages)})
        try:
            response = client.messages.create(
                model=model, max_tokens=8192, system=system_prompt,
                tools=tools, messages=messages,
            )
        except Exception as e:
            emit("behavior.failed", {"error": str(e), "behavior": "llm_call"})
            break

        emit("llm.responded", {
            "model": model, "stop_reason": response.stop_reason,
            "input_tokens": response.usage.input_tokens, "output_tokens": response.usage.output_tokens,
        })

        tool_calls_this_turn = []
        text_parts = []
        for block in response.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                tool_calls_this_turn.append(block)

        if text_parts:
            emit("assistant.message.added", {"role": "assistant", "content": "\n".join(text_parts), "task_id": task_id})

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn" or not tool_calls_this_turn:
            break

        tool_results = []
        for tc in tool_calls_this_turn:
            emit("tool.requested", {"tool": tc.name, "input": tc.input, "task_id": task_id})
            out = _execute_tool_call(graph, conn, run_id, task_id, tc.name, tc.input, work_dir, emit)
            tool_results.append({"type": "tool_result", "tool_use_id": tc.id, "content": out})
        messages.append({"role": "user", "content": tool_results})


def _run_openai_loop(graph, conn, run_id, task_id, task_description, work_dir, emit, system_prompt):
    from openai import OpenAI
    client = OpenAI()
    model = "gpt-4o-mini"
    tools = _openai_tools()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": task_description},
    ]

    for i in range(10):
        emit("llm.requested", {"model": model, "iteration": i + 1, "messages": len(messages)})
        try:
            response = client.chat.completions.create(
                model=model, tools=tools, messages=messages,
                tool_choice="auto", max_tokens=8192,
            )
        except Exception as e:
            emit("behavior.failed", {"error": str(e), "behavior": "llm_call"})
            break

        msg = response.choices[0].message
        finish = response.choices[0].finish_reason
        emit("llm.responded", {
            "model": model, "stop_reason": finish,
            "input_tokens": response.usage.prompt_tokens,
            "output_tokens": response.usage.completion_tokens,
        })

        if msg.content:
            emit("assistant.message.added", {"role": "assistant", "content": msg.content, "task_id": task_id})

        messages.append(msg)

        if finish == "stop" or not msg.tool_calls:
            break

        tool_results = []
        for tc in msg.tool_calls:
            import json as _json
            tool_input = _json.loads(tc.function.arguments)
            emit("tool.requested", {"tool": tc.function.name, "input": tool_input, "task_id": task_id})
            out = _execute_tool_call(graph, conn, run_id, task_id, tc.function.name, tool_input, work_dir, emit)
            tool_results.append({"role": "tool", "tool_call_id": tc.id, "content": out})
        messages.extend(tool_results)
    
    # Run tests if any test files exist
    test_files = tool_bash("find . -name 'test_*.py' -o -name '*_test.py' -o -name '*.test.ts' -o -name '*.spec.ts' | head -5", cwd=work_dir)
    if test_files.ok and test_files.output.strip():
        emit("test.run.requested", {"test_files": test_files.output})
        if "test_" in test_files.output or "_test" in test_files.output:
            test_result = tool_bash("python3 -m pytest -x --tb=short 2>&1 | head -50", cwd=work_dir, timeout=60)
        else:
            test_result = tool_bash("npx jest --passWithNoTests 2>&1 | head -50", cwd=work_dir, timeout=60)
        
        test_node = graph.add_object("test_run", {
            "status": "passed" if test_result.ok else "failed",
            "output": test_result.output[:500],
            "task_id": task_id,
        })
        write_graph_object(conn, run_id, test_node.id, "test_run", test_node.data)
        emit("test.run.completed", {
            "test_run_id": test_node.id,
            "status": "passed" if test_result.ok else "failed",
            "output_preview": test_result.output[:200],
        })


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="AG Code Agent runner")
    parser.add_argument("--run-id", required=True, help="Run ID")
    parser.add_argument("--goal", required=True, help="Agent goal")
    parser.add_argument("--work-dir", default=".", help="Working directory")
    parser.add_argument("--repo-url", default=None, help="Optional GitHub repo URL to clone, branch, and PR")
    args = parser.parse_args()

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
        
        run_with_activegraph(args.run_id, args.goal, args.work_dir, conn, repo_url=args.repo_url)
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
            try:
                write_event(conn, args.run_id, "run.failed", 9999, {
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
