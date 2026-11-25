// "Edits & assisted operation" screen:
//   - edits by the monitoring profiles (desktop GIS, field app, import);
//   - alerts analyzed per business day, month by month;
//   - average per business day BEFORE × AFTER each assisted operation (an on-site visit where the
//     team trains the city's staff) — the question the old dashboard could not answer.
import type { Request } from "express";
import type { BiDb } from "../db/bi.js";
import { ASSISTED_OPERATION } from "../register/definitions.js";
import { type Context, DBS, params, PROJ, W_EDIT } from "./filters.js";

export interface EditFilter {
  actions: string[];
  channels: string[];
  moduleOnly: boolean;
  window: number;
}

const ACTIONS = ["insert", "update", "delete"];
const CHANNELS = ["gis", "mobile", "import"];
export const WINDOWS = [30, 60, 90, 180];

export function parseEditFilter(q: Request["query"]): EditFilter {
  const pick = (v: unknown, ok: string[]) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String).filter((x) => ok.includes(x));
  const actions = pick(q.action, ACTIONS);
  const channels = pick(q.channel, CHANNELS);
  const w = Number(q.window);
  return {
    actions: actions.length ? actions : ["insert", "update"],
    channels: channels.length ? channels : ["gis", "mobile"],
    moduleOnly: q.module !== "0",
    window: WINDOWS.includes(w) ? w : 90,
  };
}

const W_ED = `${W_EDIT}
  AND e.action IN (SELECT value FROM json_each($actions))
  AND e.channel IN (SELECT value FROM json_each($channels))
  AND (NOT $moduleOnly OR e.module_table)`;
const W_AN = `${W_EDIT} AND e.channel IN (SELECT value FROM json_each($channels))`;
const WITH = `WITH ${PROJ}, ${DBS}`;

function editParams(c: Context, f: EditFilter) {
  return { ...params(c), actions: JSON.stringify(f.actions), channels: JSON.stringify(f.channels), moduleOnly: f.moduleOnly ? 1 : 0 };
}

export function edits(bi: BiDb, c: Context, f: EditFilter) {
  const p = editParams(c, f);
  const kpi = bi.get<{ total: number; mobile: number; gis: number; users: number }>(
    `${WITH}
     SELECT coalesce(sum(n), 0) AS total, coalesce(sum(CASE WHEN channel = 'mobile' THEN n END), 0) AS mobile,
            coalesce(sum(CASE WHEN channel = 'gis' THEN n END), 0) AS gis, count(DISTINCT database || '|' || username) AS users
       FROM edit_day e WHERE ${W_ED}`,
    p,
  );
  // Alerts analyzed ÷ business days of the period (no period: first to last day with analyses).
  const an = bi.get<{ alerts: number; first: string | null; last: string | null; business_days: number | null }>(
    `${WITH}, x AS (SELECT e.day, e.alerts FROM alert_analyzed_day e WHERE ${W_AN})
     SELECT coalesce(sum(alerts), 0) AS alerts, min(day) AS first, max(day) AS last,
            business_days(coalesce($from, min(day)), coalesce($to, max(day))) AS business_days
       FROM x`,
    p,
  );
  const byMonth = bi.all<{ month: string; channel: string; n: number }>(
    `${WITH} SELECT substr(e.day, 1, 7) AS month, e.channel, sum(e.n) AS n FROM edit_day e WHERE ${W_ED} GROUP BY 1, 2 ORDER BY 1, 2`,
    p,
  );
  const byWeek = bi.all<{ week: string; channel: string; n: number }>(
    `${WITH}
     SELECT date(e.day, '-' || ((CAST(strftime('%w', e.day) AS INTEGER) + 6) % 7) || ' days') AS week, e.channel, sum(e.n) AS n
       FROM edit_day e WHERE ${W_ED} GROUP BY 1, 2 ORDER BY 1, 2`,
    p,
  );
  // Alerts analyzed in the month ÷ business days of the month (holidays + weekends out).
  const analyzedMonth = bi
    .all<{ month: string; alerts: number; business_days: number }>(
      `${WITH}, m AS (SELECT substr(e.day, 1, 7) AS month, sum(e.alerts) AS alerts FROM alert_analyzed_day e WHERE ${W_AN} GROUP BY 1)
       SELECT month, alerts, business_days(month || '-01', date(month || '-01', '+1 month', '-1 day')) AS business_days
         FROM m ORDER BY 1`,
      p,
    )
    .map((x) => ({ ...x, perBusinessDay: x.business_days ? x.alerts / x.business_days : null }));
  const byProfile = bi.all(
    `${WITH} SELECT e.profile AS label, sum(e.n) AS n FROM edit_day e WHERE ${W_ED} GROUP BY 1 ORDER BY 2 DESC LIMIT 200`,
    p,
  );
  const byUser = bi.all(
    `${WITH}
     SELECT e.username AS label, max(m.city) AS city, sum(e.n) AS n,
            coalesce(sum(CASE WHEN e.channel = 'mobile' THEN e.n END), 0) AS mobile, max(e.day) AS last_day
       FROM edit_day e LEFT JOIN monitored_db m ON m.database = e.database
      WHERE ${W_ED} GROUP BY e.database, e.username ORDER BY 3 DESC LIMIT 300`,
    p,
  );
  const assisted = bi.all(
    `${WITH}
     SELECT v.code, v.municipality, v.cycle, v.starts_on AS start, coalesce(v.ends_on, v.starts_on) AS end, v.responsible
       FROM site_visit v
      WHERE v.code IN (SELECT code FROM proj) AND v.reason = $opa AND v.starts_on IS NOT NULL
      ORDER BY v.starts_on`,
    { ...p, opa: ASSISTED_OPERATION },
  );
  return {
    filter: f,
    kpis: {
      edits: kpi?.total ?? 0,
      mobile: kpi?.mobile ?? 0,
      gis: kpi?.gis ?? 0,
      users: kpi?.users ?? 0,
      alertsAnalyzed: an?.alerts ?? 0,
      businessDays: an?.business_days ?? 0,
      analyzedPerBusinessDay: an?.business_days ? an.alerts / an.business_days : null,
    },
    byMonth,
    byWeek,
    analyzedMonth,
    byProfile,
    byUser,
    assisted,
  };
}

/**
 * Before × after each assisted operation: average per business day of edits and of alerts
 * analyzed in the project's database (the edit log is per database: two projects in one city see
 * the same numbers). Before = [start − window, start − 1]; after = [end + 1, end + window], cut at
 * yesterday (`partial`).
 */
export function beforeAfter(bi: BiDb, c: Context, f: EditFilter, today: string) {
  const p = { ...editParams(c, f), w: f.window, today, opa: ASSISTED_OPERATION };
  const rows = bi.all<Record<string, number | string | null>>(
    `${WITH}, opa AS (
       SELECT v.code, v.municipality, v.cycle, v.starts_on AS s, coalesce(v.ends_on, v.starts_on) AS e, pj.database
         FROM site_visit v JOIN proj pj ON pj.code = v.code
        WHERE v.reason = $opa AND v.starts_on IS NOT NULL
          AND ($from IS NULL OR v.starts_on >= $from) AND ($to IS NULL OR v.starts_on <= $to)
     ), win AS (
       SELECT o.*, date(o.s, '-' || $w || ' days') AS b_from, date(o.s, '-1 day') AS b_to,
              date(o.e, '+1 day') AS a_from,
              min(date(o.e, '+' || $w || ' days'), date($today, '-1 day')) AS a_to,
              date(o.e, '+' || $w || ' days') AS a_full
         FROM opa o
     )
     SELECT j.code, j.municipality, j.cycle, j.s AS start, j.e AS end, j.database,
            j.a_to < j.a_full AS partial,
            business_days(j.b_from, j.b_to) AS bd_before,
            CASE WHEN j.a_to >= j.a_from THEN business_days(j.a_from, j.a_to) ELSE 0 END AS bd_after,
            (SELECT coalesce(sum(e.n), 0) FROM edit_day e WHERE e.database = j.database AND e.day BETWEEN j.b_from AND j.b_to
                AND e.action IN (SELECT value FROM json_each($actions)) AND e.channel IN (SELECT value FROM json_each($channels))
                AND (NOT $moduleOnly OR e.module_table)) AS ed_before,
            (SELECT coalesce(sum(e.n), 0) FROM edit_day e WHERE e.database = j.database AND e.day BETWEEN j.a_from AND j.a_to
                AND e.action IN (SELECT value FROM json_each($actions)) AND e.channel IN (SELECT value FROM json_each($channels))
                AND (NOT $moduleOnly OR e.module_table)) AS ed_after,
            (SELECT coalesce(sum(e.n), 0) FROM edit_day e WHERE e.database = j.database AND e.day BETWEEN j.b_from AND j.b_to
                AND e.channel = 'mobile' AND e.action IN (SELECT value FROM json_each($actions))
                AND (NOT $moduleOnly OR e.module_table)) AS mob_before,
            (SELECT coalesce(sum(e.n), 0) FROM edit_day e WHERE e.database = j.database AND e.day BETWEEN j.a_from AND j.a_to
                AND e.channel = 'mobile' AND e.action IN (SELECT value FROM json_each($actions))
                AND (NOT $moduleOnly OR e.module_table)) AS mob_after,
            (SELECT coalesce(sum(e.alerts), 0) FROM alert_analyzed_day e WHERE e.database = j.database
                AND e.day BETWEEN j.b_from AND j.b_to AND e.channel IN (SELECT value FROM json_each($channels))) AS al_before,
            (SELECT coalesce(sum(e.alerts), 0) FROM alert_analyzed_day e WHERE e.database = j.database
                AND e.day BETWEEN j.a_from AND j.a_to AND e.channel IN (SELECT value FROM json_each($channels))) AS al_after,
            (SELECT min(day) FROM edit_day e WHERE e.database = j.database) AS log_since,
            j.b_from
       FROM win j
      ORDER BY j.s DESC`,
    p,
  );
  const avg = (n: unknown, d: unknown) => (Number(d) > 0 ? Number(n) / Number(d) : null);
  return {
    window: f.window,
    rows: rows.map((x) => ({
      code: x.code,
      municipality: x.municipality,
      cycle: x.cycle,
      start: x.start,
      end: x.end,
      partial: !!x.partial,
      // edit log starts after the "before" window opens: the comparison would be unfair
      noLogBefore: !x.log_since || String(x.log_since) > String(x.b_from),
      businessDaysBefore: x.bd_before,
      businessDaysAfter: x.bd_after,
      editsBefore: avg(x.ed_before, x.bd_before),
      editsAfter: avg(x.ed_after, x.bd_after),
      mobileBefore: avg(x.mob_before, x.bd_before),
      mobileAfter: avg(x.mob_after, x.bd_after),
      analyzedBefore: avg(x.al_before, x.bd_before),
      analyzedAfter: avg(x.al_after, x.bd_after),
      totals: { editsBefore: x.ed_before, editsAfter: x.ed_after, analyzedBefore: x.al_before, analyzedAfter: x.al_after },
    })),
  };
}
