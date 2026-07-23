import { Router, type IRouter, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { requireAuth } from "../middleware/require-auth.js";

const router: IRouter = Router();
const OUT_DIR = path.join(process.cwd(), "outputs");

// Find a usable Chrome/Chromium binary on Replit / Linux
function findChrome(): string | undefined {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/nix/var/nix/profiles/default/bin/chromium",
    "/run/current-system/sw/bin/chromium",
    "/home/user/.nix-profile/bin/chromium",
  ];
  for (const p of candidates) {
    if (!p) continue;
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return undefined;
}

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
    const executablePath = findChrome();
    browser = await puppeteer.default.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
        "--single-process",
        "--no-zygote",
      ],
    });
    const page = await browser.newPage();
    await page.emulateMediaType("screen");

    const html = fs.readFileSync(fpath, "utf8");
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 1500));

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
