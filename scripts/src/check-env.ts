/**
 * Preflight environment check for AG Coder.
 *
 *   pnpm run check
 *
 * Verifies the things a fresh clone needs before the app will run: required env
 * vars, a reachable Postgres, a working `python3` with the agent's dependencies,
 * and reports which agent mode (live vs demo) is active. Exits non-zero if a
 * hard requirement is missing so it can be used in CI / setup scripts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

const ok = (msg: string) => console.log(`  \u2713 ${msg}`);
const warn = (msg: string) => console.log(`  \u26a0 ${msg}`);
const fail = (msg: string) => console.log(`  \u2717 ${msg}`);

let hardFailures = 0;

async function checkNode(): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 24) ok(`Node.js ${process.versions.node}`);
  else warn(`Node.js ${process.versions.node} — 24+ recommended`);
}

async function checkDatabase(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    fail("DATABASE_URL is not set (required)");
    hardFailures++;
    return;
  }
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SELECT 1");
    ok("DATABASE_URL is set and Postgres is reachable");
  } catch (err) {
    fail(`DATABASE_URL is set but Postgres is unreachable: ${(err as Error).message}`);
    hardFailures++;
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkPython(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("python3", ["--version"]);
    ok(`${stdout.trim()} available`);
  } catch {
    fail("python3 not found on PATH (required to run the agent)");
    hardFailures++;
    return;
  }

  try {
    await execFileAsync("python3", ["-c", "import activegraph, psycopg2"]);
    ok("Python deps importable (activegraph, psycopg2)");
  } catch {
    fail("Python deps missing — run: pip install -r scripts/agent/requirements.txt");
    hardFailures++;
  }
}

function checkLlmMode(): void {
  if (process.env["ANTHROPIC_API_KEY"]) ok("ANTHROPIC_API_KEY set — live agent (Anthropic)");
  else if (process.env["OPENAI_API_KEY"]) ok("OPENAI_API_KEY set — live agent (OpenAI)");
  else warn("No LLM key set — agent runs in deterministic demo mode");
}

async function main(): Promise<void> {
  console.log("AG Coder environment check\n");
  await checkNode();
  await checkDatabase();
  await checkPython();
  checkLlmMode();

  console.log("");
  if (hardFailures > 0) {
    console.log(`${hardFailures} required check(s) failed.`);
    process.exit(1);
  }
  console.log("All required checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
