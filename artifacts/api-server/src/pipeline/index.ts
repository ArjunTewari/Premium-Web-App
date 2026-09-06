/**
 * Pipeline loader — imports CJS pipeline modules via esbuild CJS/ESM interop.
 * These are plain CommonJS modules ported from the Vercel/Node app.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
// @ts-ignore
import _pipeline from "./pipeline.js";

export type RunCallback = (msg: string, level?: string) => void;
export interface RunConfig {
  ORGS: string[];
  DATE_FROM: string;
  DATE_TO: string;
  CLIENT_NAME: string;
  SCOPE_KEYWORDS: string[];
  SERPER_KEY: string;
  CLAUDE_KEY: string;
  OPENAI_KEY?: string;
  PERPLEXITY_KEY?: string;
  GEMINI_KEY?: string;
  YOUTUBE_KEY?: string;
  EXA_API_KEY?: string;
  APIDIRECT_KEY?: string;
  ORG_YT_HANDLES?: Record<string, string>;
  ORG_TW_HANDLES?: Record<string, string>;
  ORG_IG_HANDLES?: Record<string, string>;
  ORG_LI_HANDLES?: Record<string, string>;
  X_BEARER_TOKEN?: string;
  META_ACCESS_TOKEN?: string;
  IG_BUSINESS_ACCOUNT_ID?: string;
  outDir: string;
}
export interface ReportApiCost {
  counts: Record<string, number>;
  linesUSD: Record<string, number>;
  unitRates: Record<string, number>;
  totalUSD: number;
  totalINR: number;
  usdToInr: number;
}
export interface RunResult {
  htmlName: string;
  pptxName: string;
  /** Real metered/estimated API cost of producing this report. */
  cost?: ReportApiCost;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = _pipeline as any;
export const run: (cfg: RunConfig, cb: RunCallback) => Promise<RunResult> =
  mod.run ?? mod.default?.run;
