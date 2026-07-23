import { Router, type IRouter } from "express";
import healthRouter from "./health";
import emeraldRouter from "./emerald";

const router: IRouter = Router();

router.use(healthRouter);
router.use(emeraldRouter);

export default router;
