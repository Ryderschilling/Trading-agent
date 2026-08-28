import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

// -----------------------------------------------------------------------------
// Web UI auth
//
// Modes (resolved at request time, in this order):
//   1) AUTH_USERNAME + AUTH_PASSWORD set  → username/password login
//      - On /api/login, server sets an HMAC-signed cookie `agent_auth`
//        with Max-Age (default 30 days) so it survives browser restarts.
//      - Cookie value: `<urlencoded-username>.<expiryMs>.<hmacHex>`
//        HMAC key: AUTH_PASSWORD. Stateless, persists across server restarts
//        as long as AUTH_PASSWORD doesn't change. Changing the password
//        invalidates all outstanding sessions, which is what we want.
//   2) AGENT_SECRET set (legacy) → single-token mode, cookie `agent_token`
//   3) Neither set → dev mode, all requests allowed
// -----------------------------------------------------------------------------

let warnedOnce = false;

const AUTH_COOKIE = "agent_auth";
const LEGACY_COOKIE = "agent_token";

// -----------------------------------------------------------------------------
// INVESTOR ROLE (2026-08-27)
//
// A second, strictly read-only identity. Set INVESTOR_PASSWORD and an investor
// can sign in at /investor/login and see ONLY the pages and endpoints listed in
// INVESTOR_ALLOWED below. There is no username: one shared password, one view.
//
// The investor cookie is signed with INVESTOR_PASSWORD, so it is cryptographically
// incapable of authorizing an owner route, and rotating that password logs every
// investor out without touching the owner session.
//
// An investor who lands anywhere else is redirected to /investor, never shown a
// 404 or a control they cannot use.
// -----------------------------------------------------------------------------
const INVESTOR_COOKIE = "investor_auth";

const INVESTOR_EXCLUDED = new Set([
  "/investor/login",
  "/api/investor/login",
  "/api/investor/logout",
]);

function isInvestorPath(pathname: string): boolean {
  if (pathname === "/investor") return true;
  if (pathname.startsWith("/investor/")) return true;
  if (pathname.startsWith("/api/investor/")) return true;
  return false;
}

const EXCLUDED_PATHS = new Set([
  "/login",
  "/login.html",
  "/api/login",
  "/api/logout",
]);

// Static asset extensions — always pass through so the login page renders.
const STATIC_EXT_RE =
  /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map|webp)(\?.*)?$/i;

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function sign(payload: string, key: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("hex");
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Cookie helpers (used by /api/login in http.ts)
// -----------------------------------------------------------------------------

export function getAuthMode(): "userpass" | "token" | "open" {
  const user = process.env.AUTH_USERNAME || "";
  const pass = process.env.AUTH_PASSWORD || "";
  if (user && pass) return "userpass";
  if (process.env.AGENT_SECRET) return "token";
  return "open";
}

export function getCookieTtlMs(): number {
  const days = Number(process.env.AUTH_COOKIE_DAYS || 30);
  const safe = Number.isFinite(days) && days > 0 ? days : 30;
  return safe * 24 * 60 * 60 * 1000;
}

export function createAuthCookie(username: string): string {
  const pass = process.env.AUTH_PASSWORD || "";
  const ttl = getCookieTtlMs();
  const exp = Date.now() + ttl;
  const payload = `${encodeURIComponent(username)}.${exp}`;
  const sig = sign(payload, pass);
  const value = `${payload}.${sig}`;
  const maxAgeSec = Math.floor(ttl / 1000);
  // Secure flag only in production — locally we serve over http.
  const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${AUTH_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secureFlag}`;
}

export function clearAuthCookie(): string {
  return `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function investorAuthEnabled(): boolean {
  return Boolean(process.env.INVESTOR_PASSWORD);
}

export function createInvestorCookie(): string {
  const pass = process.env.INVESTOR_PASSWORD || "";
  const ttl = getCookieTtlMs();
  const exp = Date.now() + ttl;
  const payload = `investor.${exp}`;
  const value = `${payload}.${sign(payload, pass)}`;
  const maxAgeSec = Math.floor(ttl / 1000);
  const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${INVESTOR_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secureFlag}`;
}

export function clearInvestorCookie(): string {
  return `${INVESTOR_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function verifyInvestorCookie(value: string): boolean {
  const pass = process.env.INVESTOR_PASSWORD || "";
  if (!pass) return false;

  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [who, expStr, sig] = parts;
  if (who !== "investor") return false;

  if (!timingSafeEq(sig, sign(`${who}.${expStr}`, pass))) return false;

  const exp = Number(expStr);
  return Number.isFinite(exp) && exp >= Date.now();
}

/** True when the request carries a valid owner session. */
export function hasOwnerSession(req: Request): boolean {
  const mode = getAuthMode();
  if (mode === "open") return true;

  const cookies = parseCookies(req.header("Cookie") || "");
  if (mode === "userpass") {
    const raw = cookies[AUTH_COOKIE];
    return Boolean(raw && verifyAuthCookie(decodeURIComponent(raw)));
  }

  const secret = process.env.AGENT_SECRET || "";
  if (!secret) return false;
  const authHeader = req.header("Authorization") || "";
  if (authHeader.startsWith("Bearer ") && authHeader.slice(7).trim() === secret) return true;
  return cookies[LEGACY_COOKIE] === secret;
}

/** True when the request carries a valid investor session. */
export function hasInvestorSession(req: Request): boolean {
  const raw = parseCookies(req.header("Cookie") || "")[INVESTOR_COOKIE];
  return Boolean(raw && verifyInvestorCookie(decodeURIComponent(raw)));
}

function verifyAuthCookie(value: string): { username: string } | null {
  const pass = process.env.AUTH_PASSWORD || "";
  if (!pass) return null;

  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userEnc, expStr, sig] = parts;
  const payload = `${userEnc}.${expStr}`;
  const expected = sign(payload, pass);
  if (!timingSafeEq(sig, expected)) return null;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;

  let username = "";
  try {
    username = decodeURIComponent(userEnc);
  } catch {
    return null;
  }

  // Username in cookie must still match the configured username — protects
  // against stale cookies if the username is rotated.
  const configured = process.env.AUTH_USERNAME || "";
  if (username !== configured) return null;

  return { username };
}

// -----------------------------------------------------------------------------
// Brute-force throttle for /api/login
// -----------------------------------------------------------------------------

type Attempt = { count: number; lockedUntil: number };
const attempts = new Map<string, Attempt>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;
const LOCKOUT_MS = 5 * 60 * 1000;

function clientIp(req: Request): string {
  const xff = String(req.header("x-forwarded-for") || "").split(",")[0].trim();
  return xff || req.ip || req.socket?.remoteAddress || "unknown";
}

export function isLoginLocked(req: Request): { locked: boolean; retryAfterSec: number } {
  const ip = clientIp(req);
  const a = attempts.get(ip);
  if (!a) return { locked: false, retryAfterSec: 0 };
  const now = Date.now();
  if (a.lockedUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((a.lockedUntil - now) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

export function recordLoginFailure(req: Request): void {
  const ip = clientIp(req);
  const now = Date.now();
  const prev = attempts.get(ip);
  if (!prev || now - (prev.lockedUntil - LOCKOUT_MS) > WINDOW_MS) {
    attempts.set(ip, { count: 1, lockedUntil: 0 });
    return;
  }
  const count = prev.count + 1;
  const lockedUntil = count >= MAX_ATTEMPTS ? now + LOCKOUT_MS : 0;
  attempts.set(ip, { count, lockedUntil });
}

export function recordLoginSuccess(req: Request): void {
  attempts.delete(clientIp(req));
}

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

function wantsJson(req: Request): boolean {
  if (req.path.startsWith("/api/")) return true;
  if (req.xhr) return true;
  const accept = String(req.header("Accept") || "");
  if (accept.includes("application/json") && !accept.includes("text/html")) return true;
  return false;
}

function unauthorized(req: Request, res: Response): void {
  if (wantsJson(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // Preserve the original destination so we can bounce back after login.
  const next = encodeURIComponent(req.originalUrl || "/");
  res.redirect(302, `/login?next=${next}`);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const mode = getAuthMode();

  // ──────────────────────────────────────────────────────────────────────────
  // INVESTOR ROUTING — runs before owner auth so the two roles never blur.
  // ──────────────────────────────────────────────────────────────────────────
  if (INVESTOR_EXCLUDED.has(req.path)) return next();

  const investorSession = hasInvestorSession(req);

  if (isInvestorPath(req.path)) {
    // The investor view is readable by the investor and by the owner.
    if (investorSession) return next();
    if (hasOwnerSession(req)) return next();
    if (!investorAuthEnabled()) {
      // No INVESTOR_PASSWORD configured — the view is owner-only.
      return unauthorized(req, res);
    }
    if (wantsJson(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.redirect(302, "/investor/login");
    return;
  }

  // An investor session anywhere else gets sent home. It can never fall through
  // to the owner checks below, so a leaked investor password cannot reach the
  // broker controls, the rules editor, or the kill switch.
  if (investorSession && !hasOwnerSession(req)) {
    // Static assets are inert UI code, not data — let them load so the
    // investor page can pull fonts and stylesheets.
    if (STATIC_EXT_RE.test(req.path)) return next();
    if (wantsJson(req)) {
      res.status(403).json({ error: "forbidden", role: "investor" });
      return;
    }
    res.redirect(302, "/investor");
    return;
  }

  if (mode === "open") {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[auth] No AUTH_USERNAME/AUTH_PASSWORD (or AGENT_SECRET) — running in dev mode (all requests allowed)"
      );
    }
    return next();
  }

  if (EXCLUDED_PATHS.has(req.path)) return next();
  if (STATIC_EXT_RE.test(req.path)) return next();
  if (req.path.startsWith("/socket.io/")) return next();

  const cookies = parseCookies(req.header("Cookie") || "");

  if (mode === "userpass") {
    const raw = cookies[AUTH_COOKIE];
    if (raw && verifyAuthCookie(decodeURIComponent(raw))) return next();
    return unauthorized(req, res);
  }

  // mode === "token" (legacy AGENT_SECRET)
  const secret = process.env.AGENT_SECRET || "";
  const authHeader = req.header("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === secret) return next();
  }
  const queryToken = String(req.query.token || "");
  if (queryToken && queryToken === secret) return next();
  if (cookies[LEGACY_COOKIE] === secret) return next();

  return unauthorized(req, res);
}
