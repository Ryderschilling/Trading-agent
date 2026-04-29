import { Request, Response, NextFunction } from "express";

let warnedOnce = false;

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

const EXCLUDED_PATHS = new Set(["/login", "/login.html", "/api/login"]);

// Static asset extensions — always pass through so login page renders correctly
const STATIC_EXT_RE = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map|webp)(\?.*)?$/i;

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.AGENT_SECRET || "";

  if (!secret) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn("[auth] AGENT_SECRET is not set — running in dev mode (all requests allowed)");
    }
    return next();
  }

  if (EXCLUDED_PATHS.has(req.path)) {
    return next();
  }

  // Allow static assets through (CSS, JS, images) so the login page renders
  if (STATIC_EXT_RE.test(req.path)) {
    return next();
  }

  // Socket.IO handshake path
  if (req.path.startsWith("/socket.io/")) {
    return next();
  }

  // Check Authorization: Bearer <token>
  const authHeader = req.header("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === secret) return next();
  }

  // Check ?token= query param
  const queryToken = String(req.query.token || "");
  if (queryToken && queryToken === secret) return next();

  // Check cookie agent_token
  const cookieHeader = req.header("Cookie") || "";
  const cookies = parseCookies(cookieHeader);
  if (cookies["agent_token"] === secret) return next();

  res.status(401).json({ error: "unauthorized" });
}
