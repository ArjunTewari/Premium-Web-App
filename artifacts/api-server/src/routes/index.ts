import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import adminRouter from "./admin.js";
import pipelineRouter from "./pipeline.js";
import pdfRouter from "./pdf.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(adminRouter);
router.use(pipelineRouter);
router.use(pdfRouter);

export default router;
