import express, { type Express } from "express";
import pinoHttp from "pino-http";
import router, { apiInfo } from "./routes";
import { logger } from "./lib/logger";
import { corsMiddleware, requireApiKey } from "./middlewares/security";

const app: Express = express();

// We run behind Replit's reverse proxy (and any self-hosted proxy), so trust the
// first hop for correct client IPs (rate limiting) and protocol detection.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(corsMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Bare root has no web UI — return the JSON info pointer instead of Express's
// default "Cannot GET /", which reads as a broken app.
app.get("/", (_req, res) => res.json(apiInfo));

// Optional API-key gate (no-op unless AGENT_API_KEY is set).
app.use("/api", requireApiKey);
app.use("/api", router);

export default app;
