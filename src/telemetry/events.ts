// Usage of the BI per screen, in bi_event (complements bi_access, which only has sign-in/out):
//   query    middleware on /api: each GET of a screen's API, with filters, status and duration
//   screen   POST /api/usage from the front when a screen mounts
//   export   POST /api/usage from the front (CSV, image, print) and the server-side downloads
// Like bi_access, a failed write only goes to the log: it never delays or breaks the response.
import type { NextFunction, Request, Response } from "express";
import type { BiDb } from "../db/bi.js";
import { dayIn } from "../lib/dates.js";
import { errorText } from "../lib/redact.js";
import type { Session } from "../auth/session.js";
import { parseClicks, parseContext } from "../queries/filters.js";

export const SCREENS = ["monitor", "response", "edits", "history", "register", "loads", "usage"] as const;
export type Screen = (typeof SCREENS)[number] | "other";
export type EventKind = "screen" | "query" | "export";

export interface UsageEvent {
  username: string;
  accessId: number | null;
  kind: EventKind;
  screen: Screen;
  resource: string | null;
  filters: Record<string, unknown> | null;
  municipalities: number | null;
  httpStatus: number | null;
  durationMs: number | null;
}

export interface EventSink {
  record(ev: UsageEvent): void;
}

const MAX_LIST = 50;
const MAX_TEXT = 120;

export function createEventSink(bi: BiDb, clock: () => Date = () => new Date()): EventSink {
  return {
    record(ev) {
      try {
        const now = clock();
        bi.run(
          `INSERT INTO bi_event (occurred_at, local_day, username, access_id, kind, screen, resource, filters, municipalities, http_status, duration_ms)
           VALUES ($at, $day, $u, $aid, $kind, $screen, $res, $f, $m, $st, $ms)`,
          {
            at: now.toISOString(),
            day: dayIn(bi.tz, now),
            u: ev.username,
            aid: ev.accessId,
            kind: ev.kind,
            screen: ev.screen,
            res: ev.resource,
            f: ev.filters === null ? null : JSON.stringify(ev.filters),
            m: ev.municipalities,
            st: ev.httpStatus,
            ms: ev.durationMs,
          },
        );
      } catch (e) {
        console.error(`[usage] failed to record ${ev.kind} ${ev.screen} of ${ev.username}: ${errorText(e)}`);
      }
    },
  };
}

/** Short text without control characters; empty becomes null. */
export function shortText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT);
  return t || null;
}

/** "/", "/index.html", "/response?x" → screen id; anything else is "other". */
export function screenOfPath(path: string | null | undefined): Screen {
  const p = String(path ?? "").split(/[?#]/)[0]!.replace(/\.html$/, "").replace(/^\/+|\/+$/g, "");
  if (p === "" || p === "index") return "monitor";
  return (SCREENS as readonly string[]).includes(p) ? (p as Screen) : "other";
}

/** Screen an API call came from, by its Referer (path only; the host is ignored). */
export function screenOfReferer(referer: string | undefined): Screen {
  if (!referer) return "other";
  try {
    return screenOfPath(new URL(referer).pathname);
  } catch {
    return "other";
  }
}

/** Filters worth keeping: global + click filters, only what was set, lists capped at 50. */
export function filterSummary(query: Request["query"]): { filters: Record<string, unknown> | null; municipalities: number | null } {
  const c = parseContext(query);
  const k = parseClicks(query);
  const out: Record<string, unknown> = {};
  const lists: [string, string[]][] = [
    ["municipality", c.municipalities],
    ["frequency", c.frequencies],
    ["project", c.projects],
    ["cycle", c.cycles],
    ["class", k.classes],
    ["responsibility", k.responsibilities],
    ["status", k.statuses],
  ];
  for (const [key, v] of lists) if (v.length) out[key] = v.slice(0, MAX_LIST).map((x) => x.slice(0, MAX_TEXT));
  if (c.from) out.from = c.from;
  if (c.to) out.to = c.to;
  return { filters: Object.keys(out).length ? out : null, municipalities: c.municipalities.length || null };
}

/** API routes that are not a screen query (top bar, filter options, the usage beacon itself). */
const IGNORED = new Set(["meta", "usage", "register"]);
const SERVER_EXPORTS: Record<string, { screen: Screen; resource: string }> = {
  "register/export.csv": { screen: "register", resource: "csv:register" },
};

const userOf = (req: Request): Session | undefined => (req as Request & { user?: Session }).user;

/** Middleware mounted on /api after the gate. Records on "finish", never holding the response. */
export function usageMiddleware(sink: EventSink) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const route = req.path.replace(/^\/+|\/+$/g, "");
    if (req.method !== "GET" || IGNORED.has(route)) return next();
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const user = userOf(req);
      if (!user) return;
      const exp = SERVER_EXPORTS[route];
      const { filters, municipalities } = exp ? { filters: null, municipalities: null } : filterSummary(req.query);
      sink.record({
        username: user.username,
        accessId: user.aid,
        kind: exp ? "export" : "query",
        screen: exp ? exp.screen : screenOfReferer(req.get("referer")),
        resource: exp ? exp.resource : route.slice(0, MAX_TEXT),
        filters,
        municipalities,
        httpStatus: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - t0) / 1_000_000n),
      });
    });
    next();
  };
}

/** POST /api/usage { kind: "screen" | "export", screen: "/path" or id, resource? } → 204. */
export function usageRoute(sink: EventSink) {
  return (req: Request, res: Response): void => {
    const user = userOf(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = b.kind === "screen" || b.kind === "export" ? b.kind : null;
    const screen = typeof b.screen === "string" ? screenOfPath(b.screen.startsWith("/") ? b.screen : `/${b.screen}`) : null;
    if (!user || !kind || !screen) {
      res.status(400).json({ error: "invalid event" });
      return;
    }
    const resource = kind === "export" ? shortText(b.resource) : null;
    if (kind === "export" && !resource) {
      res.status(400).json({ error: "export without resource" });
      return;
    }
    sink.record({ username: user.username, accessId: user.aid, kind, screen, resource, filters: null, municipalities: null, httpStatus: null, durationMs: null });
    res.status(204).end();
  };
}
