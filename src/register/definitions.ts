// Register screen: what the team used to type in the control spreadsheet, tab by tab. Each entity
// lists its fields in form order, with type, what is required and what was a FORMULA in the
// spreadsheet (`calc`: read-only, recomputed in the database by recalculate()).
//
// Table and column names here are the only identifiers that reach the register's SQL (a closed
// list); nothing coming from the request ever becomes an identifier.

export type FieldType = "text" | "long" | "date" | "integer" | "number";

export interface Field {
  id: string;
  label: string;
  type: FieldType;
  /** Column name in the spreadsheet (shown in the form). */
  sheet?: string;
  required?: boolean;
  /** Spreadsheet formula, in words. Calculated field: read-only. */
  calc?: string;
  /** Calculated field that accepts a typed value over the formula (cycle_schedule.manual). */
  manual?: boolean;
  /** Calculated only when another field is filled (cycle deadline when there is a term). */
  calcWhen?: string;
  /** Can't change after creation (natural key). */
  immutable?: boolean;
  /** Fixed values (rendered as a select). */
  options?: string[];
  /** Project code: must exist among the contracts. */
  refContract?: boolean;
  /** Suggestions (user may type another value): fixed SQL returning column `v`. */
  suggestions?: string;
  help?: string;
  unit?: string;
  group?: string;
  /** Form only (hidden in the table). */
  formOnly?: boolean;
}

export interface Entity {
  id: string;
  label: string;
  item: string;
  sheet: string;
  table: string;
  key: string;
  keyType: "integer" | "text" | "date";
  order: string;
  fields: Field[];
  /** Read-only extra columns returned with each row. */
  extras?: string[];
}

const STAFF = "SELECT value AS v FROM option_list WHERE list = 'staff'";

export const FREQUENCIES = ["monthly", "bimonthly", "quarterly", "four-monthly", "semiannual", "annual"];
export const ASSISTED_OPERATION = "Assisted operation";

export const ENTITIES: Entity[] = [
  {
    id: "contracts",
    label: "Contracts",
    item: "contract",
    sheet: "Contract data",
    table: "contract",
    key: "code",
    keyType: "text",
    order: "municipality, code",
    fields: [
      { id: "municipality", label: "Municipality", type: "text", required: true, sheet: "Municipality", suggestions: "SELECT DISTINCT municipality AS v FROM contract" },
      { id: "code", label: "Project code", type: "text", required: true, immutable: true, sheet: "Code", help: "Same as the project code of the alerts. Can't change after creation." },
      { id: "contract_no", label: "Contract no.", type: "text", sheet: "Contract_No" },
      { id: "starts_on", label: "Starts", type: "date", sheet: "Start" },
      { id: "ends_on", label: "Ends", type: "date", sheet: "End" },
      { id: "frequency", label: "Frequency", type: "text", options: FREQUENCIES, sheet: "Frequency" },
      { id: "total_cycles", label: "Total cycles", type: "integer", sheet: "Total_Cycles" },
      { id: "area_km2", label: "Monitored area", type: "number", unit: "km²", sheet: "Area", help: "Per cycle. Becomes the km² done of each delivered cycle." },
      { id: "total_area_km2", label: "Total area", type: "number", unit: "km²", calc: "Total cycles × monitored area", sheet: "Total_Area" },
      { id: "status", label: "Status", type: "text", required: true, options: ["Active", "Closed", "Planned"], sheet: "Status" },
    ],
  },
  {
    id: "schedule",
    label: "Cycle schedule",
    item: "cycle",
    sheet: "Schedule",
    table: "cycle_schedule",
    key: "id",
    keyType: "integer",
    order: "municipality, code, cycle, id",
    extras: ["duplicate_cycle", "manual"],
    fields: [
      { id: "code", label: "Project code", type: "text", required: true, refContract: true, group: "Project" },
      { id: "municipality", label: "Municipality", type: "text", group: "Project", help: "Empty: the contract's." },
      { id: "cycle", label: "Cycle", type: "integer", required: true, group: "Project" },
      { id: "frequency", label: "Frequency", type: "text", calc: "Contract frequency", group: "Project", formOnly: true },
      { id: "capture_start", label: "Capture start", type: "date", group: "Image capture" },
      { id: "capture_end", label: "Capture end", type: "date", group: "Image capture" },
      { id: "capture_status", label: "Capture status", type: "text", group: "Image capture", suggestions: "SELECT * FROM (VALUES ('Captured'), ('Scheduled'), ('Planned')) UNION SELECT DISTINCT capture_status FROM cycle_schedule" },
      { id: "production_days", label: "Production days", type: "integer", unit: "business days", group: "Change product", formOnly: true },
      { id: "product_deadline", label: "Product deadline", type: "date", calc: "Capture end + production days (business days, minus holidays)", manual: true, group: "Change product", formOnly: true },
      { id: "product_expected", label: "Product expected", type: "date", calc: "Capture end + production days (business days, minus holidays)", manual: true, group: "Change product" },
      { id: "product_delivered", label: "Product delivered", type: "date", group: "Change product" },
      { id: "rollout_opened_on", label: "Rollout ticket opened", type: "date", group: "Rollout", formOnly: true },
      { id: "rollout_days", label: "Rollout execution", type: "integer", unit: "business days", group: "Rollout", formOnly: true },
      { id: "rollout_expected", label: "Rollout expected", type: "date", calc: "Ticket opened + rollout execution (business days, minus holidays)", manual: true, group: "Rollout", formOnly: true },
      { id: "cycle_term_days", label: "Cycle term after product deadline", type: "integer", unit: "calendar days", group: "Cycle delivery", formOnly: true, help: "Empty: type the cycle deadline by hand." },
      { id: "cycle_deadline", label: "Cycle deadline", type: "date", calc: "Product deadline + cycle term", calcWhen: "cycle_term_days", group: "Cycle delivery" },
      { id: "cycle_delivered", label: "Cycle delivered", type: "date", group: "Cycle delivery" },
      { id: "slack_days", label: "Slack (+) / late (−)", type: "integer", unit: "days", calc: "Cycle deadline − cycle delivered", group: "Cycle delivery" },
      { id: "km2_done", label: "km² done", type: "number", unit: "km²", calc: "Contract area when the cycle was delivered, else 0", manual: true, group: "Cycle delivery" },
      { id: "signature_planned", label: "Acceptance signature planned", type: "date", calc: "Cycle deadline + 14 days", manual: true, group: "Acceptance", formOnly: true },
      { id: "request_no", label: "Acceptance request no.", type: "text", group: "Acceptance", formOnly: true },
      { id: "request_signed_on", label: "Acceptance signed", type: "date", group: "Acceptance", formOnly: true },
    ],
  },
  {
    id: "visits",
    label: "Visits",
    item: "visit",
    sheet: "Visits",
    table: "site_visit",
    key: "id",
    keyType: "integer",
    order: "starts_on DESC NULLS LAST, id DESC",
    fields: [
      { id: "code", label: "Project code", type: "text", required: true, refContract: true },
      { id: "municipality", label: "Municipality", type: "text", help: "Empty: the contract's." },
      { id: "cycle", label: "Cycle", type: "integer" },
      { id: "responsible", label: "Responsible", type: "text", suggestions: `${STAFF} UNION SELECT DISTINCT trim(responsible) FROM site_visit` },
      { id: "starts_on", label: "Start", type: "date", required: true },
      { id: "ends_on", label: "End", type: "date" },
      { id: "duration_days", label: "Duration", type: "integer", unit: "days", help: "Empty: days from start to end, counting both." },
      { id: "reason", label: "Reason", type: "text", required: true, help: `"${ASSISTED_OPERATION}" marks the assisted operation on the charts.`, suggestions: `SELECT '${ASSISTED_OPERATION}' AS v UNION SELECT DISTINCT trim(reason) FROM site_visit` },
      { id: "departments", label: "Departments", type: "long" },
      { id: "actions", label: "Actions taken", type: "long", formOnly: true },
    ],
  },
  {
    id: "reports",
    label: "Monthly reports",
    item: "report",
    sheet: "Monthly reports",
    table: "monthly_report",
    key: "id",
    keyType: "integer",
    order: "due_on DESC NULLS LAST, project, measurement",
    fields: [
      { id: "project", label: "Project code", type: "text", required: true, refContract: true },
      { id: "municipality", label: "Municipality", type: "text", calc: "Contract municipality" },
      { id: "project_status", label: "Project status", type: "text", calc: "Contract status", formOnly: true },
      { id: "measurement", label: "Measurement", type: "integer" },
      { id: "responsible", label: "Responsible", type: "text", suggestions: `${STAFF} UNION SELECT DISTINCT responsible FROM monthly_report` },
      { id: "due_on", label: "Due", type: "date", required: true },
      { id: "delivered_on", label: "Delivered", type: "date" },
      { id: "status", label: "Status", type: "text", calc: '"Delivered" when there is a delivery date' },
      { id: "delay_days", label: "Delay", type: "integer", unit: "days", calc: "Delivered − due (negative = early)" },
      { id: "planned_hours", label: "Planned hours", type: "number", unit: "h", formOnly: true },
      { id: "actual_hours", label: "Actual hours", type: "number", unit: "h", formOnly: true },
    ],
  },
  {
    id: "holidays",
    label: "Holidays",
    item: "holiday",
    sheet: "Holidays",
    table: "holiday",
    key: "day",
    keyType: "date",
    order: "day DESC",
    fields: [
      { id: "day", label: "Day", type: "date", required: true, immutable: true, help: "Non-working day. Used by every business-day calculation." },
      { id: "reason", label: "Reason", type: "text", suggestions: "SELECT DISTINCT reason AS v FROM holiday" },
    ],
  },
  {
    id: "lists",
    label: "Lists",
    item: "option",
    sheet: "Options",
    table: "option_list",
    key: "id",
    keyType: "integer",
    order: "list, position NULLS LAST, value",
    fields: [
      { id: "list", label: "List", type: "text", required: true, suggestions: "SELECT * FROM (VALUES ('staff'), ('activity')) UNION SELECT DISTINCT list FROM option_list", help: '"staff" feeds the Responsible suggestions.' },
      { id: "value", label: "Value", type: "text", required: true },
      { id: "position", label: "Position", type: "integer" },
    ],
  },
];

export const entityOf = (id: string): Entity | undefined => ENTITIES.find((e) => e.id === id);

/** Columns a request may write (calculated ones are out; manual overrides come separately). */
export function writable(e: Entity): Field[] {
  return e.fields.filter((f) => !f.calc || f.manual || f.calcWhen);
}
