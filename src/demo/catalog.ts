// The fictional customer base of the demo: cities, monitoring projects (contracts), their cycles,
// visits and monthly reports. Used both to fill the Register and to drive the source simulation,
// so a cycle delivered in the Register is the day its alerts appear in the consolidated table.
import { BusinessCalendar } from "../lib/calendar.js";
import { addDays } from "../lib/dates.js";

export interface CityDef {
  database: string;
  city: string;
  host: string;
  /** detection date format at the source: two cities store DD/MM/YYYY text */
  dateFormat: "iso" | "dmy";
  /** alerts analyzed per business day by the city's staff (before any assisted operation) */
  capacity: number;
  /** the city's database predates the edit log (legacy schema) */
  noEditLog?: boolean;
  /** consolidation for this database fails now and then */
  flakyConsolidation?: boolean;
  /** statuses the city created locally, outside the standard lists */
  localStatus?: string;
}

export interface ProjectDef {
  code: string;
  database: string | null;
  municipality: string;
  contractNo: string;
  frequency: "monthly" | "bimonthly" | "quarterly" | "semiannual";
  totalCycles: number;
  areaKm2: number;
  status: "Active" | "Closed" | "Planned";
  startsOn: string;
  /** alerts per cycle, roughly */
  alertsPerCycle: number;
}

export const CITIES: CityDef[] = [
  { database: "rivermeadow", city: "Rivermeadow", host: "203.0.113.10", dateFormat: "iso", capacity: 7 },
  { database: "lakeside", city: "Lakeside", host: "203.0.113.11", dateFormat: "dmy", capacity: 4 },
  { database: "oakwood", city: "Oakwood", host: "203.0.113.12", dateFormat: "iso", capacity: 5, localStatus: "Awaiting legal review" },
  { database: "pinecrest", city: "Pinecrest", host: "203.0.113.13", dateFormat: "dmy", capacity: 3, flakyConsolidation: true },
  { database: "stonebridge", city: "Stonebridge", host: "203.0.113.14", dateFormat: "iso", capacity: 2, noEditLog: true },
];

export const PROJECTS: ProjectDef[] = [
  { code: "RVM-01", database: "rivermeadow", municipality: "Rivermeadow", contractNo: "014/2026", frequency: "quarterly", totalCycles: 4, areaKm2: 182.5, status: "Active", startsOn: "2026-01-12", alertsPerCycle: 170 },
  { code: "LKS-01", database: "lakeside", municipality: "Lakeside", contractNo: "102/2025", frequency: "bimonthly", totalCycles: 6, areaKm2: 96, status: "Active", startsOn: "2026-02-02", alertsPerCycle: 70 },
  { code: "OAK-01", database: "oakwood", municipality: "Oakwood", contractNo: "33/2026", frequency: "quarterly", totalCycles: 4, areaKm2: 120.4, status: "Active", startsOn: "2026-02-16", alertsPerCycle: 110 },
  { code: "OAK-02", database: "oakwood", municipality: "Oakwood", contractNo: "34/2026", frequency: "semiannual", totalCycles: 2, areaKm2: 310, status: "Active", startsOn: "2026-03-02", alertsPerCycle: 60 },
  { code: "PNC-01", database: "pinecrest", municipality: "Pinecrest", contractNo: "7/2026", frequency: "monthly", totalCycles: 12, areaKm2: 41.3, status: "Active", startsOn: "2026-01-05", alertsPerCycle: 22 },
  { code: "STB-01", database: "stonebridge", municipality: "Stonebridge", contractNo: "58/2025", frequency: "quarterly", totalCycles: 4, areaKm2: 75, status: "Active", startsOn: "2026-03-16", alertsPerCycle: 45 },
  { code: "BRK-01", database: null, municipality: "Brookfield", contractNo: "—", frequency: "quarterly", totalCycles: 4, areaKm2: 64, status: "Planned", startsOn: "2027-01-11", alertsPerCycle: 0 },
];

/** National holidays and company bridge days used by the business-day formulas. */
export const HOLIDAYS: [string, string][] = [
  ["2026-01-01", "New Year"],
  ["2026-02-16", "Carnival"],
  ["2026-02-17", "Carnival"],
  ["2026-04-03", "Good Friday"],
  ["2026-04-21", "National holiday"],
  ["2026-05-01", "Labour Day"],
  ["2026-06-04", "Corpus Christi"],
  ["2026-06-05", "Bridge day"],
  ["2026-09-07", "Independence Day"],
  ["2026-10-12", "National holiday"],
  ["2026-11-02", "All Souls' Day"],
  ["2026-11-20", "National holiday"],
  ["2026-12-24", "Bridge day"],
  ["2026-12-25", "Christmas"],
  ["2026-12-31", "Bridge day"],
  ["2027-01-01", "New Year"],
];

export const STAFF = ["Ana Reyes", "Leo Marsh", "Priya Nand", "Tom Okafor"];

const PERIOD_DAYS: Record<ProjectDef["frequency"], number> = { monthly: 30, bimonthly: 61, quarterly: 91, semiannual: 182 };
const PRODUCTION_DAYS = 15;
const ROLLOUT_DAYS = 5;
const CYCLE_TERM_DAYS = 37; // N + 7 in the old sheet

export interface CycleDef {
  code: string;
  cycle: number;
  captureStart: string;
  captureEnd: string;
  productionDays: number;
  /** the day the change product was delivered = the day its alerts reach the cities */
  productDelivered: string | null;
  rolloutOpenedOn: string | null;
  rolloutDays: number;
  cycleTermDays: number | null;
  cycleDeadline: string | null;
  cycleDelivered: string | null;
}

/**
 * Cycles of every project. Deterministic: capture every period from the contract start; the
 * product is delivered a few business days around its deadline; cycles whose delivery would be
 * after `today` are left undelivered.
 */
export function cycles(today: string, cal = new BusinessCalendar(HOLIDAYS.map((h) => h[0]))): CycleDef[] {
  const out: CycleDef[] = [];
  for (const p of PROJECTS) {
    for (let k = 1; k <= p.totalCycles; k++) {
      const captureEnd = addDays(p.startsOn, PERIOD_DAYS[p.frequency] * (k - 1) + 20);
      const captureStart = addDays(captureEnd, -12);
      if (captureStart > addDays(today, 120)) break;
      const deadline = cal.workdayAdd(captureEnd, PRODUCTION_DAYS)!;
      const jitter = ((k * 7 + p.code.charCodeAt(0)) % 7) - 3; // −3 … +3 business days
      const delivered = cal.workdayAdd(deadline, jitter)!;
      const isDelivered = delivered <= today;
      const rolloutOpened = isDelivered ? delivered : null;
      const rolloutDone = rolloutOpened ? cal.workdayAdd(rolloutOpened, ROLLOUT_DAYS + (k % 3) - 1)! : null;
      // the first cycle of a project had its deadline typed by hand (no term), as in old sheets
      const typed = k === 1 ? addDays(deadline, 40) : null;
      out.push({
        code: p.code,
        cycle: k,
        captureStart,
        captureEnd,
        productionDays: PRODUCTION_DAYS,
        productDelivered: isDelivered ? delivered : null,
        rolloutOpenedOn: rolloutOpened,
        rolloutDays: ROLLOUT_DAYS,
        cycleTermDays: typed ? null : CYCLE_TERM_DAYS,
        cycleDeadline: typed,
        cycleDelivered: rolloutDone && rolloutDone <= today ? rolloutDone : null,
      });
    }
  }
  return out;
}

export interface VisitDef {
  code: string;
  cycle: number | null;
  responsible: string;
  startsOn: string;
  endsOn: string;
  reason: string;
  departments: string;
  actions: string;
}

/** Visits relative to the timeline start: kick-offs, trainings and three assisted operations. */
export function visits(timelineStart: string): VisitDef[] {
  const d = (n: number) => addDays(timelineStart, n);
  return [
    { code: "RVM-01", cycle: 1, responsible: "Ana Reyes", startsOn: "2026-02-09", endsOn: "2026-02-09", reason: "Kick-off meeting", departments: "Urban Planning; Tax Office", actions: "Presented the monitoring workflow." },
    { code: "LKS-01", cycle: 2, responsible: "Leo Marsh", startsOn: "2026-05-18", endsOn: "2026-05-19", reason: "Training", departments: "Urban Planning", actions: "Trained 6 analysts on the desktop GIS." },
    { code: "LKS-01", cycle: 3, responsible: "Leo Marsh", startsOn: d(28), endsOn: d(30), reason: "Assisted operation", departments: "Urban Planning; Environment", actions: "Analyzed the backlog side by side with the city's team; field app installed on 4 devices." },
    { code: "OAK-01", cycle: 2, responsible: "Priya Nand", startsOn: d(45), endsOn: d(47), reason: "Assisted operation", departments: "Urban Planning; Legal", actions: "Defined the legal-review path; field app rollout." },
    { code: "OAK-02", cycle: null, responsible: "Priya Nand", startsOn: "2026-04-14", endsOn: "2026-04-14", reason: "Technical visit", departments: "Environment", actions: "Rural area boundaries reviewed." },
    { code: "RVM-01", cycle: 3, responsible: "Ana Reyes", startsOn: d(76), endsOn: d(77), reason: "Assisted operation", departments: "Urban Planning; Tax Office; Public Works", actions: "Joint inspection planning; mobile sync troubleshooting." },
    { code: "PNC-01", cycle: null, responsible: "Tom Okafor", startsOn: d(12), endsOn: d(12), reason: "Technical visit", departments: "Urban Planning", actions: "Checked the consolidation failures with the city's IT." },
  ];
}
