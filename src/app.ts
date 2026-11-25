import express, { type NextFunction, type Request, type Response } from "express";
import { resolve } from "node:path";
import { type Auth, createSessionAuth, devAuth } from "./auth/session.js";
import { loadDirectory } from "./auth/directory.js";
import type { Config } from "./config.js";
import type { BiDb } from "./db/bi.js";
import { errorText } from "./lib/redact.js";
import { projectRoot, publicDir } from "./paths.js";
import { apiRouter } from "./routes/api.js";
import { createEventSink, type EventSink, usageMiddleware, usageRoute } from "./telemetry/events.js";

export interface AppOptions {
  bi: BiDb;
  config: Config;
  auth?: Auth;
  events?: EventSink;
  clock?: () => Date;
}

export function buildAuth(bi: BiDb, cfg: Config): Auth {
  if (cfg.auth.disabled) {
    console.warn("[auth] AUTH_DISABLED=1 — sign-in gate OFF (local use only).");
    return devAuth();
  }
  return createSessionAuth({
    secret: cfg.auth.sessionSecret,
    ttlSeconds: cfg.auth.sessionTtlHours * 3600,
    directory: loadDirectory(cfg.paths.directory),
    bi,
  });
}

export function buildApp(o: AppOptions): express.Express {
  const auth = o.auth ?? buildAuth(o.bi, o.config);
  const events = o.events ?? createEventSink(o.bi);
  const app = express();
  app.disable("x-powered-by");

  // Gate BEFORE every route, static files included: what is public is the EXEMPT list in
  // auth/session.ts, not the registration order.
  app.use((req, res, next) => auth.gate(req, res, next));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(express.json({ limit: "200kb" }));
  app.post("/auth/login", async (req, res) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const r = await auth.login(typeof b.username === "string" ? b.username.trim() : "", typeof b.password === "string" ? b.password : "", {
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    if (r.cookie) res.setHeader("Set-Cookie", r.cookie);
    res.status(r.status).json(r.body);
  });
  app.post("/auth/logout", (req, res) => {
    res.setHeader("Set-Cookie", auth.logout(req));
    res.json({ ok: true });
  });
  app.get("/auth/me", (req, res) => {
    const s = auth.sessionOf(req);
    if (!s) {
      res.status(401).json({ error: "not signed in" });
      return;
    }
    res.json({ username: s.username, name: s.name });
  });

  // Front-end libraries served from node_modules (no CDN: the real one ran on a VPN without internet).
  app.use("/vendor/echarts", express.static(resolve(projectRoot, "node_modules", "echarts", "dist")));

  app.post("/api/usage", usageRoute(events));
  app.use("/api", usageMiddleware(events));
  app.use("/api", apiRouter(o.bi, { editors: o.config.register.editors, clock: o.clock }));

  app.use(express.static(publicDir, { extensions: ["html"] }));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const st = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
    const status = typeof st === "number" && st >= 400 && st < 600 ? st : 500;
    // driver messages can carry paths or DSNs: sanitized, and only to the log
    console.error(`[app] ${status} on ${req.method} ${req.path}: ${errorText(err)}`);
    if (res.headersSent) return;
    res.status(status).json({ error: status < 500 && err instanceof Error ? errorText(err) : "internal server error" });
  });
  return app;
}
