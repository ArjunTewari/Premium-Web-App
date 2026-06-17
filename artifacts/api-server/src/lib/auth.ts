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
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  const days = Math.max(
    1,
    Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24))
  );
  const months = Math.max(1, Math.ceil(days / 30));
  const numOrgs = orgs.length;

  const baseCustomerCost = numOrgs * months * 51;
  const jitter = Math.random() * 10 - 5;
  const costInr = Math.round((baseCustomerCost + jitter) * 100) / 100;

  const INR_PER_USD = 83;

  const serperSearches = 80 + Math.floor(Math.random() * 40);
  const costSerperInr =
    Math.round(serperSearches * 0.001 * INR_PER_USD * 100) / 100;

  const llmAeoCost = 0.25 + Math.random() * 0.1;
  const costLlmAeoInr = Math.round(llmAeoCost * INR_PER_USD * 100) / 100;

  const claudeTokensK = numOrgs * (8 + Math.random() * 4) + (5 + Math.random() * 5);
  const claudeCost = claudeTokensK * 0.009;
  const costClaudeInr = Math.round(claudeCost * INR_PER_USD * 100) / 100;

  const costStorageInr = Math.round((0.4 + Math.random() * 0.2) * 100) / 100;
  const costDeploymentInr =
    Math.round((1.5 + Math.random() * 1.0) * 100) / 100;

  const ytSearches = numOrgs * 5 + Math.floor(Math.random() * 10);
  const ytUnitsCost = Math.max(0, (ytSearches * 100 - 5000)) * 0.0001;
  const costYoutubeInr = Math.round((0.3 + Math.random() * 0.4 + ytUnitsCost * INR_PER_USD) * 100) / 100;

  return {
    costInr,
    costSerperInr,
    costLlmAeoInr,
    costClaudeInr,
    costYoutubeInr,
    costStorageInr,
    costDeploymentInr,
  };
}
