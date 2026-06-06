/**
 * GitHub API client — two-layer auth strategy:
 *
 *   1. Replit connector proxy  (works when the GitHub integration is connected)
 *   2. GITHUB_TOKEN env var    (for self-hosted / local / CI deployments)
 *
 * `githubRequest` tries the connector first. If the connector is unavailable
 * (SDK throws before making a request — not a real HTTP 4xx/5xx from GitHub),
 * it falls through to a direct `fetch` using `process.env.GITHUB_TOKEN`.
 * Real GitHub API errors (404, 422, etc.) are always re-thrown immediately.
 *
 * IMPORTANT: Never cache the connectors instance. Create fresh on each call.
 */
import { ReplitConnectors } from "@replit/connectors-sdk";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "./lib/logger.js";

/** True when the error originates from a real GitHub HTTP response (4xx/5xx). */
function isHttpApiError(err: unknown): boolean {
  return /failed \d{3}:/.test(String(err instanceof Error ? err.message : err));
}

/**
 * Make an authenticated GitHub REST API call.
 *
 * Auth priority:
 *   1. Replit connector proxy (no token config required on Replit)
 *   2. `GITHUB_TOKEN` env var  (required for self-hosted deployments)
 *
 * @example
 *   const pr = await githubRequest("POST", `/repos/${owner}/${repo}/pulls`, body);
 */
export async function githubRequest<T = unknown>(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const fetchOptions = {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  };

  // ── 1. Try Replit connector proxy ──────────────────────────────────────────
  let connectorError: unknown;
  try {
    const connectors = new ReplitConnectors();
    const response = await connectors.proxy("github", endpoint, fetchOptions);
    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(`GitHub API ${method} ${endpoint} failed ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  } catch (err) {
    // Re-throw real GitHub API errors (4xx/5xx) immediately — they won't be
    // resolved by retrying with a different token.
    if (isHttpApiError(err)) throw err;
    connectorError = err;
  }

  // ── 2. Fall back to GITHUB_TOKEN (self-hosted / CI) ───────────────────────
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    throw new Error(
      `GitHub connector unavailable and GITHUB_TOKEN is not set. ` +
        `On Replit: connect the GitHub integration. ` +
        `Self-hosted: set the GITHUB_TOKEN environment variable to a personal access token. ` +
        `Original connector error: ${String(connectorError)}`,
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "ag-code-agent",
  };
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`GitHub API ${method} ${endpoint} failed ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Resolve a GitHub access token usable for `git clone` of private repos.
 *
 * The connector proxy (used by `githubRequest`) never hands the raw OAuth token
 * to this process, so it cannot authenticate a plain `git clone` over HTTPS.
 * This function pulls the actual OAuth access token so the agent subprocess can
 * embed it in the clone URL (`https://x-access-token:<token>@github.com/...`).
 *
 * Auth priority mirrors `githubRequest`:
 *   1. Replit connector  (settings.access_token via listConnections)
 *   2. `GITHUB_TOKEN` env (self-hosted / CI)
 *
 * Returns the token string, or null if neither source is available (public
 * repos still clone fine without a token).
 */
export async function getGitHubAccessToken(): Promise<string | null> {
  // ── 1. Try the Replit connector ────────────────────────────────────────────
  // NOTE: the SDK's `listConnections({ expand: ["settings"] })` returns HTTP 400
  // and never yields the OAuth token. The secret is only exposed via the
  // `include_secrets=true` query param on the raw connection endpoint, reached
  // with the SDK's identity headers (X_REPLIT_TOKEN). This mirrors the canonical
  // Replit connector secret-fetch pattern.
  try {
    const connectors = new ReplitConnectors();
    const headers = await connectors.getProxyHeaders("github");
    const hostname = process.env["REPLIT_CONNECTORS_HOSTNAME"] || "connectors.replit.com";
    const url = `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=github`;
    const response = await fetch(url, { headers: { ...headers, Accept: "application/json" } });
    if (response.ok) {
      const data = (await response.json()) as {
        items?: Array<{
          settings?: {
            access_token?: unknown;
            oauth?: { credentials?: { access_token?: unknown } };
          };
        }>;
      };
      for (const item of data.items ?? []) {
        const settings = item.settings;
        const token = settings?.access_token ?? settings?.oauth?.credentials?.access_token;
        if (typeof token === "string" && token.length > 0) return token;
      }
    } else {
      logger.warn({ status: response.status }, "GitHub connector secret fetch returned non-OK");
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "Failed to read GitHub access token from connector");
  }

  // ── 2. Fall back to GITHUB_TOKEN (self-hosted / CI) ─────────────────────────
  const envToken = process.env["GITHUB_TOKEN"];
  if (envToken && envToken.length > 0) return envToken;

  return null;
}

/**
 * Detect which GitHub auth method is currently active.
 * Returns 'connector', 'token', or 'none'.
 * Used by logGitHubConnectionStatus to report the active method at startup.
 */
async function detectGitHubAuthMethod(): Promise<
  { method: "connector"; login: string } | { method: "token"; login: string } | { method: "none" }
> {
  // Try connector first (without falling through to token, so we can tell them apart)
  try {
    const connectors = new ReplitConnectors();
    const r = await connectors.proxy("github", "/user", { method: "GET" });
    if (r.ok) {
      const user = (await r.json()) as { login?: string };
      if (user.login) return { method: "connector", login: user.login };
    }
  } catch {
    /* unavailable — fall through */
  }

  // Try GITHUB_TOKEN
  const token = process.env["GITHUB_TOKEN"];
  if (token) {
    try {
      const r = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ag-code-agent",
        },
      });
      if (r.ok) {
        const user = (await r.json()) as { login?: string };
        if (user.login) return { method: "token", login: user.login };
      }
    } catch {
      /* invalid token — fall through */
    }
  }

  return { method: "none" };
}

/**
 * Log GitHub auth status at server startup.
 * Reports which auth method is active (connector / token / none).
 * Call once after the server starts listening.
 */
export async function logGitHubConnectionStatus(): Promise<void> {
  const result = await detectGitHubAuthMethod();
  if (result.method === "connector") {
    logger.info(
      { githubLogin: result.login, authMethod: "connector" },
      "GitHub auth ready (Replit connector)",
    );
  } else if (result.method === "token") {
    logger.info(
      { githubLogin: result.login, authMethod: "token" },
      "GitHub auth ready (GITHUB_TOKEN)",
    );
  } else {
    logger.warn(
      "GitHub auth unavailable — repo-backed runs will skip push/PR. " +
        "On Replit: connect the GitHub integration. " +
        "Self-hosted: set GITHUB_TOKEN=<personal-access-token>.",
    );
  }
}

/**
 * Parse owner and repo name from a GitHub URL.
 * Handles https://github.com/owner/repo and https://github.com/owner/repo.git
 */
export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(repoUrl.replace(/\.git$/, ""));
    if (url.hostname !== "github.com") return null;
    const [, owner, repo] = url.pathname.split("/");
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

/**
 * Parse the pull request number from a GitHub PR URL.
 * e.g. https://github.com/owner/repo/pull/42 → 42
 */
export function parsePullNumber(prUrl: string): number | null {
  try {
    const match = prUrl.match(/\/pull\/(\d+)(?:\/|$)/);
    return match ? parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the current state of a pull request from GitHub.
 * Returns 'open', 'merged', or 'closed'.
 * Returns null if the connector is unavailable or the PR can't be found.
 */
export async function getPullRequestStatus(
  repoUrl: string,
  prUrl: string,
): Promise<"open" | "merged" | "closed" | null> {
  try {
    const parsed = parseGitHubRepo(repoUrl);
    if (!parsed) return null;
    const pullNumber = parsePullNumber(prUrl);
    if (!pullNumber) return null;
    const { owner, repo } = parsed;
    const pr = await githubRequest<{ state: string; merged: boolean; merged_at: string | null }>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${pullNumber}`,
    );
    if (pr.merged || pr.merged_at) return "merged";
    if (pr.state === "closed") return "closed";
    return "open";
  } catch {
    return null;
  }
}

/**
 * Open a pull request on GitHub after the agent pushes its branch.
 * Tries `main` as the base branch first, falls back to `master`.
 * Returns the PR html_url on success, null if anything fails.
 */
export async function createPullRequest(params: {
  repoUrl: string;
  head: string;
  goal: string;
  runId: string;
}): Promise<string | null> {
  const parsed = parseGitHubRepo(params.repoUrl);
  if (!parsed) return null;
  const { owner, repo } = parsed;

  // Determine the base branch — prefer main, fall back to master
  let base = "main";
  try {
    await githubRequest("GET", `/repos/${owner}/${repo}/branches/main`);
  } catch {
    base = "master";
  }

  const goalSnippet = params.goal.length > 100 ? `${params.goal.slice(0, 97)}…` : params.goal;
  const pr = await githubRequest<{ html_url: string }>("POST", `/repos/${owner}/${repo}/pulls`, {
    title: `[AG Coder] ${goalSnippet}`,
    body: `Automated pull request opened by AG Coder.\n\n**Run ID:** \`${params.runId}\`\n\n**Goal:** ${params.goal}`,
    head: params.head,
    base,
  });
  return pr.html_url ?? null;
}

/**
 * Push the agent's local commit to a new GitHub branch using the Git Data API,
 * routed through the Replit connector proxy.
 *
 * The Replit connectors proxy only exposes GitHub's REST API (api.github.com) —
 * it never hands the raw OAuth token to this process, so a normal `git push`
 * over HTTPS cannot authenticate. Instead we replay the agent's single commit as
 * blobs → tree → commit → ref via the REST API, which the proxy authenticates
 * for us. No token needs to be configured.
 *
 * The agent makes exactly one commit (author "AG Coder") on top of the
 * cloned base; we read the files it touched from the work dir and apply them on
 * top of the current base branch tip. Returns { ok } describing the outcome.
 */
export async function pushBranchViaApi(params: {
  repoUrl: string;
  branch: string;
  workDir: string;
  goal: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const parsed = parseGitHubRepo(params.repoUrl);
  if (!parsed) return { ok: false, reason: "could not parse repo url" };
  const { owner, repo } = parsed;
  const wd = params.workDir;

  const git = (args: string[]): string =>
    execFileSync("git", ["-C", wd, ...args], { encoding: "utf8" }).trim();

  // Only push if the agent actually committed (its commit is HEAD).
  let author: string;
  try {
    author = git(["log", "-1", "--format=%an", "HEAD"]);
  } catch {
    return { ok: false, reason: "no git history in work dir" };
  }
  if (author !== "AG Coder") {
    return { ok: false, reason: "no agent commit to push" };
  }

  // Files changed in the agent's commit (HEAD vs its parent).
  let nameStatus: string;
  try {
    nameStatus = git(["diff", "--name-status", "HEAD~1", "HEAD"]);
  } catch {
    nameStatus = git(["show", "--name-status", "--format=", "HEAD"]);
  }
  const lines = nameStatus
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { ok: false, reason: "agent commit has no file changes" };

  // Map each tracked file to its git mode (preserves the executable bit).
  const modeMap = new Map<string, string>();
  try {
    for (const l of git(["ls-tree", "-r", "HEAD"]).split("\n")) {
      const m = l.match(/^(\d+)\s+blob\s+[0-9a-f]+\t(.+)$/);
      if (m) modeMap.set(m[2]!, m[1]!);
    }
  } catch {
    /* fall back to default mode below */
  }

  type Change = { path: string; deleted: boolean };
  const changes: Change[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    const code = parts[0]!;
    if (code.startsWith("R") && parts.length >= 3) {
      // Rename: drop the old path, add the new one.
      changes.push({ path: parts[1]!, deleted: true });
      changes.push({ path: parts[2]!, deleted: false });
    } else {
      changes.push({ path: parts[1]!, deleted: code.startsWith("D") });
    }
  }

  // Use the agent's ACTUAL base commit (its commit's parent, local HEAD~1) as
  // the parent of the commit we create on the remote. That commit was cloned
  // from this repo, so it already exists remotely. Anchoring to it — rather than
  // to the current remote branch tip — preserves the agent's commit semantics
  // and avoids silently overwriting upstream changes pushed after the clone;
  // GitHub reconciles any divergence from the base branch at PR-review time.
  let baseCommitSha: string;
  try {
    baseCommitSha = git(["rev-parse", "HEAD~1"]);
  } catch {
    return { ok: false, reason: "could not resolve the agent commit's parent" };
  }
  let baseCommit: { tree: { sha: string } };
  try {
    baseCommit = await githubRequest("GET", `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
  } catch (err) {
    return {
      ok: false,
      reason: `base commit ${baseCommitSha.slice(0, 8)} not found on remote: ${String(err)}`,
    };
  }
  const baseTreeSha = baseCommit.tree.sha;

  // Build the new tree: create a blob for each added/modified file, mark
  // deletions with a null sha.
  const tree: Array<{ path: string; mode: string; type: "blob"; sha: string | null }> = [];
  for (const c of changes) {
    const mode = modeMap.get(c.path) ?? "100644";
    if (c.deleted) {
      tree.push({ path: c.path, mode, type: "blob", sha: null });
    } else {
      const content = readFileSync(path.join(wd, c.path));
      const blob = await githubRequest<{ sha: string }>(
        "POST",
        `/repos/${owner}/${repo}/git/blobs`,
        { content: content.toString("base64"), encoding: "base64" },
      );
      tree.push({ path: c.path, mode, type: "blob", sha: blob.sha });
    }
  }

  const newTree = await githubRequest<{ sha: string }>(
    "POST",
    `/repos/${owner}/${repo}/git/trees`,
    { base_tree: baseTreeSha, tree },
  );
  const newCommit = await githubRequest<{ sha: string }>(
    "POST",
    `/repos/${owner}/${repo}/git/commits`,
    { message: `[AG Coder] ${params.goal}`, tree: newTree.sha, parents: [baseCommitSha] },
  );

  // Create the branch ref, or fast-forward/replace it if it already exists.
  try {
    await githubRequest("POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${params.branch}`,
      sha: newCommit.sha,
    });
  } catch {
    await githubRequest("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${params.branch}`, {
      sha: newCommit.sha,
      force: true,
    });
  }

  return { ok: true };
}
