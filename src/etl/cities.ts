// Routines per city (one read-only connection per active database):
//   edits     edit log → edit_day                                  (watermark monitored_db.edits_until)
//   analyses  edit log, inspection tables → alert_analyzed_day      (watermark monitored_db.analyses_until)
//                                         + alert_touch_day (per alert: the alert × edit-log crossing)
//
// Window: from (watermark − 2 days) to today in the configured zone; the first time, from
// EXTRACTION_START. The window's days are deleted and rewritten in the same transaction, so a
// re-run is idempotent and today fills in over the day's runs. The 2-day overlap absorbs edits
// logged late (mobile sync after the device comes back online).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BiDb } from "../db/bi.js";
import { addDays, dayIn } from "../lib/dates.js";
import { errorText } from "../lib/redact.js";
import { type MunicipalConnector, type MunicipalSource, findSource, type SourceEntry } from "../sources/municipal.js";
import { sqlDir } from "../paths.js";
import type { DbResult } from "./alerts.js";

/** First day extracted on the initial load. */
export const EXTRACTION_START = "2026-01-01";
export const OVERLAP_DAYS = 2;

const readSql = (name: string) => readFileSync(resolve(sqlDir, name), "utf-8");

interface Extract {
  sql: string;
  table: string;
  columns: string[];
}

export interface CityRoutine {
  name: "edits" | "analyses";
  extracts: Extract[];
  watermark: "edits_until" | "analyses_until";
  /** table the city must have (otherwise: error "missing table"). */
  requires: string;
}

export const CITY_ROUTINES: Record<CityRoutine["name"], CityRoutine> = {
  edits: {
    name: "edits",
    extracts: [{ sql: readSql("edits.sql"), table: "edit_day", columns: ["day", "profile", "table_name", "action", "channel", "username", "module_table", "n"] }],
    watermark: "edits_until",
    requires: "edit_log",
  },
  analyses: {
    name: "analyses",
    extracts: [
      { sql: readSql("analyses.sql"), table: "alert_analyzed_day", columns: ["day", "profile", "username", "channel", "edits", "alerts"] },
      { sql: readSql("touches.sql"), table: "alert_touch_day", columns: ["day", "alert_id", "edits", "mobile"] },
    ],
    watermark: "analyses_until",
    requires: "edit_log",
  },
};

export interface TargetDb {
  database: string;
  host: string | null;
  edits_until: string | null;
  analyses_until: string | null;
}

export function windowFor(watermark: string | null, until: string): { from: string; to: string } {
  return { from: watermark ? addDays(watermark, -OVERLAP_DAYS) : EXTRACTION_START, to: until };
}

function writeWindow(bi: BiDb, r: CityRoutine, database: string, from: string, to: string, data: Record<string, unknown>[][], sourceId: string, nowIso: string) {
  bi.tx(() => {
    r.extracts.forEach((x, i) => {
      bi.run(`DELETE FROM ${x.table} WHERE database = $db AND day BETWEEN $from AND $to`, { db: database, from, to });
      const cols = ["database", ...x.columns];
      const ins = bi.db.prepare(`INSERT INTO ${x.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
      for (const row of data[i] ?? []) {
        ins.run(database, ...x.columns.map((c) => (row[c] ?? null) as string | number | null));
      }
    });
    bi.run(`UPDATE monitored_db SET ${r.watermark} = $to, source_id = $sid, updated_at = $now WHERE database = $db`, {
      db: database,
      to,
      sid: sourceId,
      now: nowIso,
    });
  });
}

/** Runs the requested routines on one database, with ONE connection to the city. */
export async function extractCity(
  bi: BiDb,
  sources: SourceEntry[],
  connect: MunicipalConnector,
  target: TargetDb,
  routines: CityRoutine[],
  opts: { until?: string; dryRun?: boolean; nowIso: string },
): Promise<{ routine: CityRoutine["name"]; r: DbResult }[]> {
  const until = opts.until ?? dayIn(bi.tz, new Date(opts.nowIso));
  const fail = (message: string) => routines.map((rt) => ({ routine: rt.name, r: { database: target.database, status: "error" as const, rows: null, message } }));
  const entry = findSource(sources, target.database, target.host);
  if (!entry) return fail("database has no entry in the source catalogue");
  let city: MunicipalSource;
  try {
    city = await connect(entry);
  } catch (e) {
    return fail(errorText(e));
  }
  const out: { routine: CityRoutine["name"]; r: DbResult }[] = [];
  try {
    for (const rt of routines) {
      const { from, to } = windowFor(target[rt.watermark], until);
      try {
        if (!(await city.tableExists(rt.requires))) throw new Error(`city database has no ${rt.requires} table`);
        const data: Record<string, unknown>[][] = [];
        for (const x of rt.extracts) data.push(await city.query(x.sql, { from, to }));
        if (!opts.dryRun) writeWindow(bi, rt, target.database, from, to, data, entry.id, opts.nowIso);
        out.push({
          routine: rt.name,
          r: { database: target.database, status: "ok", rows: data[0]?.length ?? 0, message: `${opts.dryRun ? "dry-run " : ""}${from}..${to}` },
        });
      } catch (e) {
        out.push({ routine: rt.name, r: { database: target.database, status: "error", rows: null, message: errorText(e) } });
      }
    }
  } finally {
    await city.close();
  }
  return out;
}
