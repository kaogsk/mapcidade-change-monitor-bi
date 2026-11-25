/**
 * ETL (`npm run etl`).
 *
 * Routines (default: all, in this order):
 *   alerts    consolidated support table → alert (+ status history)
 *   edits     each active city's edit log → edit_day
 *   analyses  each active city's edit log (inspection tables) → alert_analyzed_day + alert_touch_day
 * then, if alerts ran, the daily snapshot (after the city routines, so its "analyzed" column sees
 * the edits extracted in this same run), and the usage-event retention purge.
 *
 * Schedule: right after each run of the external consolidation (see etl/schedule.ts).
 * Flags: --routine alerts|edits|analyses (repeatable), --db x (repeatable), --until YYYY-MM-DD,
 *        --dry-run (city routines: count, don't write).
 * Sources are only read (read-only connections).
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { type BiDb, openBi } from "../db/bi.js";
import { errorText } from "../lib/redact.js";
import { connectMunicipal, loadSources, type MunicipalConnector, type SourceEntry } from "../sources/municipal.js";
import { openSqliteSupport, type SupportSource } from "../sources/support.js";
import { assessSupportLoad, copyAlerts, type DbResult, syncDatabases, writeDailySnapshot } from "./alerts.js";
import { CITY_ROUTINES, extractCity, type TargetDb } from "./cities.js";

export const ROUTINES = ["alerts", "edits", "analyses"] as const;
export type Routine = (typeof ROUTINES)[number];

/** Days bi_event keeps (usage per screen). */
export const EVENT_RETENTION_DAYS = 400;

export interface EtlDeps {
  openSupport: () => SupportSource;
  sources: SourceEntry[];
  connect: MunicipalConnector;
}

export interface EtlOptions {
  routines?: Routine[];
  databases?: string[];
  until?: string;
  dryRun?: boolean;
  /** Clock (tests and the demo timeline inject it). */
  now?: Date;
  log?: (msg: string) => void;
}

export interface EtlOutcome {
  id: number;
  status: "ok" | "with_failures" | "error";
  results: { routine: Routine; r: DbResult }[];
}

export async function executeEtl(bi: BiDb, deps: EtlDeps, o: EtlOptions = {}): Promise<EtlOutcome> {
  const routines = o.routines?.length ? o.routines : [...ROUTINES];
  const log = o.log ?? ((m: string) => console.log(`[etl] ${m}`));
  const nowIso = (o.now ?? new Date()).toISOString();
  const id = bi.run("INSERT INTO etl_run (routine, started_at) VALUES ($r, $now)", {
    r: routines.length === ROUTINES.length ? "full" : routines.join("+"),
    now: nowIso,
  }).lastId;
  const results: { routine: Routine; r: DbResult }[] = [];
  let fatal: string | null = null;
  let snapshot: { day: string; rows: number } | null = null;
  let snapshotError: string | null = null;

  try {
    const sup = deps.openSupport();
    let active: string[];
    try {
      active = await syncDatabases(bi, sup, nowIso);
      if (o.databases?.length) active = active.filter((a) => o.databases!.includes(a));
      log(`${active.length} active databases`);
      if (routines.includes("alerts")) {
        const { ready, refused } = await assessSupportLoad(sup, active);
        log(`alerts: ${ready.size} databases with a complete consolidation, ${refused.length} kept`);
        const copied = await copyAlerts(bi, sup, ready, nowIso);
        for (const r of [...copied, ...refused]) results.push({ routine: "alerts", r });
      }
    } finally {
      await sup.close();
    }

    const cityRoutines = routines.filter((r): r is "edits" | "analyses" => r !== "alerts").map((r) => CITY_ROUTINES[r]);
    if (cityRoutines.length) {
      const targets = bi.all<TargetDb>(
        `SELECT database, host, edits_until, analyses_until FROM monitored_db
          WHERE active = 1 AND database IN (SELECT value FROM json_each($dbs)) ORDER BY database`,
        { dbs: active },
      );
      for (const t of targets) {
        for (const x of await extractCity(bi, deps.sources, deps.connect, t, cityRoutines, { until: o.until, dryRun: o.dryRun, nowIso })) {
          log(`${x.routine} ${t.database}: ${x.r.status} ${x.r.rows ?? ""} ${x.r.message ?? ""}`);
          results.push(x);
        }
      }
    }

    // A failed snapshot doesn't take the rest of the ETL down: it goes to the log and the summary.
    if (routines.includes("alerts")) {
      try {
        snapshot = writeDailySnapshot(bi, nowIso);
        log(`snapshot of ${snapshot.day}: ${snapshot.rows} rows`);
      } catch (e) {
        snapshotError = errorText(e);
        log(`snapshot failed: ${snapshotError}`);
      }
    }
  } catch (e) {
    fatal = errorText(e);
  }

  try {
    const cutoff = new Date(Date.parse(nowIso) - EVENT_RETENTION_DAYS * 86_400_000).toISOString();
    const del = bi.run("DELETE FROM bi_event WHERE occurred_at < $cutoff", { cutoff });
    if (del.changes) log(`bi_event: ${del.changes} events older than ${EVENT_RETENTION_DAYS} days purged`);
  } catch (e) {
    log(`bi_event purge failed: ${errorText(e)}`);
  }

  bi.tx(() => {
    for (const { routine, r } of results) {
      bi.run(
        `INSERT INTO etl_db (run_id, database, routine, status, rows, message) VALUES ($id, $db, $rt, $st, $rows, $msg)
         ON CONFLICT (run_id, database, routine) DO UPDATE SET status = excluded.status, rows = excluded.rows, message = excluded.message`,
        { id, db: r.database, rt: routine, st: r.status, rows: r.rows, msg: r.message },
      );
    }
  });
  const failures = results.filter((x) => x.r.status === "error").length;
  const kept = results.filter((x) => x.r.status === "kept").length;
  const status: EtlOutcome["status"] = fatal ? "error" : failures || kept || snapshotError ? "with_failures" : "ok";
  const summary = {
    routines,
    ok: results.filter((x) => x.r.status === "ok").length,
    kept,
    failures,
    rows: Object.fromEntries(ROUTINES.map((rt) => [rt, results.filter((x) => x.routine === rt).reduce((s, x) => s + (x.r.rows ?? 0), 0)])),
    ...(snapshot ? { snapshot } : {}),
    ...(snapshotError ? { snapshotError } : {}),
  };
  bi.run("UPDATE etl_run SET finished_at = $now, status = $st, summary = $sum, error = $err WHERE id = $id", {
    id,
    // with an injected clock the run "takes no time"; with the real one, record when it ended
    now: o.now ? nowIso : new Date().toISOString(),
    st: status,
    sum: JSON.stringify(summary),
    err: fatal,
  });
  log(`run ${id}: ${status} ${JSON.stringify(summary)}${fatal ? ` — ${fatal}` : ""}`);
  return { id, status, results };
}

/** Real dependencies from the configuration. */
export function defaultDeps(cfg = loadConfig()): EtlDeps {
  return {
    openSupport: () => openSqliteSupport(cfg.paths.supportDb, cfg.tz),
    sources: loadSources(cfg.paths.sources),
    connect: connectMunicipal,
  };
}

const isMain = process.argv[1] && /runner\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const { values } = parseArgs({
    options: {
      routine: { type: "string", multiple: true },
      db: { type: "string", multiple: true },
      until: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const routines = (values.routine ?? []).map((r) => {
    if (!(ROUTINES as readonly string[]).includes(r)) throw new Error(`unknown routine: ${r}`);
    return r as Routine;
  });
  const cfg = loadConfig();
  const bi = openBi(cfg.paths.biDb, cfg.tz);
  executeEtl(bi, defaultDeps(cfg), { routines, databases: values.db, until: values.until, dryRun: values["dry-run"] })
    .then((r) => {
      if (r.status === "error") process.exitCode = 1;
    })
    .catch((e) => {
      console.error("[etl] failed:", errorText(e));
      process.exitCode = 1;
    })
    .finally(() => bi.close());
}
