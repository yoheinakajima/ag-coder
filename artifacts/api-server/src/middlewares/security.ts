import cors, { type CorsOptions } from "cors";
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * An origin is allowed if it is local development, an explicitly configured
 * origin (CORS_ORIGINS), or a Replit-provided / preview / deploy domain. This
 * keeps the Replit preview and published deployments working out of the box
 * while replacing the previous "allow everything" policy.
 */
function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();

  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (splitCsv(process.env["CORS_ORIGINS"]).includes(origin)) return true;
  if (splitCsv(process.env["REPLIT_DOMAINS"]).includes(host)) return true;
  if (/\.(replit\.dev|replit\.app|repl\.co)$/.test(host)) return true;

  return false;
}

export const corsMiddleware = cors({
  origin(origin, callback) {
    // Requests with no Origin header (curl, same-origin, server-to-server) pass.
    if (!origin) return callback(null, true);
    return callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
} satisfies CorsOptions);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function extractKey(req: Request): string | null {
  const headerKey = req.get("x-api-key");
  if (headerKey) return headerKey;
  const auth = req.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return null;
}

/**
 * Optional API-key gate for mutating endpoints. Disabled entirely unless
 * AGENT_API_KEY is set, so local and demo usage are unaffected by default.
 * Read-only requests (GET/HEAD/OPTIONS) are always allowed.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env["AGENT_API_KEY"];
  if (!expected) return next();

  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();

  const provided = extractKey(req);
  if (provided && safeEqual(provided, expected)) return next();

  res.status(401).json({ error: "Unauthorized" });
}
