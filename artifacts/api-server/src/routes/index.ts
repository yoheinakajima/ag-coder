import { Router, type IRouter } from "express";
import healthRouter from "./health";
import runsRouter from "./runs";
import filesRouter from "./files";
import githubRouter from "./github";

const router: IRouter = Router();

router.use(healthRouter);
router.use(runsRouter);
router.use(filesRouter);
router.use(githubRouter);

export default router;
