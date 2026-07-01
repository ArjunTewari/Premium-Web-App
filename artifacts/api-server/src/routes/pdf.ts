import { Router, type IRouter, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { requireAuth } from "../middleware/require-auth.js";

const router: IRouter = Router();
const OUT_DIR = path.join(process.cwd(), "outputs");

router.get("/pdf/:file", requireAuth, async (req: Request, res: Response) => {
  const fname = path.basename(req.params.file);
  if (!fname.endsWith(".html")) {
    return res.status(400).json({ error: "Only .html files can be converted to PDF" });
  }
  const fpath = path.join(OUT_DIR, fname);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: "File not found" });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  try {
    const puppeteer = await import("puppeteer");
    browser = await puppeteer.default.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });
    const page = await browser.newPage();
    await page.emulateMediaType("screen");

    const html = fs.readFileSync(fpath, "utf8");
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20px", bottom: "20px", left: "16px", right: "16px" },
    });

    const pdfName = fname.replace(/\.html$/i, ".pdf");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${pdfName}"`);
    res.send(Buffer.from(pdf));
  } catch (e: unknown) {
    console.error("[PDF]", e);
    res.status(500).json({ error: "PDF generation failed: " + (e as Error).message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

export default router;
