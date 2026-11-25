// /api/register/*: the Register screen (replaces filling in the control spreadsheet).
//   GET    /register                     definitions, suggestions, contracts, whether the user can edit
//   GET    /register/history             latest changes (?entity=&key=&limit=)
//   GET    /register/export.csv          one tab as CSV (?entity=), Excel-friendly
//   GET    /register/:entity             rows
//   POST   /register/:entity             create
//   PUT    /register/:entity/:key        update (body carries `version`; 409 if someone saved first)
//   DELETE /register/:entity/:key        delete (?version=)
import { type NextFunction, type Request, type Response, Router } from "express";
import type { BiDb } from "../db/bi.js";
import type { Session } from "../auth/session.js";
import { entityOf } from "../register/definitions.js";
import { create, definitions, history, list, RegisterError, remove, update } from "../register/service.js";

const userOf = (req: Request): string | null => (req as Request & { user?: Session }).user?.username ?? null;

/** Empty editors list = every signed-in user edits; otherwise only the listed logins. */
export function canEdit(editors: string[], user: string | null): boolean {
  if (!editors.length) return true;
  return !!user && editors.includes(user.toLowerCase());
}

type Handler = (req: Request, res: Response) => unknown;
const json = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = fn(req, res);
    if (res.headersSent) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
  } catch (e) {
    if (e instanceof RegisterError) {
      res.status(e.status).json({ error: e.message, ...e.extra });
      return;
    }
    next(e);
  }
};

function entity(req: Request) {
  const e = entityOf(String(req.params.entity ?? req.query.entity));
  if (!e) throw new RegisterError(404, "unknown register");
  return e;
}

/** CSV with ; separator and BOM: opens straight in a pt-BR Excel. */
export function toCsv(columns: { id: string; label: string }[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = Array.isArray(v) ? v.join(", ") : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(";"), ...rows.map((r) => columns.map((c) => cell(r[c.id])).join(";"))];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function registerRouter(bi: BiDb, editors: string[]): Router {
  const r = Router();
  const requireEditor = (req: Request) => {
    if (!canEdit(editors, userOf(req))) throw new RegisterError(403, "Your user can only view the register. Ask the BI owner for edit access.");
  };

  r.get("/", json((req) => ({ ...definitions(bi), canEdit: canEdit(editors, userOf(req)) })));

  r.get("/history", json((req) => history(bi, {
    entity: typeof req.query.entity === "string" ? req.query.entity : undefined,
    key: typeof req.query.key === "string" ? req.query.key : undefined,
    limit: Number(req.query.limit) || undefined,
  })));

  r.get("/export.csv", (req, res, next) => {
    try {
      const e = entity(req);
      const cols = [{ id: e.key, label: e.key }, ...e.fields.filter((f) => f.id !== e.key).map((f) => ({ id: f.id, label: f.sheet ?? f.label }))];
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="register-${e.id}-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(toCsv(cols, list(bi, e)));
    } catch (err) {
      if (err instanceof RegisterError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  r.get("/:entity", json((req) => ({ rows: list(bi, entity(req)) })));

  r.post("/:entity", json((req, res) => {
    requireEditor(req);
    const out = create(bi, entity(req), (req.body ?? {}) as Record<string, unknown>, userOf(req));
    res.status(201);
    return out;
  }));

  r.put("/:entity/:key", json((req) => {
    requireEditor(req);
    return update(bi, entity(req), String(req.params.key), (req.body ?? {}) as Record<string, unknown>, userOf(req));
  }));

  r.delete("/:entity/:key", json((req) => {
    requireEditor(req);
    return remove(bi, entity(req), String(req.params.key), req.query.version, userOf(req));
  }));

  return r;
}
