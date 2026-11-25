// "Monitor" screen (the old dashboard's main page) and the "Response" screen (alert × edit log).
import type { BiDb } from "../db/bi.js";
import { ASSISTED_OPERATION } from "../register/definitions.js";
import { type AlertClicks, type Context, NO_CLICKS, params, PROJ, W_REPORT, W_SCHEDULE, W_VISIT, wAlert } from "./filters.js";

export function monitor(bi: BiDb, c: Context, k: AlertClicks = NO_CLICKS) {
  const p = params(c, k);
  const kpi = bi.get<{ alerts: number; classes: number; responsibilities: number; analyzed: number; area_m2: number | null }>(
    `WITH ${PROJ}
     SELECT count(*) AS alerts, count(DISTINCT a.alert_class) AS classes, count(DISTINCT a.responsibility) AS responsibilities,
            sum(EXISTS (SELECT 1 FROM alert_touch_day t WHERE t.database = a.database AND t.alert_id = a.alert_id)) AS analyzed,
            sum(a.area_m2) AS area_m2
       FROM alert a WHERE ${wAlert()}`,
    p,
  );
  // Cycles planned × done (gauge): planned = count(cycle_deadline), done = count(cycle_delivered);
  // km² monitored = sum(km2_done).
  const cycles = bi.get<{ planned: number; done: number; km2: number }>(
    `WITH ${PROJ}
     SELECT count(g.cycle_deadline) AS planned, count(g.cycle_delivered) AS done, coalesce(sum(g.km2_done), 0) AS km2
       FROM cycle_schedule g WHERE ${W_SCHEDULE}`,
    p,
  );
  const reports = bi.get<{ planned: number; done: number }>(
    `WITH ${PROJ} SELECT count(r.due_on) AS planned, count(r.delivered_on) AS done FROM monthly_report r WHERE ${W_REPORT}`,
    p,
  );
  const visits = bi.get<{ visits: number; assisted: number }>(
    `WITH ${PROJ}
     SELECT count(v.starts_on) AS visits, sum(v.reason = $opa) AS assisted FROM site_visit v WHERE ${W_VISIT}`,
    { ...p, opa: ASSISTED_OPERATION },
  );
  const contracts = bi.all(
    `WITH ${PROJ}
     SELECT k.code, k.municipality, k.contract_no, k.starts_on, k.ends_on, k.total_cycles, k.frequency, k.status,
            k.area_km2, k.total_area_km2
       FROM contract k WHERE k.code IN (SELECT code FROM proj)
      ORDER BY k.ends_on DESC NULLS LAST, k.code`,
    p,
  );
  const by = (expr: string, dim: "class" | "responsibility") =>
    bi.all<{ label: string; n: number }>(
      `WITH ${PROJ} SELECT coalesce(${expr}, '(blank)') AS label, count(*) AS n FROM alert a WHERE ${wAlert(dim)} GROUP BY 1 ORDER BY 2 DESC, 1`,
      p,
    );
  const byStatus = bi.all<{ status: string; status_group: string; n: number }>(
    `WITH ${PROJ}
     SELECT coalesce(a.status, '(blank)') AS status, coalesce(status_group(a.status), '(blank)') AS status_group, count(*) AS n
       FROM alert a WHERE ${wAlert("status")} GROUP BY 1, 2 ORDER BY 3 DESC, 1`,
    p,
  );
  const alerts = kpi?.alerts ?? 0;
  return {
    kpis: {
      alerts,
      analyzed: kpi?.analyzed ?? 0,
      analyzedShare: alerts ? (kpi?.analyzed ?? 0) / alerts : null,
      km2: cycles?.km2 ?? 0,
      classes: kpi?.classes ?? 0,
      responsibilities: kpi?.responsibilities ?? 0,
      visits: visits?.visits ?? 0,
      assistedOperations: visits?.assisted ?? 0,
    },
    cycles: { planned: cycles?.planned ?? 0, done: cycles?.done ?? 0 },
    reports: { planned: reports?.planned ?? 0, done: reports?.done ?? 0 },
    contracts,
    byResponsibility: by("a.responsibility", "responsibility"),
    byClass: by("a.alert_class", "class"),
    byStatus,
  };
}

/** Matrices of the detail view: responsibility × status and class × cycle. */
export function matrices(bi: BiDb, c: Context, k: AlertClicks = NO_CLICKS) {
  const p = params(c, k);
  return {
    responsibilityStatus: bi.all(
      `WITH ${PROJ}
       SELECT coalesce(a.responsibility, '(blank)') AS row, coalesce(a.status, '(blank)') AS col, count(*) AS n
         FROM alert a WHERE ${wAlert("responsibility")} GROUP BY 1, 2`,
      p,
    ),
    classCycle: bi.all(
      `WITH ${PROJ}
       SELECT coalesce(a.alert_class, '(blank)') AS row, coalesce(a.project_cycle, '(blank)') AS col, count(*) AS n
         FROM alert a WHERE ${wAlert("class")} GROUP BY 1, 2`,
      p,
    ),
  };
}

/** Alerts older than this many business days without a single inspection edit = stale backlog. */
export const STALE_BUSINESS_DAYS = 20;

/**
 * The crossing: alert (from the consolidated table) × the city's edit log (inspection edits).
 * "Analyzed" = at least one inspection edit by city staff; "answered" = status in the Finished
 * group. The two disagree in useful ways: finished without any analysis (closed by integration
 * or in bulk), and analyzed but still pending (status not updated, or the consolidation lagging).
 */
export function response(bi: BiDb, c: Context, today: string) {
  const p = { ...params(c), today, stale: STALE_BUSINESS_DAYS };
  const byProject = bi.all<{
    project_code: string; city: string; alerts: number; analyzed: number; answered: number;
    answered_without_analysis: number; analyzed_still_pending: number; stale: number; median_days: number | null; p90_days: number | null;
  }>(
    `WITH ${PROJ}
     SELECT r.project_code, max(r.city) AS city, count(*) AS alerts, sum(r.analyzed) AS analyzed, sum(r.answered) AS answered,
            sum(r.answered AND NOT r.analyzed) AS answered_without_analysis,
            sum(r.analyzed AND r.status_group = 'Pending') AS analyzed_still_pending,
            sum(NOT r.analyzed AND r.status_group <> 'Finished' AND r.detected_on IS NOT NULL
                AND business_days(r.detected_on, $today) - 1 > $stale) AS stale,
            percentile_cont(r.business_days_to_first, 0.5) AS median_days,
            percentile_cont(r.business_days_to_first, 0.9) AS p90_days
       FROM v_alert_response r JOIN alert a ON a.database = r.database AND a.alert_id = r.alert_id
      WHERE ${wAlert()}
      GROUP BY r.project_code ORDER BY alerts DESC`,
    p,
  );
  const distribution = bi.all<{ bucket: string; n: number }>(
    `WITH ${PROJ}
     SELECT CASE WHEN r.business_days_to_first IS NULL THEN 'not analyzed'
                 WHEN r.business_days_to_first <= 5 THEN '0–5'
                 WHEN r.business_days_to_first <= 10 THEN '6–10'
                 WHEN r.business_days_to_first <= 20 THEN '11–20'
                 WHEN r.business_days_to_first <= 40 THEN '21–40'
                 ELSE '> 40' END AS bucket, count(*) AS n
       FROM v_alert_response r JOIN alert a ON a.database = r.database AND a.alert_id = r.alert_id
      WHERE ${wAlert()}
      GROUP BY 1`,
    p,
  );
  const order = ["0–5", "6–10", "11–20", "21–40", "> 40", "not analyzed"];
  distribution.sort((x, y) => order.indexOf(x.bucket) - order.indexOf(y.bucket));
  const oldestStale = bi.all(
    `WITH ${PROJ}
     SELECT r.database, r.alert_id, r.city, r.project_code, r.alert_class, r.status, r.detected_on,
            business_days(r.detected_on, $today) - 1 AS business_days_open
       FROM v_alert_response r JOIN alert a ON a.database = r.database AND a.alert_id = r.alert_id
      WHERE ${wAlert()} AND NOT r.analyzed AND r.status_group <> 'Finished' AND r.detected_on IS NOT NULL
      ORDER BY r.detected_on, r.alert_id LIMIT 50`,
    p,
  );
  const totals = byProject.reduce(
    (t, x) => ({
      alerts: t.alerts + x.alerts,
      analyzed: t.analyzed + x.analyzed,
      answered: t.answered + x.answered,
      answeredWithoutAnalysis: t.answeredWithoutAnalysis + x.answered_without_analysis,
      analyzedStillPending: t.analyzedStillPending + x.analyzed_still_pending,
      stale: t.stale + x.stale,
    }),
    { alerts: 0, analyzed: 0, answered: 0, answeredWithoutAnalysis: 0, analyzedStillPending: 0, stale: 0 },
  );
  return { staleAfter: STALE_BUSINESS_DAYS, totals, byProject, distribution, oldestStale };
}
