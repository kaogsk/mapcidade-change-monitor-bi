// Routine "alerts": consolidated support table → alert + alert_status_history (+ daily snapshot).
//
// The external consolidation does TRUNCATE + INSERT 4x a day. To never copy a half-done load, a
// database is copied only when its latest consolidation log says SUCCESS and the number of rows
// in the consolidated table matches `rows_inserted`. Otherwise the BI keeps its last good copy
// of that database (status 'kept') and says why on the Loads screen.
//
// History: on each copy, an alert whose status changed closes its open history row and opens a
// new one with `since` = the consolidation run time. On a database's first copy, `since` is NULL
// (the status predates the BI; inventing a date would fake a duration).
//
// Repeated alert: the consolidated table has one row per ANALYSIS, so an alert analyzed twice
// comes twice. The BI keeps one row per alert: the latest analysis (highest analysis_id, then
// highest row id).
import type { BiDb } from "../db/bi.js";
import { dayIn } from "../lib/dates.js";
import { errorText } from "../lib/redact.js";
import type { SupportAlertRow, SupportSource } from "../sources/support.js";

export interface DbResult {
  database: string;
  status: "ok" | "kept" | "error";
  rows: number | null;
  message: string | null;
}

export const NO_STATUS = "(no status)";
export const REMOVED = "(removed)";

/** Mirrors the support's list of monitored databases into monitored_db; returns the active ones. */
export async function syncDatabases(bi: BiDb, sup: SupportSource, nowIso: string): Promise<string[]> {
  const active = await sup.activeDatabases();
  const names = active.map((a) => a.database);
  bi.tx(() => {
    bi.run(
      `UPDATE monitored_db SET active = 0, updated_at = $now
        WHERE active = 1 AND database NOT IN (SELECT value FROM json_each($names))`,
      { now: nowIso, names },
    );
    for (const a of active) {
      bi.run(
        `INSERT INTO monitored_db (database, host, port, active, updated_at) VALUES ($db, $host, $port, 1, $now)
         ON CONFLICT (database) DO UPDATE SET host = excluded.host, port = excluded.port, active = 1, updated_at = excluded.updated_at`,
        { db: a.database, host: a.host, port: a.port, now: nowIso },
      );
    }
  });
  return names;
}

/** Databases whose current consolidation is complete (SUCCESS and matching row count). */
export async function assessSupportLoad(
  sup: SupportSource,
  databases: string[],
): Promise<{ ready: Map<string, string>; refused: DbResult[] }> {
  const logs = new Map((await sup.latestLoads()).map((l) => [l.database, l]));
  const counts = await sup.alertCounts();
  const ready = new Map<string, string>();
  const refused: DbResult[] = [];
  for (const db of databases) {
    const log = logs.get(db);
    const n = counts.get(db) ?? 0;
    const keep = (message: string) => refused.push({ database: db, status: "kept", rows: null, message });
    if (!log) keep("no consolidation log for this database");
    else if (log.status !== "SUCCESS") keep(`consolidation ${log.status}${log.message ? ` — ${log.message}` : ""}`);
    else if (log.rowsInserted !== null && Number(log.rowsInserted) !== n) keep(`consolidation incomplete (${n} of ${log.rowsInserted} rows)`);
    else ready.set(db, log.executedAt);
  }
  return { ready, refused };
}

const STAGE_COLS = [
  "database", "alert_id", "city", "project_code", "project_cycle", "frequency", "alert_class", "detection_cycle",
  "detection_date", "area_m2", "responsibility", "responsibility_profile", "status", "final_status", "acted_on",
  "analysis_id", "row_id",
] as const satisfies readonly (keyof SupportAlertRow)[];

/** Copies the ready databases and updates the status history. One transaction per database. */
export async function copyAlerts(bi: BiDb, sup: SupportSource, ready: Map<string, string>, nowIso: string): Promise<DbResult[]> {
  const out: DbResult[] = [];
  for (const [db, sourceAt] of ready) {
    try {
      const r = await bi.txAsync(async () => {
        bi.exec(`CREATE TEMP TABLE IF NOT EXISTS stage_alert (${STAGE_COLS.join(", ")})`);
        bi.exec("DELETE FROM stage_alert");
        const ins = bi.db.prepare(`INSERT INTO stage_alert (${STAGE_COLS.join(", ")}) VALUES (${STAGE_COLS.map(() => "?").join(", ")})`);
        let rows = await sup.streamAlerts(db, 2000, (batch) => {
          for (const row of batch) ins.run(...STAGE_COLS.map((c) => row[c] ?? null));
        });

        // One row per alert: the latest analysis (see the header).
        const repeated = bi.run(
          `DELETE FROM stage_alert WHERE rowid IN (
             SELECT rid FROM (SELECT rowid AS rid, row_number() OVER (PARTITION BY alert_id
                                       ORDER BY analysis_id DESC NULLS LAST, row_id DESC NULLS LAST) AS rn
                                FROM stage_alert) WHERE rn > 1)`,
        ).changes;
        rows -= repeated;

        const first = bi.get<{ x: number }>("SELECT alerts_loaded_at IS NULL AS x FROM monitored_db WHERE database = $db", { db });
        const since = first && first.x === 0 ? sourceAt : null;
        const p = { db, at: sourceAt, none: NO_STATUS, removed: REMOVED };

        // History: close what changed or vanished…
        bi.run(
          `UPDATE alert_status_history SET until = $at
            WHERE database = $db AND until IS NULL
              AND NOT EXISTS (SELECT 1 FROM stage_alert s
                               WHERE s.alert_id = alert_status_history.alert_id
                                 AND coalesce(s.status, $none) = alert_status_history.status)
              -- '(removed)' only closes when the alert comes back
              AND (status <> $removed OR EXISTS (SELECT 1 FROM stage_alert s WHERE s.alert_id = alert_status_history.alert_id))`,
          p,
        );
        // …mark the ones removed at the source…
        bi.run(
          `INSERT INTO alert_status_history (database, alert_id, status, since)
           SELECT a.database, a.alert_id, $removed, $at FROM alert a
            WHERE a.database = $db AND NOT EXISTS (SELECT 1 FROM stage_alert s WHERE s.alert_id = a.alert_id)
              AND NOT EXISTS (SELECT 1 FROM alert_status_history h
                               WHERE h.database = a.database AND h.alert_id = a.alert_id AND h.until IS NULL)
            ORDER BY a.alert_id`,
          p,
        );
        // …and open the current status of whoever has no open row.
        bi.run(
          `INSERT INTO alert_status_history (database, alert_id, status, since)
           SELECT $db, s.alert_id, coalesce(s.status, $none), $since FROM stage_alert s
            WHERE NOT EXISTS (SELECT 1 FROM alert_status_history h
                               WHERE h.database = $db AND h.alert_id = s.alert_id AND h.until IS NULL)
            ORDER BY s.alert_id`,
          { db, none: NO_STATUS, since },
        );

        bi.run("DELETE FROM alert WHERE database = $db", { db });
        bi.run(
          `INSERT INTO alert (database, alert_id, city, project_code, project_cycle, frequency, alert_class, detection_cycle,
                              detected_on, area_m2, responsibility, responsibility_profile, status, final_status, acted_on, loaded_at)
           SELECT database, alert_id, city, project_code, project_cycle, frequency, alert_class, detection_cycle,
                  try_date(detection_date), area_m2, responsibility, responsibility_profile, status, final_status,
                  try_date(acted_on), $now
             FROM stage_alert`,
          { now: nowIso },
        );
        bi.run(
          `UPDATE monitored_db SET alerts_loaded_at = $now, alerts_source_at = $at,
                  city = coalesce((SELECT max(city) FROM stage_alert), city), updated_at = $now
            WHERE database = $db`,
          { db, at: sourceAt, now: nowIso },
        );
        return { rows, repeated };
      });
      out.push({
        database: db,
        status: "ok",
        rows: r.rows,
        message: r.repeated ? `${r.repeated} repeated alert row(s) at the source (one per analysis): kept the latest analysis` : null,
      });
    } catch (e) {
      out.push({ database: db, status: "error", rows: null, message: errorText(e) });
    }
  }
  return out;
}

/**
 * Today's snapshot in alert_daily_snapshot (the series; `alert` only holds the current state).
 * Reads the whole `alert` table, so it also covers kept databases (their last good copy).
 * Running again on the same day replaces that day's snapshot.
 */
export function writeDailySnapshot(bi: BiDb, nowIso: string, day = dayIn(bi.tz, new Date(nowIso))): { day: string; rows: number } {
  return bi.tx(() => {
    bi.run("DELETE FROM alert_daily_snapshot WHERE day = $day", { day });
    const r = bi.run(
      `INSERT INTO alert_daily_snapshot (day, database, city, project_code, project_cycle, alert_class, responsibility,
                                         status, alerts, analyzed, area_m2, written_at)
       SELECT $day, a.database, max(a.city), a.project_code, a.project_cycle, a.alert_class, a.responsibility,
              coalesce(a.status, $none), count(*),
              sum(EXISTS (SELECT 1 FROM alert_touch_day t
                           WHERE t.database = a.database AND t.alert_id = a.alert_id AND t.day <= $day)),
              sum(a.area_m2), $now
         FROM alert a
        GROUP BY a.database, a.project_code, a.project_cycle, a.alert_class, a.responsibility, coalesce(a.status, $none)`,
      { day, none: NO_STATUS, now: nowIso },
    );
    return { day, rows: r.changes };
  });
}
