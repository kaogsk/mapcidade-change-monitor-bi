/**
 * ETL schedule (`npm run etl:schedule`). The external consolidation reloads the support table at
 * fixed local times; the BI runs 10 minutes after each (default 06:10, 12:40, 17:10, 20:10 in
 * APP_TZ). In production this was a systemd timer; this in-process scheduler keeps the demo
 * self-contained and makes the "next run" rule testable.
 *
 * A run that is still going when the next slot arrives is not started twice: the slot is
 * skipped and logged (runs are idempotent, the next one catches up).
 */
import { loadConfig } from "../config.js";
import { openBi } from "../db/bi.js";
import { addDays, dayIn, zonedTime } from "../lib/dates.js";
import { errorText } from "../lib/redact.js";
import { defaultDeps, executeEtl } from "./runner.js";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The first scheduled instant strictly after `now`. */
export function nextRun(now: Date, times: string[], tz: string): Date {
  const valid = [...new Set(times.filter((t) => HHMM.test(t)))].sort();
  if (!valid.length) throw new Error("no valid ETL time (use HH:MM)");
  const today = dayIn(tz, now);
  for (let d = 0; d < 3; d++) {
    const day = addDays(today, d);
    for (const t of valid) {
      const at = zonedTime(day, t, tz);
      if (at.getTime() > now.getTime()) return at;
    }
  }
  throw new Error("unreachable: no slot in the next 3 days");
}

export interface Scheduler {
  stop(): void;
}

export function startScheduler(
  run: () => Promise<unknown>,
  times: string[],
  tz: string,
  log: (m: string) => void = (m) => console.log(`[schedule] ${m}`),
  clock: () => Date = () => new Date(),
): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const at = nextRun(clock(), times, tz);
    log(`next run at ${at.toISOString()}`);
    timer = setTimeout(fire, Math.max(at.getTime() - clock().getTime(), 0));
  };
  const fire = () => {
    if (running) {
      log("previous run still going: slot skipped");
    } else {
      running = true;
      run()
        .catch((e) => log(`run failed: ${errorText(e)}`))
        .finally(() => {
          running = false;
        });
    }
    arm();
  };
  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

if (process.argv[1] && /schedule\.(ts|js)$/.test(process.argv[1])) {
  const cfg = loadConfig();
  const bi = openBi(cfg.paths.biDb, cfg.tz);
  const deps = defaultDeps(cfg);
  const s = startScheduler(() => executeEtl(bi, deps), cfg.etlTimes, cfg.tz);
  const shutdown = () => {
    s.stop();
    bi.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
