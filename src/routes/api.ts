// /api/*: one GET per screen. All screens take the same global filters (queries/filters.ts).
import { type Request, type Response, Router } from "express";
import type { BiDb } from "../db/bi.js";
import { dayIn } from "../lib/dates.js";
import { beforeAfter, edits, parseEditFilter } from "../queries/edits.js";
import { parseClicks, parseContext } from "../queries/filters.js";
import { history, loads, meta, usage } from "../queries/misc.js";
import { matrices, monitor, response } from "../queries/monitor.js";
import { registerRouter } from "./register.js";

export function apiRouter(bi: BiDb, opts: { editors: string[]; clock?: () => Date }): Router {
  const r = Router();
  const today = () => dayIn(bi.tz, opts.clock?.() ?? new Date());
  const send = (fn: (req: Request) => unknown) => (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(fn(req));
  };

  r.get("/meta", send(() => meta(bi)));
  r.get("/monitor", send((req) => ({ ...monitor(bi, parseContext(req.query), parseClicks(req.query)), ...matrices(bi, parseContext(req.query), parseClicks(req.query)) })));
  r.get("/response", send((req) => response(bi, parseContext(req.query), today())));
  r.get("/edits", send((req) => edits(bi, parseContext(req.query), parseEditFilter(req.query))));
  r.get("/edits/before-after", send((req) => beforeAfter(bi, parseContext(req.query), parseEditFilter(req.query), today())));
  r.get("/history", send((req) => history(bi, parseContext(req.query))));
  r.get("/loads", send(() => loads(bi)));
  r.get("/usage-report", send(() => usage(bi)));
  r.use("/register", registerRouter(bi, opts.editors));
  return r;
}
