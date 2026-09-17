import path from "node:path";
import { eq } from "drizzle-orm";
import { db, reportSchedulesTable, orgHandlesTable, type ReportSchedule } from "@workspace/db";
import { logger } from "./logger.js";
import { generateAndDeliverReport } from "./generate-report.js";
import type { RunConfig } from "../pipeline/index.js";

// Fires each active schedule at most once per (IST) Monday, generating the
// report for the week that just ended: last Monday 00:00 -> yesterday
// (Sunday) 23:59, IST. Runs as a plain in-process interval — the app is a
// single long-running Railway service, so no external cron infra is needed.
//
// A schedule's own runHourIst/runMinuteIst controls what time Monday morning
// it fires; comparing against `lastRunAt`'s IST date (not just "did it run
// this tick") is what keeps it from firing more than once even though the
// checker itself ticks every few minutes.

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const OUT_DIR = path.join(process.cwd(), "outputs");

function istParts(d: Date): { weekday: string; dateKey: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;
  // hour12:false renders midnight as "24" in some ICU builds — normalize.
  const hour = parseInt(parts.hour, 10) % 24;
  return {
    weekday: parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: parseInt(parts.minute, 10),
  };
}

/** The most recently completed Mon->Sun window, given this Monday's IST date key. */
function lastWeekWindow(mondayDateKey: string): { from: string; to: string } {
  const monday = new Date(`${mondayDateKey}T00:00:00Z`);
  const to = new Date(monday);
  to.setUTCDate(to.getUTCDate() - 1); // Sunday just passed
  const from = new Date(monday);
  from.setUTCDate(from.getUTCDate() - 7); // the Monday before that
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

async function fireSchedule(schedule: ReportSchedule, mondayDateKey: string): Promise<void> {
  const { from, to } = lastWeekWindow(mondayDateKey);

  const ytHandles: Record<string, string> = {};
  const twHandles: Record<string, string> = {};
  const igHandles: Record<string, string> = {};
  const liHandles: Record<string, string> = {};
  try {
    const rows = await db.select().from(orgHandlesTable);
    for (const r of rows) {
      if (r.youtube) ytHandles[r.org] = r.youtube;
      if (r.twitter) twHandles[r.org] = r.twitter;
      if (r.instagram) igHandles[r.org] = r.instagram;
      if (r.linkedin) liHandles[r.org] = r.linkedin;
    }
  } catch (err) {
    logger.warn({ err, scheduleId: schedule.id }, "report-scheduler: failed to load org handles");
  }

  const cfg: RunConfig = {
    ORGS: schedule.orgs,
    DATE_FROM: from,
    DATE_TO: to,
    CLIENT_NAME: schedule.clientName,
    SCOPE_KEYWORDS: schedule.scopeKeywords ?? [],
    SERPER_KEY: process.env.SERPER_KEY || "",
    CLAUDE_KEY: process.env.CLAUDE_KEY || "",
    OPENAI_KEY: process.env.OPENAI_KEY || "",
    PERPLEXITY_KEY: process.env.PERPLEXITY_KEY || "",
    GEMINI_KEY: process.env.GEMINI_KEY || "",
    EXA_API_KEY: process.env.EXA_API_KEY || "",
    YOUTUBE_KEY: process.env.YOUTUBE_KEY || "",
    APIDIRECT_KEY: process.env.APIDIRECT_KEY || "",
    ORG_YT_HANDLES: ytHandles,
    ORG_TW_HANDLES: twHandles,
    ORG_IG_HANDLES: igHandles,
    ORG_LI_HANDLES: liHandles,
    X_BEARER_TOKEN: process.env.X_BEARER_TOKEN || "",
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || "",
    IG_BUSINESS_ACCOUNT_ID: process.env.IG_BUSINESS_ACCOUNT_ID || "",
    outDir: OUT_DIR,
  };

  const cb = (msg: string, level?: string) => {
    logger.info({ scheduleId: schedule.id, label: schedule.label, level }, msg.trim());
  };

  logger.info({ scheduleId: schedule.id, label: schedule.label, from, to }, "report-scheduler: firing");

  try {
    const result = await generateAndDeliverReport({
      cfg,
      cb,
      generatedByUsername: `schedule:${schedule.label}`,
      recipientEmail: schedule.recipientEmail || null,
    });
    await db
      .update(reportSchedulesTable)
      .set({ lastRunAt: new Date(), lastRunStatus: `done:${result.htmlName}` })
      .where(eq(reportSchedulesTable.id, schedule.id));
    logger.info({ scheduleId: schedule.id, htmlName: result.htmlName }, "report-scheduler: completed");
  } catch (err) {
    await db
      .update(reportSchedulesTable)
      .set({ lastRunAt: new Date(), lastRunStatus: `error:${(err as Error).message}`.slice(0, 500) })
      .where(eq(reportSchedulesTable.id, schedule.id))
      .catch(() => {});
    logger.error({ err, scheduleId: schedule.id }, "report-scheduler: failed");
  }
}

async function tick(): Promise<void> {
  let schedules: ReportSchedule[];
  try {
    schedules = await db.select().from(reportSchedulesTable).where(eq(reportSchedulesTable.active, true));
  } catch (err) {
    logger.warn({ err }, "report-scheduler: failed to load schedules");
    return;
  }
  if (!schedules.length) return;

  const now = istParts(new Date());
  if (now.weekday !== "Mon") return;
  const nowMinuteOfDay = now.hour * 60 + now.minute;

  for (const schedule of schedules) {
    const dueMinuteOfDay = schedule.runHourIst * 60 + schedule.runMinuteIst;
    if (nowMinuteOfDay < dueMinuteOfDay || nowMinuteOfDay >= dueMinuteOfDay + 5) continue;

    const lastRunKey = schedule.lastRunAt ? istParts(schedule.lastRunAt).dateKey : null;
    if (lastRunKey === now.dateKey) continue; // already fired this Monday

    fireSchedule(schedule, now.dateKey).catch((err) =>
      logger.error({ err, scheduleId: schedule.id }, "report-scheduler: unhandled error"),
    );
  }
}

export function startReportScheduler(): void {
  setInterval(() => {
    tick().catch((err) => logger.error({ err }, "report-scheduler: tick failed"));
  }, CHECK_INTERVAL_MS);
  // One check shortly after boot too, in case a restart landed mid-window.
  setTimeout(() => {
    tick().catch((err) => logger.error({ err }, "report-scheduler: initial tick failed"));
  }, 30_000);
  logger.info("report-scheduler: started (checks every 5 min, fires Mondays IST)");
}
