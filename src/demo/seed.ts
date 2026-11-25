import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { hashPassword } from "../auth/directory.js";
import { loadConfig, type Config } from "../config.js";
import { openBi } from "../db/bi.js";
import { defaultDeps, executeEtl } from "../etl/runner.js";
import { addDays, isIsoDay, zonedTime } from "../lib/dates.js";
import { recalculate } from "../register/recalc.js";
import { CITIES, HOLIDAYS, PROJECTS, cycles, visits } from "./catalog.js";

export async function seed(config: Config, today: string) {
  if (!isIsoDay(today)) throw new Error("Expected a demo date in YYYY-MM-DD format");
  const folder = dirname(config.paths.sources);
  for (const file of Object.values(config.paths)) mkdirSync(dirname(file), { recursive: true });
  const support = new DatabaseSync(config.paths.supportDb);
  const sources = [];
  try {
    support.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS monitored_database (database TEXT PRIMARY KEY, host TEXT, port INTEGER);
      CREATE TABLE IF NOT EXISTS consolidation_log (id INTEGER PRIMARY KEY, source_database TEXT, executed_at TEXT, status TEXT, rows_inserted INTEGER, message TEXT);
      CREATE TABLE IF NOT EXISTS change_alert_consolidated (
        id INTEGER PRIMARY KEY, database TEXT, alert_id INTEGER, city TEXT, project_code TEXT,
        project_cycle TEXT, project_period TEXT, alert_class TEXT, detection_cycle TEXT,
        detection_date TEXT, area_m2 REAL, responsibility TEXT, responsibility_profile TEXT,
        status TEXT, final_status TEXT, acted_on TEXT, analysis_id INTEGER
      );
      DELETE FROM monitored_database;
      DELETE FROM consolidation_log;
      DELETE FROM change_alert_consolidated;
    `);
    const alert = support.prepare("INSERT INTO change_alert_consolidated VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const delivered = cycles(today).filter((cycle) => cycle.productDelivered);
    for (const city of CITIES) {
      const file = join(folder, city.database + ".db");
      sources.push({ id: city.database, database: city.database, host: city.host, dsn: "sqlite:" + basename(file) });
      const municipal = new DatabaseSync(file);
      try {
        municipal.exec(`
          BEGIN;
          CREATE TABLE IF NOT EXISTS user_account (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
          CREATE TABLE IF NOT EXISTS user_profile (id INTEGER PRIMARY KEY, name TEXT);
          INSERT OR IGNORE INTO user_account VALUES (1, 'Demo reviewer', 'reviewer@example.invalid');
          INSERT OR IGNORE INTO user_profile VALUES (1, 'Monitoring reviewer');
        `);
        let writeEdit: ((...args: SQLInputValue[]) => unknown) | undefined;
        if (!city.noEditLog) {
          municipal.exec(`
            CREATE TABLE IF NOT EXISTS edit_log (
              logged_at TEXT, user_id INTEGER, profile_id INTEGER, table_name TEXT,
              action TEXT, endpoint TEXT, record_id INTEGER
            );
            DELETE FROM edit_log;
          `);
          const insert = municipal.prepare("INSERT INTO edit_log VALUES (?, 1, 1, 'chg_inspection', 'update', ?, ?)");
          writeEdit = (...args) => insert.run(...args);
        }
        let count = 0;
        for (const project of PROJECTS.filter((item) => item.database === city.database)) {
          for (const cycle of delivered.filter((item) => item.code === project.code)) {
            const detected = cycle.productDelivered!;
            const date = city.dateFormat === "dmy" ? detected.split("-").reverse().join("/") : detected;
            for (let n = 0; n < project.alertsPerCycle; n++) {
              const id = ++count;
              const reviewed = addDays(detected, 1 + Math.floor(n / city.capacity));
              const completed = n % 4 !== 0 && reviewed <= today;
              alert.run(city.database, id, city.city, project.code, String(cycle.cycle), project.frequency,
                n % 2 ? "Building" : "Earthworks", String(cycle.cycle), date, 20 + n * 3,
                "Urban Planning", "Monitoring", completed ? "Analyzed" : "Pending",
                completed ? "Confirmed" : null, completed ? reviewed : null, completed ? id : null);
              if (completed) writeEdit?.(reviewed + "T10:00:00", n % 4 === 1 ? "/rest/mobile/review" : "/desktop", id);
            }
          }
        }
        support.prepare("INSERT INTO monitored_database VALUES (?, ?, NULL)").run(city.database, city.host);
        const failed = city.flakyConsolidation && Number(today.slice(-2)) % 2 === 0;
        support.prepare("INSERT INTO consolidation_log VALUES (NULL, ?, ?, ?, ?, NULL)").run(
          city.database, today + " 10:00:00", failed ? "FAILED" : "SUCCESS", count,
        );
        municipal.exec("COMMIT");
      } finally {
        municipal.close();
      }
    }
    support.exec("COMMIT");
  } finally {
    support.close();
  }
  writeFileSync(config.paths.sources, JSON.stringify({ sources }, null, 2));
  writeFileSync(config.paths.directory, JSON.stringify({ users: [
    { username: "demo", name: "Demo Analyst", ...hashPassword("demo-password") },
  ] }));
  const bi = openBi(config.paths.biDb, config.tz);
  try {
    bi.tx(() => {
      for (const p of PROJECTS) {
        bi.run(`INSERT OR IGNORE INTO contract (code, municipality, contract_no, frequency, total_cycles, area_km2, status, starts_on)
          VALUES ($code, $municipality, $contract, $frequency, $cycles, $area, $status, $start)`,
        { code: p.code, municipality: p.municipality, contract: p.contractNo, frequency: p.frequency,
          cycles: p.totalCycles, area: p.areaKm2, status: p.status, start: p.startsOn });
      }
      for (const [day, reason] of HOLIDAYS) {
        bi.run("INSERT OR IGNORE INTO holiday (day, reason) VALUES (?, ?)", [day, reason]);
      }
      for (const c of cycles(today)) {
        const existing = bi.get<{ id: number; version: number }>(
          "SELECT id, version FROM cycle_schedule WHERE code = ? AND cycle = ? ORDER BY id LIMIT 1", [c.code, c.cycle],
        );
        if (existing) {
          // Seeded rows can advance with the source while leaving register edits intact.
          if (existing.version === 1) {
            bi.run(`UPDATE cycle_schedule SET product_delivered = ?, rollout_opened_on = ?, cycle_delivered = ?
                    WHERE id = ? AND updated_at IS NULL`, [c.productDelivered, c.rolloutOpenedOn, c.cycleDelivered, existing.id]);
          }
          continue;
        }
        bi.run(`INSERT INTO cycle_schedule (
          code, cycle, capture_start, capture_end, production_days, product_delivered,
          rollout_opened_on, rollout_days, cycle_term_days, cycle_deadline, cycle_delivered
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          c.code, c.cycle, c.captureStart, c.captureEnd, c.productionDays, c.productDelivered,
          c.rolloutOpenedOn, c.rolloutDays, c.cycleTermDays, c.cycleDeadline, c.cycleDelivered,
        ]);
      }
      for (const v of visits("2026-06-01")) {
        if (bi.get("SELECT id FROM site_visit WHERE code = ? AND starts_on = ?", [v.code, v.startsOn])) continue;
        bi.run(`INSERT INTO site_visit (code, cycle, responsible, starts_on, ends_on, reason, departments, actions)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [v.code, v.cycle, v.responsible, v.startsOn, v.endsOn, v.reason, v.departments, v.actions]);
      }
      bi.refreshCalendar();
      recalculate(bi);
    });
    return await executeEtl(bi, defaultDeps(config), {
      until: today,
      now: zonedTime(today, "12:00:00", config.tz),
    });
  } finally {
    bi.close();
  }
}

if (process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1])) {
  const result = await seed(loadConfig(), process.argv[2] ?? "2026-10-31");
  if (result.status === "error") process.exitCode = 1;
}
