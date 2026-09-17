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
  AEO_QUERIES?: string[];
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
  /** Cooperative-cancellation signal — checked between pipeline stages. */
  signal?: AbortSignal;
}
export interface ReportApiCost {
  counts: Record<string, number>;
  linesUSD: Record<string, number>;
  unitRates: Record<string, number>;
  totalUSD: number;
  totalINR: number;
  usdToInr: number;
}
export interface ReportTrendScores {
  sovScore: number;
  pressShare: number;
  llmShare: number;
  socialShare: number;
  articles: number;
  aeo: number;
  social: number;
}
export interface ReportTrendSummary {
  dateFrom: string;
  dateTo: string;
  generatedAt: string;
  orgs: string[];
  scores: Record<string, ReportTrendScores>;
}
export interface RunResult {
  htmlName: string;
  pptxName: string;
  /** Real metered/estimated API cost of producing this report. */
  cost?: ReportApiCost;
  /** Per-org SoV/AEO/social scores for this report — feeds the trends dashboard. */
  trendSummary?: ReportTrendSummary;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = _pipeline as any;
export const run: (cfg: RunConfig, cb: RunCallback) => Promise<RunResult> =
  mod.run ?? mod.default?.run;
