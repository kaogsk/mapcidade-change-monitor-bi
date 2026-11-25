// Everything that was a FORMULA in the control spreadsheet, recomputed in the database after every
// write of the Register screen, in the same transaction. Changing a holiday or a contract redoes
// the whole schedule, as Excel would. A few hundred rows: cheap.
//
// Schedule formulas (each reads the other columns as stored):
//   frequency          = contract frequency (VLOOKUP)
//   product_deadline   = WORKDAY(capture_end, production_days, holidays)
//   product_expected   = WORKDAY(capture_end, production_days, holidays)       (same, own column)
//   rollout_expected   = WORKDAY(rollout_opened_on, rollout_days, holidays)
//   cycle_deadline     = product_deadline + cycle_term_days                    (no term: typed date)
//   slack_days         = cycle_deadline − cycle_delivered                       (+ slack, − late)
//   signature_planned  = cycle_deadline + 14
//   km2_done           = contract area when the cycle was delivered, else 0
// Because one formula feeds the next (deadline → cycle deadline → slack), the update runs until
// nothing changes (a fixpoint), not a fixed number of passes.
//
// `manual` lists the calculated columns of a row typed OVER the formula (like overwriting a cell
// in Excel — e.g. one cycle's km² split in four rows). Those keep their typed value.
import type { BiDb } from "../db/bi.js";

export const MANUAL_COLUMNS = ["product_deadline", "product_expected", "rollout_expected", "signature_planned", "km2_done"] as const;

const isManual = (col: string) => `EXISTS (SELECT 1 FROM json_each(cycle_schedule.manual) WHERE value = '${col}')`;
const keep = (col: string, formula: string) => `CASE WHEN ${isManual(col)} THEN cycle_schedule.${col} ELSE ${formula} END`;

const RULE = `
  SELECT g.id,
         coalesce(k.frequency, g.frequency)                                       AS frequency,
         workday_add(g.capture_end, g.production_days)                            AS product_deadline,
         workday_add(g.capture_end, g.production_days)                            AS product_expected,
         workday_add(g.rollout_opened_on, g.rollout_days)                         AS rollout_expected,
         CASE WHEN g.cycle_term_days IS NOT NULL AND g.product_deadline IS NOT NULL
              THEN date(g.product_deadline, '+' || g.cycle_term_days || ' days')
              ELSE g.cycle_deadline END                                           AS cycle_deadline,
         CASE WHEN g.cycle_delivered IS NOT NULL AND g.cycle_deadline IS NOT NULL
              THEN CAST(julianday(g.cycle_deadline) - julianday(g.cycle_delivered) AS INTEGER) END AS slack_days,
         date(g.cycle_deadline, '+14 days')                                       AS signature_planned,
         CASE WHEN g.cycle_delivered IS NULL THEN 0 ELSE k.area_km2 END           AS km2_done
    FROM cycle_schedule g
    LEFT JOIN contract k ON k.code = g.code`;

const UPDATE_SCHEDULE = `
  UPDATE cycle_schedule
     SET frequency         = r.frequency,
         product_deadline  = ${keep("product_deadline", "r.product_deadline")},
         product_expected  = ${keep("product_expected", "r.product_expected")},
         rollout_expected  = ${keep("rollout_expected", "r.rollout_expected")},
         cycle_deadline    = r.cycle_deadline,
         slack_days        = r.slack_days,
         signature_planned = ${keep("signature_planned", "r.signature_planned")},
         km2_done          = ${keep("km2_done", "r.km2_done")}
    FROM (${RULE}) r
   WHERE r.id = cycle_schedule.id
     AND (cycle_schedule.frequency IS NOT r.frequency
       OR cycle_schedule.product_deadline IS NOT ${keep("product_deadline", "r.product_deadline")}
       OR cycle_schedule.product_expected IS NOT ${keep("product_expected", "r.product_expected")}
       OR cycle_schedule.rollout_expected IS NOT ${keep("rollout_expected", "r.rollout_expected")}
       OR cycle_schedule.cycle_deadline IS NOT r.cycle_deadline
       OR cycle_schedule.slack_days IS NOT r.slack_days
       OR cycle_schedule.signature_planned IS NOT ${keep("signature_planned", "r.signature_planned")}
       OR cycle_schedule.km2_done IS NOT ${keep("km2_done", "r.km2_done")})`;

export const MAX_PASSES = 6;

/** Recomputes every formula. Returns the number of passes the schedule needed. */
export function recalculate(bi: BiDb): number {
  // Total_Area = total cycles × area
  bi.run("UPDATE contract SET total_area_km2 = total_cycles * area_km2 WHERE total_area_km2 IS NOT total_cycles * area_km2");

  let passes = 0;
  while (passes < MAX_PASSES) {
    passes++;
    if (bi.run(UPDATE_SCHEDULE).changes === 0) break;
  }

  // same cycle twice in one project
  bi.run(`
    UPDATE cycle_schedule SET duplicate_cycle = d.dup
      FROM (SELECT id, (count(*) OVER (PARTITION BY code, cycle) > 1) AS dup FROM cycle_schedule) d
     WHERE d.id = cycle_schedule.id AND cycle_schedule.duplicate_cycle IS NOT d.dup`);

  // Monthly reports: municipality and project status from the contract; status "Delivered" when
  // there is a delivery date; delay = delivered − due (empty until delivered — in the sheet the
  // formula produced a meaningless number counted from 1899).
  bi.run(`
    UPDATE monthly_report
       SET municipality = n.municipality, project_status = n.project_status, status = n.status, delay_days = n.delay_days
      FROM (SELECT r0.id,
                   coalesce(k.municipality, r0.municipality) AS municipality,
                   coalesce(k.status, r0.project_status)     AS project_status,
                   CASE WHEN r0.delivered_on IS NOT NULL THEN 'Delivered' END AS status,
                   CAST(julianday(r0.delivered_on) - julianday(r0.due_on) AS INTEGER) AS delay_days
              FROM monthly_report r0 LEFT JOIN contract k ON k.code = r0.project) n
     WHERE n.id = monthly_report.id
       AND (monthly_report.municipality IS NOT n.municipality OR monthly_report.project_status IS NOT n.project_status
         OR monthly_report.status IS NOT n.status OR monthly_report.delay_days IS NOT n.delay_days)`);
  return passes;
}
