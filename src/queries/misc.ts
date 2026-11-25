// History (daily snapshot series), Loads (ETL runs), Usage (the BI's own metrics), filter options.
import type { BiDb } from "../db/bi.js";
import { FINISHED, GROUPS, IN_ANALYSIS, PENDING } from "../lib/status.js";
import { type Context, params, PROJ } from "./filters.js";

/**
 * Stock per day and status group. Snapshot rows are STOCK: each day is summed across projects,
 * never across days. The period filters the snapshot day here.
 */
export function history(bi: BiDb, c: Context) {
  const p = params(c);
  const series = bi.all<{ day: string; status_group: string; alerts: number; analyzed: number }>(
    `WITH ${PROJ}
     SELECT s.day, s.status_group, sum(s.alerts) AS alerts, sum(s.analyzed) AS analyzed
       FROM v_alert_stock_day s
      WHERE s.project_code IN (SELECT code FROM proj)
        AND ($from IS NULL OR s.day >= $from) AND ($to IS NULL OR s.day <= $to)
      GROUP BY 1, 2 ORDER BY 1, 2`,
    p,
  );
  // status transitions per day from the history table (flow, complements the stock)
  const transitions = bi.all<{ day: string; status_group: string; n: number }>(
    `WITH ${PROJ}
     SELECT substr(h.since, 1, 10) AS day, coalesce(status_group(h.status), h.status) AS status_group, count(*) AS n
       FROM alert_status_history h
       JOIN alert a ON a.database = h.database AND a.alert_id = h.alert_id
      WHERE h.since IS NOT NULL AND a.project_code IN (SELECT code FROM proj)
        AND ($from IS NULL OR h.since >= $from) AND ($to IS NULL OR substr(h.since, 1, 10) <= $to)
      GROUP BY 1, 2 ORDER BY 1, 2`,
    p,
  );
  return { series, transitions };
}

export function loads(bi: BiDb) {
  const runs = bi
    .all<{ id: number; summary: string } & Record<string, unknown>>(
      "SELECT id, routine, started_at, finished_at, status, summary, error FROM etl_run ORDER BY id DESC LIMIT 40",
    )
    .map((r) => ({ ...r, summary: JSON.parse(r.summary) }));
  const last = runs[0]?.id ?? null;
  const lastByDb = last === null ? [] : bi.all("SELECT database, routine, status, rows, message FROM etl_db WHERE run_id = $id ORDER BY database, routine", { id: last });
  const databases = bi.all(
    `SELECT database, host, active, city, source_id, alerts_loaded_at, alerts_source_at, edits_until, analyses_until
       FROM monitored_db ORDER BY database`,
  );
  return { runs, lastRunId: last, lastByDb, databases };
}

export function usage(bi: BiDb) {
  return {
    monthly: bi.all("SELECT * FROM v_usage_monthly ORDER BY month DESC, screens_opened DESC, username"),
    screens: bi.all("SELECT * FROM v_usage_screen_monthly ORDER BY month DESC, opens DESC, screen"),
    exports: bi.all(
      `SELECT substr(local_day, 1, 7) AS month, resource, count(*) AS n FROM bi_event
        WHERE kind = 'export' GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC`,
    ),
  };
}

/** Options of the global filters + the status grouping (the front colours by group). */
export function meta(bi: BiDb) {
  return {
    municipalities: bi.all<{ v: string }>("SELECT DISTINCT municipality AS v FROM v_project WHERE municipality IS NOT NULL ORDER BY 1").map((r) => r.v),
    frequencies: bi.all<{ v: string }>("SELECT DISTINCT frequency AS v FROM v_project WHERE frequency IS NOT NULL ORDER BY 1").map((r) => r.v),
    projects: bi.all("SELECT code, municipality, frequency, status FROM v_project ORDER BY municipality, code"),
    cycles: bi
      .all<{ v: string }>("SELECT DISTINCT project_cycle AS v FROM alert WHERE project_cycle IS NOT NULL UNION SELECT DISTINCT CAST(cycle AS TEXT) FROM cycle_schedule WHERE cycle IS NOT NULL")
      .map((r) => r.v)
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)),
    statusGroups: { groups: GROUPS, pending: PENDING, inAnalysis: IN_ANALYSIS, finished: FINISHED },
    lastLoad: bi.get("SELECT max(alerts_loaded_at) AS alerts, max(analyses_until) AS edits FROM monitored_db WHERE active = 1"),
  };
}
