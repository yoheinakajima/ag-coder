import rateLimit from "express-rate-limit";

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Limits how frequently a single client can spawn agent runs (POST /runs and
 * forks). Each run launches a subprocess and may clone a repo, so this caps
 * resource abuse. In-memory only — fine for a single-process reference server;
 * swap in a shared store if running multiple instances.
 */
export const runCreateRateLimiter = rateLimit({
  windowMs: positiveIntFromEnv("RUN_RATE_LIMIT_WINDOW_MS", 60_000),
  limit: positiveIntFromEnv("RUN_RATE_LIMIT_MAX", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many runs created from this client, please slow down." },
});
