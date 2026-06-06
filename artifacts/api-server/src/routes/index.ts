import { Router, type IRouter } from "express";
import healthRouter from "./health";
import runsRouter from "./runs";
import filesRouter from "./files";
import githubRouter from "./github";

const router: IRouter = Router();

/**
 * Info payload for the API root. This server is JSON-only with no web UI, so a
 * bare visit (the report saw "Cannot GET /api/") should explain that and point
 * at the frontend and health check rather than look broken.
 */
export const apiInfo = {
  service: "ag-coder-api",
  message: "This is the AG Coder JSON API — open the frontend URL to use the app, not the API.",
  health: "/api/healthz",
  repo: "https://github.com/yoheinakajima/ag-coder",
};

// Mounted at /api, so this answers GET /api and GET /api/.
router.get("/", (_req, res) => res.json(apiInfo));

router.use(healthRouter);
router.use(runsRouter);
router.use(filesRouter);
router.use(githubRouter);

export default router;
