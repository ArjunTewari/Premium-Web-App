import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("JWT_SECRET environment variable must be set in production");
}
const _JWT_SECRET = JWT_SECRET ?? "emerald-dev-jwt-secret-local-only";
const FULL_AUTH_EXPIRY = "24h";
const PENDING_AUTH_EXPIRY = "10m";

export interface JwtPayload {
  userId: number;
  username: string;
  role: string;
  stage: "full" | "pending";
}

export function signFullToken(payload: Omit<JwtPayload, "stage">): string {
  return jwt.sign({ ...payload, stage: "full" }, _JWT_SECRET, {
    expiresIn: FULL_AUTH_EXPIRY,
  });
}

export function signPendingToken(payload: Omit<JwtPayload, "stage">): string {
  return jwt.sign({ ...payload, stage: "pending" }, _JWT_SECRET, {
    expiresIn: PENDING_AUTH_EXPIRY,
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, _JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

export const COOKIE_NAME = "emerald_auth";
export const COOKIE_PENDING = "emerald_pending";

export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 24 * 60 * 60 * 1000,
};

export const PENDING_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 10 * 60 * 1000,
};

export interface ClientBilling {
  /** Amount billed to the client for this report, INR. */
  costInr: number;
  /** The per-org-per-month rate this report was billed at (INR, 52.00–53.00). */
  perOrgMonthInr: number;
  numOrgs: number;
  months: number;
}

// Client billing rate: a random value between ₹52 and ₹53 per org per month,
// chosen once per report and applied uniformly across all org-months.
const CLIENT_RATE_MIN_INR = 52;
const CLIENT_RATE_MAX_INR = 53;

/** Months spanned by [dateFrom, dateTo], minimum 1 (30-day months). */
export function billingMonths(dateFrom: string, dateTo: string): number {
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  const days = Math.max(
    1,
    Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24))
  );
  return Math.max(1, Math.ceil(days / 30));
}

export function calculateClientBilling(
  orgs: string[],
  dateFrom: string,
  dateTo: string
): ClientBilling {
  const months = billingMonths(dateFrom, dateTo);
  const numOrgs = Math.max(1, orgs.length);
  const perOrgMonthInr =
    Math.round(
      (CLIENT_RATE_MIN_INR + Math.random() * (CLIENT_RATE_MAX_INR - CLIENT_RATE_MIN_INR)) * 100
    ) / 100;
  const costInr = Math.round(numOrgs * months * perOrgMonthInr * 100) / 100;
  return { costInr, perOrgMonthInr, numOrgs, months };
}

// Back-compat: some call sites / the report log still expect the old shape.
// Client cost is now the real billing figure; the per-service fields are left
// as zero here — the true API cost breakdown comes from the pipeline
// (`RunResult.cost`) and is written to the report log by the /run route.
export interface ReportCosts {
  costInr: number;
  costSerperInr: number;
  costLlmAeoInr: number;
  costClaudeInr: number;
  costYoutubeInr: number;
  costStorageInr: number;
  costDeploymentInr: number;
}

export function calculateReportCosts(
  orgs: string[],
  dateFrom: string,
  dateTo: string
): ReportCosts {
  const { costInr } = calculateClientBilling(orgs, dateFrom, dateTo);
  return {
    costInr,
    costSerperInr: 0,
    costLlmAeoInr: 0,
    costClaudeInr: 0,
    costYoutubeInr: 0,
    costStorageInr: 0,
    costDeploymentInr: 0,
  };
}
