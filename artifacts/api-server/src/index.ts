import app from "./app";
import { logger } from "./lib/logger";
import { logGitHubConnectionStatus } from "./github-client";

// Default to 8080 when PORT is unset — this is the single source-of-truth dev
// port the frontend's Vite proxy also targets by default (API_PROXY_TARGET), so
// `pnpm dev` works with zero config. Deployments set PORT explicitly.
const rawPort = process.env["PORT"] ?? "8080";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Probe GitHub connector availability at startup (non-blocking)
  logGitHubConnectionStatus().catch(() => {
    logger.warn("GitHub connector probe failed at startup");
  });
});
