import { Router } from "express";
import { eq, desc, count, inArray, sql } from "drizzle-orm";
import { spawn, exec, execFile } from "child_process";
import { promisify } from "util";
import { mkdirSync, readdirSync, readFileSync, statSync, existsSync } from "fs";

import path from "path";
import { v4 as uuidv4 } from "uuid";

import {
  db,
  runsTable,
  agentEventsTable,
  graphObjectsTable,
  graphRelationsTable,
  agentApprovalsTable,
} from "@workspace/db";
import {
  pushBranchViaApi,
  createPullRequest,
  getPullRequestStatus,
  getGitHubAccessToken,
} from "../github-client.js";
import { isValidRepoUrl } from "../lib/validate.js";
import { runCreateRateLimiter } from "../middlewares/rate-limit.js";

import {
  CreateRunBody,
  GetRunParams,
  CancelRunParams,
  GetRunEventsParams,
  GetRunGraphParams,
  ForkRunParams,
  ForkRunBody,
  DiffRunsParams,
  ResolvePermissionParams,
  ResolvePermissionBody,
} from "@workspace/api-zod";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const router = Router();

// ── Fire-and-forget: refresh PR status for runs with non-terminal prStatus ────
type AnyLogger = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

async function createPrAfterRun(runId: string, log: AnyLogger): Promise<void> {
  // Small delay to ensure the agent subprocess has committed its final DB write
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    const runs = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
    const run = runs[0];
    if (!run || run.status !== "completed" || !run.repoBranch || !run.repoUrl || run.prUrl) return;

    // Push the agent's commit to GitHub via the REST Git Data API (routed through
    // the connector proxy — no raw token needed). Must happen before the PR is
    // opened so the head branch exists on the remote.
    if (!run.workDir) {
      log.warn({ runId }, "run has no workDir — cannot push branch, skipping PR");
      return;
    }
    const pushResult = await pushBranchViaApi({
      repoUrl: run.repoUrl,
      branch: run.repoBranch,
      workDir: run.workDir,
      goal: run.goal,
    }).catch((err) => ({ ok: false as const, reason: String(err) }));
    if (!pushResult.ok) {
      throw new Error(`branch push failed: ${pushResult.reason ?? "unknown"}`);
    }
    log.info({ runId, branch: run.repoBranch }, "branch pushed via GitHub API");

    const prUrl = await createPullRequest({
      repoUrl: run.repoUrl,
      head: run.repoBranch,
      goal: run.goal,
      runId: run.id,
    });

    if (prUrl) {
      await db.update(runsTable).set({ prUrl, prStatus: "open" }).where(eq(runsTable.id, runId));
      log.info({ runId, prUrl }, "PR created");
    }
  } catch (err) {
    log.warn({ runId, err: String(err) }, "PR creation failed (non-fatal)");
    // Emit a warning event so the run-detail event stream surfaces the failure
    try {
      const seqRows = await db
        .select({ maxSeq: sql<number>`MAX(seq)` })
        .from(agentEventsTable)
        .where(eq(agentEventsTable.runId, runId));
      const nextSeq = Number(seqRows[0]?.maxSeq ?? 0) + 1;
      await db.insert(agentEventsTable).values({
        id: uuidv4(),
        runId,
        type: "warning",
        seq: nextSeq,
        payload: { message: `PR creation failed: ${String(err).slice(0, 300)}` },
        createdAt: new Date(),
      });
    } catch {
      /* swallow */
    }
  }
}

// ── Fire-and-forget: refresh prStatus for a run with a non-terminal PR ───────

async function refreshPrStatusIfNeeded(
  run: { id: string; repoUrl: string | null; prUrl: string | null; prStatus: string | null },
  log: AnyLogger,
): Promise<void> {
  if (!run.prUrl || !run.repoUrl) return;
  if (run.prStatus === "merged" || run.prStatus === "closed") return;
  try {
    const status = await getPullRequestStatus(run.repoUrl, run.prUrl);
    if (status && status !== run.prStatus) {
      await db.update(runsTable).set({ prStatus: status }).where(eq(runsTable.id, run.id));
      log.info({ runId: run.id, prStatus: status }, "PR status refreshed");
    }
  } catch (err) {
    log.warn({ runId: run.id, err: String(err) }, "PR status refresh failed (non-fatal)");
  }
}

// ── Run-scoped file browser helpers ──────────────────────────────────────────

const RUN_FILE_IGNORED = new Set(["node_modules", ".git", "dist", ".cache", "__pycache__"]);

function buildRunFileTree(dirPath: string, rootPath: string, depth = 0): object[] {
  if (depth > 4) return [];
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: object[] = [];
  for (const entry of entries) {
    if (RUN_FILE_IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(rootPath, fullPath);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: relPath,
        type: "directory",
        size: null,
        children: buildRunFileTree(fullPath, rootPath, depth + 1),
      });
    } else {
      const stat = statSync(fullPath);
      result.push({
        name: entry.name,
        path: relPath,
        type: "file",
        size: stat.size,
        children: null,
      });
    }
  }
  return result.sort((a: any, b: any) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function detectRunFileLanguage(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".py": "python",
    ".md": "markdown",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".sh": "bash",
    ".css": "css",
    ".html": "html",
    ".sql": "sql",
    ".toml": "toml",
    ".txt": "text",
    ".env": "dotenv",
  };
  return map[ext] ?? null;
}

// List all runs
router.get("/runs", async (req, res) => {
  const runs = await db.select().from(runsTable).orderBy(desc(runsTable.createdAt)).limit(100);

  const runIds = runs.map((r) => r.id);
  const eventCounts = runIds.length
    ? await db
        .select({ runId: agentEventsTable.runId, cnt: count() })
        .from(agentEventsTable)
        .where(inArray(agentEventsTable.runId, runIds))
        .groupBy(agentEventsTable.runId)
    : [];

  const countMap = Object.fromEntries(eventCounts.map((r) => [r.runId, Number(r.cnt)]));

  // Fire-and-forget: refresh prStatus for runs with open/unknown PR status
  const log = req.log;
  for (const r of runs) {
    if (r.prUrl && r.repoUrl && r.prStatus !== "merged" && r.prStatus !== "closed") {
      void refreshPrStatusIfNeeded(r, log);
    }
  }

  return res.json(
    runs.map((r) => ({
      ...r,
      eventCount: countMap[r.id] ?? 0,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
  );
});

// Create run
router.post("/runs", runCreateRateLimiter, async (req, res) => {
  const parsed = CreateRunBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }
  const { goal, model, repoUrl, requireApproval } = parsed.data;
  if (repoUrl && !isValidRepoUrl(repoUrl)) {
    return res.status(400).json({ error: "repoUrl must be an https github.com owner/repo URL" });
  }
  const runId = uuidv4();

  // The server runs from artifacts/api-server/ so navigate up to the workspace root
  const workspaceRoot = path.resolve(process.cwd(), "../..");
  // Always derive an isolated, server-controlled work directory per run. The
  // caller never supplies a path, so it can't escape the runs/ root.
  const resolvedWorkDir = path.join(workspaceRoot, "runs", runId);
  mkdirSync(resolvedWorkDir, { recursive: true });

  await db.insert(runsTable).values({
    id: runId,
    goal,
    status: "pending",
    model: model ?? null,
    workDir: resolvedWorkDir,
    repoUrl: repoUrl ?? null,
    requireApproval: requireApproval ?? false,
    createdAt: new Date(),
  });

  const agentScript = path.join(workspaceRoot, "scripts/agent/run_agent.py");

  const agentArgs = ["--run-id", runId, "--goal", goal, "--work-dir", resolvedWorkDir];
  if (repoUrl) agentArgs.push("--repo-url", repoUrl);
  if (requireApproval) agentArgs.push("--require-approval");

  const agentEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Disable interactive git credential prompts so the agent's local clone/commit
  // never blocks on a TTY. Pushing to the remote is handled in Node via the
  // GitHub REST API (see pushBranchViaApi) — no git credentials are needed here.
  delete agentEnv["GIT_ASKPASS"];
  agentEnv["GIT_TERMINAL_PROMPT"] = "0";
  // For private-repo clones the agent needs a real OAuth token (the connector
  // proxy never hands the token to git). Resolve it from the connector/env and
  // pass it through as GITHUB_TOKEN; the agent embeds it in the clone URL.
  if (repoUrl) {
    const token = await getGitHubAccessToken();
    if (token) agentEnv["GITHUB_TOKEN"] = token;
  }

  const child = spawn("python3", [agentScript, ...agentArgs], {
    env: agentEnv,
    cwd: workspaceRoot,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // After agent exits, attempt PR creation (fire-and-forget, non-fatal)
  const log = req.log;
  child.on("exit", () => {
    void createPrAfterRun(runId, log);
  });
  child.unref();

  const run = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  const r = run[0]!;
  return res.status(201).json({
    ...r,
    eventCount: 0,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  });
});

// Get run
router.get("/runs/stats", async (req, res) => {
  const rows = await db
    .select({
      status: runsTable.status,
      cnt: count(),
    })
    .from(runsTable)
    .groupBy(runsTable.status);

  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = Number(r.cnt);

  const totalEventsRow = await db.select({ cnt: count() }).from(agentEventsTable);
  const totalEvents = Number(totalEventsRow[0]?.cnt ?? 0);
  const totalRuns = Object.values(byStatus).reduce((s, v) => s + v, 0);

  return res.json({
    totalRuns,
    completedRuns: byStatus["completed"] ?? 0,
    failedRuns: byStatus["failed"] ?? 0,
    activeRuns: (byStatus["running"] ?? 0) + (byStatus["pending"] ?? 0),
    totalEvents,
    avgEventsPerRun: totalRuns > 0 ? Math.round(totalEvents / totalRuns) : 0,
  });
});

router.get("/runs/:runId", async (req, res) => {
  const { runId } = req.params;
  const runs = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  if (!runs.length) return res.status(404).json({ error: "Run not found" });
  const r = runs[0]!;

  // Fire-and-forget: refresh prStatus for this run if the PR is not yet terminal
  if (r.prUrl && r.repoUrl && r.prStatus !== "merged" && r.prStatus !== "closed") {
    void refreshPrStatusIfNeeded(r, req.log);
  }

  const events = await db
    .select()
    .from(agentEventsTable)
    .where(eq(agentEventsTable.runId, runId))
    .orderBy(agentEventsTable.seq);

  const objects = await db
    .select()
    .from(graphObjectsTable)
    .where(eq(graphObjectsTable.runId, runId));
  const relations = await db
    .select()
    .from(graphRelationsTable)
    .where(eq(graphRelationsTable.runId, runId));

  return res.json({
    ...r,
    eventCount: events.length,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    events: events.map((e) => ({
      ...e,
      payload: e.payload ?? {},
      createdAt: e.createdAt.toISOString(),
    })),
    graph: {
      objects: objects.map((o) => ({
        id: o.id,
        type: o.objectType,
        data: o.data ?? {},
      })),
      relations: relations.map((rel) => ({
        id: rel.id,
        source: rel.source,
        target: rel.target,
        type: rel.relationType,
      })),
    },
  });
});

// Cancel run
router.delete("/runs/:runId", async (req, res) => {
  const { runId } = req.params;
  const runs = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  if (!runs.length) return res.status(404).json({ error: "Run not found" });

  await db
    .update(runsTable)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(runsTable.id, runId));

  const updated = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  const r = updated[0]!;
  return res.json({
    ...r,
    eventCount: 0,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  });
});

// Get events
router.get("/runs/:runId/events", async (req, res) => {
  const { runId } = req.params;
  const events = await db
    .select()
    .from(agentEventsTable)
    .where(eq(agentEventsTable.runId, runId))
    .orderBy(agentEventsTable.seq);

  return res.json(
    events.map((e) => ({
      ...e,
      payload: e.payload ?? {},
      createdAt: e.createdAt.toISOString(),
    })),
  );
});

// Get graph
router.get("/runs/:runId/graph", async (req, res) => {
  const { runId } = req.params;
  const objects = await db
    .select()
    .from(graphObjectsTable)
    .where(eq(graphObjectsTable.runId, runId));
  const relations = await db
    .select()
    .from(graphRelationsTable)
    .where(eq(graphRelationsTable.runId, runId));

  return res.json({
    objects: objects.map((o) => ({
      id: o.id,
      type: o.objectType,
      data: o.data ?? {},
    })),
    relations: relations.map((rel) => ({
      id: rel.id,
      source: rel.source,
      target: rel.target,
      type: rel.relationType,
    })),
  });
});

// Causal chain for one graph object — ActiveGraph's OWN provenance walk
// (trace/causal.causal_chain) over the framework's authoritative event log,
// not the app's hand-built relations. Shells out to the agent's --causal-chain
// mode so the framework computes it natively.
router.get("/runs/:runId/causal-chain", async (req, res) => {
  const { runId } = req.params;
  const objectId = typeof req.query.objectId === "string" ? req.query.objectId : "";
  if (!objectId) return res.status(400).json({ error: "objectId query param is required" });

  const workspaceRoot = path.resolve(process.cwd(), "../..");
  const agentScript = path.join(workspaceRoot, "scripts/agent/run_agent.py");
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [agentScript, "--run-id", runId, "--causal-chain", objectId],
      { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.trim() || "{}");
    if (parsed.error) return res.status(404).json(parsed);
    return res.json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "failed to compute causal chain", detail: String(err) });
  }
});

// List a run's approvals (human-in-the-loop gate)
router.get("/runs/:runId/approvals", async (req, res) => {
  const { runId } = req.params;
  const rows = await db
    .select()
    .from(agentApprovalsTable)
    .where(eq(agentApprovalsTable.runId, runId));
  return res.json(
    rows.map((a) => ({
      id: a.id,
      runId: a.runId,
      kind: a.kind,
      status: a.status,
      summary: a.summary ?? null,
      createdAt: a.createdAt.toISOString(),
      resolvedAt: a.resolvedAt?.toISOString() ?? null,
    })),
  );
});

// Resolve an approval (approve|reject) — finalizes the paused run
router.post("/runs/:runId/approvals/:approvalId", async (req, res) => {
  const { runId, approvalId } = req.params;
  const decision = (req.body?.decision as string) ?? "";
  if (decision !== "approve" && decision !== "reject") {
    return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
  }
  const rows = await db
    .select()
    .from(agentApprovalsTable)
    .where(eq(agentApprovalsTable.id, approvalId))
    .limit(1);
  if (!rows.length || rows[0]!.runId !== runId) {
    return res.status(404).json({ error: "approval not found for this run" });
  }
  if (rows[0]!.status !== "pending") {
    return res.status(409).json({ error: `approval already ${rows[0]!.status}` });
  }

  const workspaceRoot = path.resolve(process.cwd(), "../..");
  const agentScript = path.join(workspaceRoot, "scripts/agent/run_agent.py");
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [agentScript, "--run-id", runId, "--finalize", "--decision", decision],
      { cwd: workspaceRoot, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
    );
    // Re-read the resolved run + approval for the response.
    const run = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
    if (decision === "approve" && run[0]?.repoUrl) {
      // Changes were committed during finalize; push + PR like a normal run.
      void createPrAfterRun(runId, req.log);
    }
    return res.json({
      runId,
      approvalId,
      decision,
      status: run[0]?.status ?? "unknown",
      detail: stdout.trim(),
    });
  } catch (err) {
    return res.status(500).json({ error: "failed to finalize approval", detail: String(err) });
  }
});

// List files in a run's work directory
router.get("/runs/:runId/files", async (req, res) => {
  const { runId } = req.params;
  const runs = await db
    .select({ workDir: runsTable.workDir })
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  if (!runs.length) return res.status(404).json({ error: "Run not found" });
  const workDir = runs[0]!.workDir;
  if (!workDir || !existsSync(workDir)) return res.json([]);
  try {
    return res.json(buildRunFileTree(workDir, workDir));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// Get file content from a run's work directory
router.get("/runs/:runId/files/content", async (req, res) => {
  const { runId } = req.params;
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: "path query parameter required" });
  const runs = await db
    .select({ workDir: runsTable.workDir })
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  if (!runs.length) return res.status(404).json({ error: "Run not found" });
  const workDir = runs[0]!.workDir;
  if (!workDir) return res.status(404).json({ error: "Run has no work directory" });
  const resolvedWorkDir = path.resolve(workDir);
  const fullPath = path.resolve(path.join(workDir, filePath));
  if (!fullPath.startsWith(resolvedWorkDir + path.sep) && fullPath !== resolvedWorkDir) {
    return res.status(400).json({ error: "Path is outside the run's work directory" });
  }
  if (!existsSync(fullPath)) return res.status(404).json({ error: "File not found" });
  const stat = statSync(fullPath);
  if (stat.isDirectory()) return res.status(400).json({ error: "Path is a directory" });
  if (stat.size > 500_000) return res.status(400).json({ error: "File too large (>500KB)" });
  const content = readFileSync(fullPath, "utf-8");
  return res.json({
    path: filePath,
    content,
    language: detectRunFileLanguage(filePath),
    size: stat.size,
  });
});

// Get patch detail (includes unified diff)
router.get("/runs/:runId/patches/:patchId", async (req, res) => {
  const { runId, patchId } = req.params;
  const objects = await db
    .select()
    .from(graphObjectsTable)
    .where(eq(graphObjectsTable.id, patchId))
    .limit(1);

  if (!objects.length || objects[0]!.runId !== runId) {
    return res.status(404).json({ error: "Patch not found" });
  }

  const obj = objects[0]!;
  const data = (obj.data ?? {}) as Record<string, unknown>;

  return res.json({
    id: obj.id,
    type: data.type ?? "write",
    path: data.path ?? "",
    status: data.status ?? "applied",
    diff: data.diff ?? "",
    lines_added: Number(data.lines_added ?? 0),
    lines_removed: Number(data.lines_removed ?? 0),
    content_preview: (data.content_preview as string | null) ?? null,
  });
});

// Shared helper: detect test files in a work directory
async function detectTestFiles(workDir: string): Promise<{ pyTests: string[]; jsTests: string[] }> {
  let pyTests: string[] = [];
  let jsTests: string[] = [];
  try {
    const out = (
      await execAsync(
        "find . -maxdepth 4 \\( -name 'test_*.py' -o -name '*_test.py' \\) | head -10",
        { cwd: workDir, timeout: 5000 },
      )
    ).stdout.trim();
    if (out) pyTests = out.split("\n").filter(Boolean);
  } catch {
    /* ignore */
  }
  try {
    const out = (
      await execAsync(
        "find . -maxdepth 4 \\( -name '*.test.ts' -o -name '*.spec.ts' -o -name '*.test.js' \\) | head -10",
        { cwd: workDir, timeout: 5000 },
      )
    ).stdout.trim();
    if (out) jsTests = out.split("\n").filter(Boolean);
  } catch {
    /* ignore */
  }
  return { pyTests, jsTests };
}

// Check test availability (GET) — does not run tests
router.get("/runs/:runId/test", async (req, res) => {
  const { runId } = req.params;
  const runs = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  if (!runs.length) return res.status(404).json({ error: "Run not found" });
  const run = runs[0]!;
  if (!run.workDir || !existsSync(run.workDir)) {
    return res.json({ runId, hasTests: false, testFiles: [] });
  }
  const { pyTests, jsTests } = await detectTestFiles(run.workDir);
  const testFiles = [...pyTests, ...jsTests];
  return res.json({ runId, hasTests: testFiles.length > 0, testFiles });
});

// Run tests in a completed run's work directory
router.post("/runs/:runId/test", async (req, res) => {
  const { runId } = req.params;
  const runs = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  if (!runs.length) return res.status(404).json({ error: "Run not found" });
  const run = runs[0]!;
  if (run.status !== "completed") {
    return res.status(400).json({ error: "Tests can only be run on completed runs" });
  }
  if (!run.workDir || !existsSync(run.workDir)) {
    return res.status(400).json({ error: "Run has no work directory", hasTests: false });
  }

  const { pyTests, jsTests } = await detectTestFiles(run.workDir);
  if (pyTests.length === 0 && jsTests.length === 0) {
    return res
      .status(400)
      .json({ error: "No test files found in work directory", hasTests: false });
  }

  const isPytest = pyTests.length > 0;
  // No pipe to head — must preserve real test-runner exit code
  const testCommand = isPytest ? "python3 -m pytest -x --tb=short" : "npx jest --passWithNoTests";
  const framework = isPytest ? "pytest" : "jest";

  let output = "";
  let passed = 0;
  let failed = 0;
  let commandOk = false;

  try {
    const result = await execAsync(testCommand, {
      cwd: run.workDir,
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    });
    output = (result.stdout + result.stderr).trim();
    commandOk = true;
  } catch (err: any) {
    output = (
      (err.stdout ?? "") + (err.stderr ?? "") || String(err.message ?? "Test run failed")
    ).trim();
    commandOk = false;
  }

  // Parse pass/fail/error counts from pytest and jest output
  const passedMatch = output.match(/(\d+) passed/);
  const failedMatch = output.match(/(\d+) failed/);
  const errorMatch = output.match(/(\d+) error/);
  if (passedMatch) passed = parseInt(passedMatch[1]!);
  if (failedMatch) failed = parseInt(failedMatch[1]!);
  if (errorMatch) failed += parseInt(errorMatch[1]!);
  const total = passed + failed;
  // Status is passed only when the command exited 0 AND no failures/errors were parsed
  const status = commandOk && failed === 0 ? "passed" : "failed";

  // Get next event seq
  const seqRows = await db
    .select({ maxSeq: sql<number>`MAX(seq)` })
    .from(agentEventsTable)
    .where(eq(agentEventsTable.runId, runId));
  const nextSeq = Number(seqRows[0]?.maxSeq ?? 0) + 1;

  const eventId = uuidv4();
  const now = new Date();
  await db.insert(agentEventsTable).values({
    id: eventId,
    runId,
    type: "test.run.completed",
    seq: nextSeq,
    payload: {
      status,
      passed,
      failed,
      total,
      output: output.slice(0, 5000),
      triggered_by: "user",
      framework,
    },
    createdAt: now,
  });

  return res.json({
    id: eventId,
    runId,
    type: "test.run.completed",
    seq: nextSeq,
    status,
    passed,
    failed,
    total,
    output: output.slice(0, 5000),
    triggered_by: "user",
    createdAt: now.toISOString(),
  });
});

// Fork run
router.post("/runs/:runId/fork", runCreateRateLimiter, async (req, res) => {
  const { runId } = req.params as { runId: string };
  const parsed = ForkRunBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { atEventId, goal, model, instruction, repoUrl: forkRepoUrl } = parsed.data;
  if (forkRepoUrl && !isValidRepoUrl(forkRepoUrl)) {
    return res.status(400).json({ error: "repoUrl must be an https github.com owner/repo URL" });
  }

  const parent = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  if (!parent.length) return res.status(404).json({ error: "Parent run not found" });
  const newRunId = uuidv4();
  const newGoal = goal ?? parent[0]!.goal;
  const newModel = model ?? parent[0]!.model;
  const effectiveGoal = instruction
    ? `${newGoal}\n\nAdditional instruction: ${instruction}`
    : newGoal;
  // Fork inherits the parent's repoUrl unless the caller overrides it
  const effectiveRepoUrl = forkRepoUrl ?? parent[0]!.repoUrl ?? null;

  // Fork inherits the parent's work directory so it operates on the same files.
  // Legacy runs with workDir=null had files at workspace root — preserve that.
  const forkWorkspaceRoot = path.resolve(process.cwd(), "../..");
  const resolvedWorkDir = parent[0]!.workDir ?? forkWorkspaceRoot;
  mkdirSync(resolvedWorkDir, { recursive: true });

  await db.insert(runsTable).values({
    id: newRunId,
    goal: effectiveGoal,
    status: "pending",
    parentRunId: runId,
    forkEventId: atEventId,
    model: newModel ?? null,
    workDir: resolvedWorkDir,
    repoUrl: effectiveRepoUrl,
    createdAt: new Date(),
  });

  // Spawn agent
  const agentScript = path.join(forkWorkspaceRoot, "scripts/agent/run_agent.py");
  const forkAgentArgs = [
    "--run-id",
    newRunId,
    "--goal",
    effectiveGoal,
    "--work-dir",
    resolvedWorkDir,
  ];
  if (effectiveRepoUrl) forkAgentArgs.push("--repo-url", effectiveRepoUrl);
  // Real ActiveGraph fork: copy the parent's native event log up to the chosen
  // event into this run (shared lineage), then continue. The agent degrades to
  // a fresh continuation if the parent predates the native store.
  if (atEventId) forkAgentArgs.push("--fork-from", runId, "--at-event", atEventId);

  const forkAgentEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Pushing is handled in Node via the GitHub REST API (pushBranchViaApi); the
  // subprocess only needs non-interactive git for its local clone/commit.
  delete forkAgentEnv["GIT_ASKPASS"];
  forkAgentEnv["GIT_TERMINAL_PROMPT"] = "0";
  // Private-repo clones need a real OAuth token — resolve it from the
  // connector/env and pass through as GITHUB_TOKEN (see POST /runs).
  if (effectiveRepoUrl) {
    const token = await getGitHubAccessToken();
    if (token) forkAgentEnv["GITHUB_TOKEN"] = token;
  }

  const child = spawn("python3", [agentScript, ...forkAgentArgs], {
    env: forkAgentEnv,
    cwd: forkWorkspaceRoot,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const forkLog = req.log;
  child.on("exit", () => {
    void createPrAfterRun(newRunId, forkLog);
  });
  child.unref();

  const run = await db.select().from(runsTable).where(eq(runsTable.id, newRunId)).limit(1);
  const r = run[0]!;
  return res.status(201).json({
    ...r,
    eventCount: 0,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  });
});

// Diff two runs
router.get("/runs/:runId/diff/:otherId", async (req, res) => {
  const { runId, otherId } = req.params;

  const [eventsA, eventsB, objectsA, objectsB] = await Promise.all([
    db
      .select()
      .from(agentEventsTable)
      .where(eq(agentEventsTable.runId, runId))
      .orderBy(agentEventsTable.seq),
    db
      .select()
      .from(agentEventsTable)
      .where(eq(agentEventsTable.runId, otherId))
      .orderBy(agentEventsTable.seq),
    db.select().from(graphObjectsTable).where(eq(graphObjectsTable.runId, runId)),
    db.select().from(graphObjectsTable).where(eq(graphObjectsTable.runId, otherId)),
  ]);

  const countByType = (events: typeof eventsA, type: string) =>
    events.filter((e) => e.type.includes(type)).length;

  const objectsAMap = Object.fromEntries(objectsA.map((o) => [o.id, o]));
  const objectsBMap = Object.fromEntries(objectsB.map((o) => [o.id, o]));

  const added = objectsB.filter((o) => !objectsAMap[o.id]);
  const removed = objectsA.filter((o) => !objectsBMap[o.id]);

  return res.json({
    runA: runId,
    runB: otherId,
    summary: {
      eventsA: eventsA.length,
      eventsB: eventsB.length,
      objectsAddedInB: added.length,
      objectsRemovedInB: removed.length,
      objectsModifiedInB: 0,
      filesChangedA: countByType(eventsA, "patch") + countByType(eventsA, "file.write"),
      filesChangedB: countByType(eventsB, "patch") + countByType(eventsB, "file.write"),
      modelCallsA: countByType(eventsA, "llm"),
      modelCallsB: countByType(eventsB, "llm"),
      toolCallsA: countByType(eventsA, "tool"),
      toolCallsB: countByType(eventsB, "tool"),
    },
    objectDiffs: [
      ...added.map((o) => ({
        type: o.objectType,
        objectId: o.id,
        changeType: "added" as const,
        before: null,
        after: o.data,
      })),
      ...removed.map((o) => ({
        type: o.objectType,
        objectId: o.id,
        changeType: "removed" as const,
        before: o.data,
        after: null,
      })),
    ],
  });
});

// Resolve permission
router.post("/runs/:runId/permissions/:permId", async (req, res) => {
  const { runId, permId } = req.params;
  const parsed = ResolvePermissionBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { decision, reason } = parsed.data;
  const eventId = uuidv4();
  const seq = await db
    .select({ maxSeq: sql<number>`MAX(seq)` })
    .from(agentEventsTable)
    .where(eq(agentEventsTable.runId, runId));

  const nextSeq = Number(seq[0]?.maxSeq ?? 0) + 1;

  await db.insert(agentEventsTable).values({
    id: eventId,
    runId,
    type: decision === "approve" ? "permission.approved" : "permission.denied",
    seq: nextSeq,
    payload: { permId, decision, reason: reason ?? null },
    createdAt: new Date(),
  });

  return res.json({
    id: eventId,
    runId,
    type: decision === "approve" ? "permission.approved" : "permission.denied",
    seq: nextSeq,
    payload: { permId, decision, reason: reason ?? null },
    createdAt: new Date().toISOString(),
  });
});

// SSE stream endpoint
router.get("/runs/:runId/stream", async (req, res) => {
  const { runId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  let lastSeq = -1;
  let done = false;

  const poll = async () => {
    try {
      const runs = await db
        .select({ status: runsTable.status })
        .from(runsTable)
        .where(eq(runsTable.id, runId))
        .limit(1);
      if (!runs.length) {
        res.write("event: error\ndata: Run not found\n\n");
        res.end();
        return;
      }

      const newEvents = await db
        .select()
        .from(agentEventsTable)
        .where(sql`${agentEventsTable.runId} = ${runId} AND ${agentEventsTable.seq} > ${lastSeq}`)
        .orderBy(agentEventsTable.seq);

      for (const event of newEvents) {
        res.write(
          `event: agent_event\ndata: ${JSON.stringify({
            ...event,
            payload: event.payload ?? {},
            createdAt: event.createdAt.toISOString(),
          })}\n\n`,
        );
        lastSeq = event.seq;
      }

      const runStatus = runs[0]!.status;
      if (["completed", "failed", "cancelled"].includes(runStatus)) {
        res.write(`event: run_done\ndata: ${JSON.stringify({ status: runStatus })}\n\n`);
        res.end();
        done = true;
        return;
      }

      if (!done) setTimeout(poll, 800);
    } catch {
      if (!done) setTimeout(poll, 2000);
    }
  };

  poll();
  req.on("close", () => {
    done = true;
  });
});

export default router;
