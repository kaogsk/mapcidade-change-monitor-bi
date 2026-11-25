// Session: a signed token in an httpOnly cookie (HMAC-SHA256 over a small JSON payload), a gate
// in front of EVERYTHING (static files included) with an explicit exempt list, and the sign-in /
// sign-out log in bi_access.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { BiDb } from "../db/bi.js";
import { dayIn } from "../lib/dates.js";
import type { Authenticator } from "./directory.js";

export interface Session {
  username: string;
  name: string;
  /** bi_access.id of this sign-in */
  aid: number | null;
  exp: number;
}

export const COOKIE = "cmbi_token";

/** The minimum the login page needs. Everything else (screens, JS, API) requires a session. */
export const EXEMPT = ["/login.html", "/auth/", "/health", "/assets/css/", "/assets/img/"];

export interface Auth {
  gate(req: Request, res: Response, next: NextFunction): void;
  sessionOf(req: Request): Session | null;
  login(username: string, password: string, meta: { ip: string | null; userAgent: string | null }): Promise<{ status: number; body: unknown; cookie: string | null }>;
  logout(req: Request): string;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function encodeToken(secret: string, s: Session): string {
  const payload = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export function decodeToken(secret: string, token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const want = Buffer.from(sign(secret, payload));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    return typeof s.username === "string" && typeof s.exp === "number" && s.exp > now ? s : null;
  } catch {
    return null;
  }
}

function cookieOf(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export interface AuthOptions {
  secret: string;
  ttlSeconds: number;
  directory: Authenticator;
  bi: BiDb;
  secureCookie?: boolean;
}

export function createSessionAuth(o: AuthOptions): Auth {
  const sessionOf = (req: Request) => decodeToken(o.secret, cookieOf(req, COOKIE));
  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${o.secureCookie ? "; Secure" : ""}`;
  return {
    sessionOf,
    gate(req, res, next) {
      if (EXEMPT.some((p) => req.path === p || (p.endsWith("/") && req.path.startsWith(p)))) return next();
      const s = sessionOf(req);
      if (s) {
        (req as Request & { user?: Session }).user = s;
        return next();
      }
      if (req.path.startsWith("/api/")) {
        res.status(401).json({ error: "not signed in" });
        return;
      }
      res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
    },
    async login(username, password, meta) {
      if (!username || !password) return { status: 400, body: { error: "username and password required" }, cookie: null };
      const who = await o.directory.authenticate(username, password);
      if (!who) return { status: 401, body: { error: "invalid username or password" }, cookie: null };
      const now = new Date();
      let aid: number | null = null;
      try {
        aid = o.bi.run(
          "INSERT INTO bi_access (username, ip, user_agent, signed_in_at, local_day) VALUES ($u, $ip, $ua, $at, $d)",
          { u: who.username, ip: meta.ip, ua: meta.userAgent?.slice(0, 300) ?? null, at: now.toISOString(), d: dayIn(o.bi.tz, now) },
        ).lastId;
      } catch (e) {
        // the access log never blocks a sign-in
        console.error(`[auth] bi_access insert failed: ${e instanceof Error ? e.message : e}`);
      }
      const s: Session = { username: who.username, name: who.name, aid, exp: Date.now() + o.ttlSeconds * 1000 };
      return { status: 200, body: { ok: true, username: who.username, name: who.name }, cookie: cookie(encodeToken(o.secret, s), o.ttlSeconds) };
    },
    logout(req) {
      const s = sessionOf(req);
      if (s?.aid) {
        try {
          o.bi.run(
            `UPDATE bi_access SET signed_out_at = $at,
                    duration_seconds = CAST((julianday($at) - julianday(signed_in_at)) * 86400 AS INTEGER)
              WHERE id = $id AND signed_out_at IS NULL`,
            { at: new Date().toISOString(), id: s.aid },
          );
        } catch {
          /* best effort */
        }
      }
      return cookie("", 0);
    },
  };
}

/** AUTH_DISABLED=1 stand-in: lets everything through as a fixed local user. */
export function devAuth(username = "dev"): Auth {
  const s: Session = { username, name: "Local developer", aid: null, exp: Number.MAX_SAFE_INTEGER };
  return {
    sessionOf: () => s,
    gate(req, _res, next) {
      (req as Request & { user?: Session }).user = s;
      next();
    },
    async login() {
      return { status: 200, body: { ok: true, dev: true }, cookie: null };
    },
    logout: () => `${COOKIE}=; Path=/; Max-Age=0`,
  };
}
