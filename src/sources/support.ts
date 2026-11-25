// The "support" database: a consolidated table of change alerts from every monitored city, filled
// by an external ETL (TRUNCATE + INSERT, 4x a day), plus that ETL's own run log and the list of
// monitored databases. The BI only reads it.
//
// Production read it through Postgres with a read-only role; here the same interface is backed by
// a SQLite file opened read-only. Everything above this file is identical for both.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { zonedTime } from "../lib/dates.js";

export interface SupportAlertRow {
  database: string;
  alert_id: number;
  city: string | null;
  project_code: string | null;
  project_cycle: string | null;
  frequency: string | null;
  alert_class: string | null;
  detection_cycle: string | null;
  detection_date: string | null; // text at the source, in two formats depending on the city
  area_m2: number | null;
  responsibility: string | null;
  responsibility_profile: string | null;
  status: string | null;
  final_status: string | null;
  acted_on: string | null;
  analysis_id: number | null; // one consolidated row per analysis: the same alert can come twice
  row_id: number;
}

export interface LoadLog {
  database: string;
  /** UTC ISO instant of the consolidation run. */
  executedAt: string;
  status: string;
  rowsInserted: number | null;
  message: string | null;
}

export interface MonitoredDatabase {
  database: string;
  host: string | null;
  port: number | null;
}

export interface SupportSource {
  activeDatabases(): Promise<MonitoredDatabase[]>;
  /** The latest consolidation run of each database. */
  latestLoads(): Promise<LoadLog[]>;
  alertCounts(): Promise<Map<string, number>>;
  /** Streams one database's rows in batches (a cursor, not one big array). Returns rows read. */
  streamAlerts(database: string, batchSize: number, onBatch: (rows: SupportAlertRow[]) => void | Promise<void>): Promise<number>;
  close(): Promise<void>;
}

const SELECT_ALERTS = `
  SELECT database, alert_id, city, project_code, project_cycle, project_period AS frequency,
         alert_class, detection_cycle, detection_date, area_m2, responsibility, responsibility_profile,
         status, final_status, substr(acted_on, 1, 10) AS acted_on, analysis_id, id AS row_id
    FROM change_alert_consolidated
   WHERE database = ?`;

/**
 * The consolidation log stores a timestamp WITHOUT time zone, written in the server's local time
 * (the external cron runs on local wall-clock). It is converted here, once, with the configured
 * zone — comparing it raw against UTC instants put every run 3 hours off.
 */
export function openSqliteSupport(path: string, tz: string): SupportSource {
  if (!existsSync(path)) throw new Error(`support database not found: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    async activeDatabases() {
      return db.prepare("SELECT database, host, port FROM monitored_database ORDER BY database").all() as unknown as MonitoredDatabase[];
    },
    async latestLoads() {
      const rows = db
        .prepare(
          `SELECT source_database AS database, executed_at, status, rows_inserted, message
             FROM consolidation_log l
            WHERE id = (SELECT id FROM consolidation_log x WHERE x.source_database = l.source_database
                         ORDER BY executed_at DESC, id DESC LIMIT 1)
            ORDER BY source_database`,
        )
        .all() as { database: string; executed_at: string; status: string; rows_inserted: number | null; message: string | null }[];
      return rows.map((r) => ({
        database: r.database,
        executedAt: zonedTime(r.executed_at.slice(0, 10), r.executed_at.slice(11, 19), tz).toISOString(),
        status: r.status,
        rowsInserted: r.rows_inserted,
        message: r.message,
      }));
    },
    async alertCounts() {
      const rows = db.prepare("SELECT database, count(*) AS n FROM change_alert_consolidated GROUP BY database").all() as {
        database: string;
        n: number;
      }[];
      return new Map(rows.map((r) => [r.database, Number(r.n)]));
    },
    async streamAlerts(database, batchSize, onBatch) {
      let batch: SupportAlertRow[] = [];
      let n = 0;
      for (const row of db.prepare(SELECT_ALERTS).iterate(database)) {
        batch.push(row as unknown as SupportAlertRow);
        n++;
        if (batch.length >= batchSize) {
          await onBatch(batch);
          batch = [];
        }
      }
      if (batch.length) await onBatch(batch);
      return n;
    },
    async close() {
      db.close();
    },
  };
}
