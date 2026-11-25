// Global filters shared by every screen: municipality[], frequency[], project[] (code), cycle[],
// from, to (YYYY-MM-DD). Click filters of the alert visuals: class[], responsibility[], status[].
//
// Every query receives the same named parameter set ($mun $freq $proj $cyc $from $to $cls $resp $st);
// lists travel as JSON arrays (SQLite has no array type), and an empty list is NULL = no filter.
//
// Where each filter applies:
//   - municipality / frequency / project: define the SET OF PROJECTS (CTE `proj`, from v_project).
//     Everything is linked by project code (contract, schedule, visit, report, alert); edit-log data
//     comes per database: the database where the project's alerts live.
//   - cycle: alerts (project_cycle) and schedule (cycle). Not visits: most visits have no cycle.
//   - period: alerts by acted_on — the old dashboard's date, the alert's LAST update, not the day
//     someone analyzed it (to measure work in a period, use the Edits screen); visits by start,
//     reports by due date, cycles by cycle deadline, edits by day.
import type { Request } from "express";
import { isIsoDay } from "../lib/dates.js";

export interface Context {
  municipalities: string[];
  frequencies: string[];
  projects: string[];
  cycles: string[];
  from: string | null;
  to: string | null;
}

export interface AlertClicks {
  classes: string[];
  responsibilities: string[];
  statuses: string[];
}
export type AlertDim = "class" | "responsibility" | "status";

export const NO_CLICKS: AlertClicks = { classes: [], responsibilities: [], statuses: [] };

function list(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return [...new Set(arr.map((x) => String(x).trim()).filter((x) => x && x.length <= 200))].slice(0, 200);
}

function day(v: unknown): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return isIsoDay(s) ? s : null;
}

export function parseContext(q: Request["query"]): Context {
  let from = day(q.from);
  let to = day(q.to);
  if (from && to && from > to) [from, to] = [to, from];
  return {
    municipalities: list(q.municipality),
    frequencies: list(q.frequency).map((f) => f.toLowerCase()),
    projects: list(q.project),
    cycles: list(q.cycle),
    from,
    to,
  };
}

export function parseClicks(q: Request["query"]): AlertClicks {
  return { classes: list(q.class), responsibilities: list(q.responsibility), statuses: list(q.status) };
}

const arr = (a: string[]) => (a.length ? JSON.stringify(a) : null);

/** The named parameter set every screen query takes. */
export function params(c: Context, k: AlertClicks = NO_CLICKS): Record<string, string | null> {
  return {
    mun: arr(c.municipalities),
    freq: arr(c.frequencies),
    proj: arr(c.projects),
    cyc: arr(c.cycles),
    from: c.from,
    to: c.to,
    cls: arr(k.classes),
    resp: arr(k.responsibilities),
    st: arr(k.statuses),
  };
}

const IN = (col: string, p: string) => `($${p} IS NULL OR ${col} IN (SELECT value FROM json_each($${p})))`;

/** CTE of the filtered projects. Use as `WITH ${PROJ} …`. */
export const PROJ = `proj AS (
  SELECT code, municipality, frequency, database FROM v_project
   WHERE ${IN("municipality", "mun")} AND ${IN("frequency", "freq")} AND ${IN("code", "proj")}
)`;

/** Databases of the filtered projects (for edit-log data). */
export const DBS = `dbs AS (SELECT DISTINCT database FROM proj WHERE database IS NOT NULL)`;

const W_ALERT_BASE = `a.project_code IN (SELECT code FROM proj)
  AND ${IN("a.project_cycle", "cyc")}
  AND ($from IS NULL OR a.acted_on >= $from)
  AND ($to IS NULL OR a.acted_on <= $to)`;

/**
 * WHERE of the alerts (alias `a`) with the click filters. `skip`: the visual's own dimension stays
 * out, like Power BI cross-filtering — the class chart keeps showing every class (the clicked one
 * highlighted) while the rest of the screen filters. "(blank)" is the label of NULL in the charts,
 * so the comparison uses the same coalesce.
 */
export function wAlert(skip?: AlertDim): string {
  const cond: Record<AlertDim, string> = {
    class: IN("coalesce(a.alert_class, '(blank)')", "cls"),
    responsibility: IN("coalesce(a.responsibility, '(blank)')", "resp"),
    status: IN("coalesce(a.status, '(blank)')", "st"),
  };
  const extra = (Object.keys(cond) as AlertDim[]).filter((k) => k !== skip).map((k) => cond[k]);
  return [W_ALERT_BASE, ...extra].join("\n  AND ");
}

/** WHERE of the schedule (alias `g`): cycle and cycle deadline in the period. */
export const W_SCHEDULE = `g.code IN (SELECT code FROM proj)
  AND ${IN("CAST(g.cycle AS TEXT)", "cyc")}
  AND ($from IS NULL OR g.cycle_deadline >= $from)
  AND ($to IS NULL OR g.cycle_deadline <= $to)`;

/** WHERE of the visits (alias `v`). */
export const W_VISIT = `v.code IN (SELECT code FROM proj)
  AND ($from IS NULL OR v.starts_on >= $from)
  AND ($to IS NULL OR v.starts_on <= $to)`;

/** WHERE of the monthly reports (alias `r`). */
export const W_REPORT = `r.project IN (SELECT code FROM proj)
  AND ($from IS NULL OR r.due_on >= $from)
  AND ($to IS NULL OR r.due_on <= $to)`;

/** WHERE of the edit-log tables (alias `e`). */
export const W_EDIT = `e.database IN (SELECT database FROM dbs)
  AND ($from IS NULL OR e.day >= $from)
  AND ($to IS NULL OR e.day <= $to)`;
