// Reads and writes of the Register screen. Each write is one transaction: validate, write,
// recompute the spreadsheet formulas, and record in register_history who changed what.
// Optimistic lock on `version`: saving over a newer change gives 409 with the current row.
import type { BiDb, Row } from "../db/bi.js";
import { isIsoDay } from "../lib/dates.js";
import { type Entity, ENTITIES, type Field, writable } from "./definitions.js";
import { recalculate } from "./recalc.js";

export class RegisterError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const MAX_TEXT = 500;
const MAX_LONG = 4000;

// ------------------------------------------------------------------ values

/** Request value → column value. Throws a short message when the type doesn't fit. */
export function convert(f: Field, v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  switch (f.type) {
    case "text":
    case "long": {
      if (typeof v !== "string" && typeof v !== "number") throw new Error("invalid text");
      const s = String(v).trim();
      const max = f.type === "long" ? MAX_LONG : MAX_TEXT;
      if (s.length > max) throw new Error(`at most ${max} characters`);
      return s;
    }
    case "date": {
      const s = String(v).trim();
      if (!isIsoDay(s)) throw new Error("invalid date");
      if (s < "1990-01-01" || s > "2100-12-31") throw new Error("date out of range");
      return s;
    }
    case "integer":
    case "number": {
      // accepts "1 234,5" as typed in a pt-BR spreadsheet
      const n = typeof v === "number" ? v : Number(String(v).trim().replace(/\s/g, "").replace(",", "."));
      if (!Number.isFinite(n)) throw new Error("invalid number");
      if (Math.abs(n) > 1e9) throw new Error("number out of range");
      if (f.type === "integer" && !Number.isInteger(n)) throw new Error("use a whole number");
      return n;
    }
  }
}

/** URL key (text) → key column value, or null when invalid. */
function keyOf(e: Entity, k: string): string | number | null {
  if (e.keyType === "integer") return /^\d{1,9}$/.test(k) ? Number(k) : null;
  if (e.keyType === "date") return isIsoDay(k) ? k : null;
  return k.length > 0 && k.length <= MAX_TEXT ? k : null;
}

// ------------------------------------------------------------------ reads

function columns(e: Entity): string[] {
  return [...new Set([e.key, ...e.fields.map((f) => f.id), ...(e.extras ?? []), "version", "updated_at", "updated_by"])];
}

function decode(e: Entity, r: Row | undefined): Row | null {
  if (!r) return null;
  const out: Row = { ...r };
  if (e.table === "cycle_schedule") {
    out.manual = JSON.parse(String(r.manual ?? "[]"));
    out.duplicate_cycle = !!r.duplicate_cycle;
  }
  return out;
}

export function list(bi: BiDb, e: Entity): Row[] {
  return bi.all(`SELECT ${columns(e).join(", ")} FROM ${e.table} ORDER BY ${e.order}`).map((r) => decode(e, r)!);
}

function read(bi: BiDb, e: Entity, key: string | number): Row | null {
  return decode(e, bi.get(`SELECT ${columns(e).join(", ")} FROM ${e.table} WHERE ${e.key} = $k`, { k: key }));
}

/** Definitions for the screen + suggestions per field + contracts (to pick a project code). */
export function definitions(bi: BiDb) {
  const suggestions: Record<string, Record<string, string[]>> = {};
  for (const e of ENTITIES) {
    for (const f of e.fields) {
      if (!f.suggestions) continue;
      const rows = bi.all<{ v: string | null }>(`SELECT DISTINCT v FROM (${f.suggestions}) s(v) WHERE v IS NOT NULL AND v <> '' ORDER BY 1 LIMIT 500`);
      (suggestions[e.id] ??= {})[f.id] = rows.map((x) => x.v!);
    }
  }
  const contracts = bi.all("SELECT code, municipality, status, frequency FROM contract ORDER BY status = 'Active' DESC, municipality, code");
  return { entities: ENTITIES, suggestions, contracts };
}

export function history(bi: BiDb, f: { entity?: string; key?: string; limit?: number }) {
  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 1000);
  return bi
    .all<Row & { before: string | null; after: string | null }>(
      `SELECT id, entity, key, action, username, at, before, after FROM register_history
        WHERE ($e IS NULL OR entity = $e) AND ($k IS NULL OR key = $k)
        ORDER BY at DESC, id DESC LIMIT $lim`,
      { e: f.entity || null, k: f.key || null, lim: limit },
    )
    .map((r) => ({ ...r, before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null }));
}

// ------------------------------------------------------------------ writes

interface Input {
  values: Map<string, string | number | null>;
  manual: string[] | null;
}

/** Validates the request body. `current` = stored row (update) or null (create). */
function validate(bi: BiDb, e: Entity, body: Row, current: Row | null): { input: Input; warnings: string[] } {
  const errors: Record<string, string> = {};
  const values = new Map<string, string | number | null>();
  const warnings: string[] = [];

  let manual: string[] | null = null;
  if (e.table === "cycle_schedule") {
    const asked = Array.isArray(body.manual) ? body.manual.filter((x): x is string => typeof x === "string") : ((current?.manual as string[] | undefined) ?? []);
    const ok = new Set(e.fields.filter((f) => f.manual).map((f) => f.id));
    manual = [...new Set(asked.filter((x) => ok.has(x)))];
  }

  for (const f of writable(e)) {
    if (current && f.immutable) continue;
    if (f.manual && !manual?.includes(f.id)) continue; // follows the formula: a sent value is ignored
    if (!(f.id in body) && current) continue; // partial update keeps what is stored
    try {
      values.set(f.id, convert(f, body[f.id]));
    } catch (err) {
      errors[f.id] = err instanceof Error ? err.message : String(err);
    }
  }
  const value = (id: string) => (values.has(id) ? values.get(id) : (current?.[id] ?? null));
  for (const f of e.fields) {
    if (f.required && !f.calc && (value(f.id) === null || value(f.id) === "")) errors[f.id] ??= "required";
  }

  // project code must exist among contracts (a validation list in the sheet)
  const ref = e.fields.find((f) => f.refContract);
  let contract: Row | undefined;
  if (ref && value(ref.id)) {
    contract = bi.get("SELECT code, municipality FROM contract WHERE code = $c", { c: value(ref.id) });
    const changed = !current || current[ref.id] !== value(ref.id);
    if (!contract && changed) errors[ref.id] ??= "code not among the registered contracts";
  }
  if (Object.keys(errors).length) throw new RegisterError(422, "Fix the highlighted fields.", { fields: errors });

  // empty municipality = the contract's
  if (contract && e.fields.some((f) => f.id === "municipality" && !f.calc) && !value("municipality")) {
    values.set("municipality", contract.municipality as string);
  }
  // with a term, the cycle deadline comes from the formula
  if (e.table === "cycle_schedule" && value("cycle_term_days") !== null) values.delete("cycle_deadline");
  // empty duration = calendar days from start to end, counting both (as the team filled it)
  if (e.table === "site_visit" && value("duration_days") === null && value("starts_on") && value("ends_on")) {
    const d = (Date.parse(String(value("ends_on"))) - Date.parse(String(value("starts_on")))) / 86_400_000 + 1;
    if (d >= 1) values.set("duration_days", d);
  }

  // consistency: warn, don't block (old rows don't always follow the pattern)
  const before = (a: string, b: string, msg: string) => {
    const va = value(a);
    const vb = value(b);
    if (va && vb && String(vb) < String(va)) warnings.push(msg);
  };
  before("starts_on", "ends_on", "The end is before the start.");
  before("capture_start", "capture_end", "Capture ends before it starts.");
  if (e.table === "cycle_schedule" && value("code") && value("cycle") !== null) {
    const r = bi.get<{ n: number }>("SELECT count(*) AS n FROM cycle_schedule WHERE code = $c AND cycle = $y AND id IS NOT $id", {
      c: value("code"),
      y: value("cycle"),
      id: current?.id ?? null,
    });
    if ((r?.n ?? 0) > 0) warnings.push(`Cycle ${value("cycle")} of ${value("code")} already exists in another row.`);
  }
  return { input: { values, manual }, warnings };
}

function record(bi: BiDb, e: Entity, key: unknown, action: string, user: string | null, before: Row | null, after: Row | null, at: string) {
  bi.run("INSERT INTO register_history (entity, key, action, username, at, before, after) VALUES ($e, $k, $a, $u, $at, $b, $af)", {
    e: e.id,
    k: String(key),
    a: action,
    u: user,
    at,
    b: before ? JSON.stringify(before) : null,
    af: after ? JSON.stringify(after) : null,
  });
}

function write<T>(bi: BiDb, e: Entity, fn: () => T): T {
  try {
    return bi.tx(fn);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new RegisterError(409, "A record with this key already exists.");
    }
    throw err;
  } finally {
    if (e.table === "holiday") bi.refreshCalendar(); // after a rollback, back to what is stored
  }
}

const nowIso = () => new Date().toISOString();

/** After the row is written: the formulas, seeing a new holiday if that is what changed. */
function recompute(bi: BiDb, e: Entity) {
  if (e.table === "holiday") bi.refreshCalendar();
  recalculate(bi);
}

export function create(bi: BiDb, e: Entity, body: Row, user: string | null) {
  return write(bi, e, () => {
    const { input, warnings } = validate(bi, e, body, null);
    const cols = [...input.values.keys()];
    const vals: unknown[] = [...input.values.values()];
    if (input.manual) {
      cols.push("manual");
      vals.push(JSON.stringify(input.manual));
    }
    const at = nowIso();
    cols.push("updated_at", "updated_by");
    vals.push(at, user);
    const r = bi.get<Row>(`INSERT INTO ${e.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING ${e.key} AS k`, vals);
    const key = r!.k as string | number;
    recompute(bi, e);
    const after = read(bi, e, key);
    record(bi, e, key, "create", user, null, after, at);
    return { row: after, warnings };
  });
}

export function update(bi: BiDb, e: Entity, keyText: string, body: Row, user: string | null) {
  const key = keyOf(e, keyText);
  if (key === null) throw new RegisterError(404, "Record not found.");
  return write(bi, e, () => {
    const current = read(bi, e, key);
    if (!current) throw new RegisterError(404, "Record not found (someone may have deleted it).");
    if (body.version !== undefined && Number(body.version) !== current.version) {
      throw new RegisterError(409, `This ${e.item} was changed by ${current.updated_by ?? "someone else"} after you opened it. Check the current data and save again.`, { current });
    }
    const { input, warnings } = validate(bi, e, body, current);
    const sets = [...input.values.keys()].map((k) => `${k} = ?`);
    const vals: unknown[] = [...input.values.values()];
    if (input.manual) {
      sets.push("manual = ?");
      vals.push(JSON.stringify(input.manual));
    }
    const at = nowIso();
    sets.push("version = version + 1", "updated_at = ?", "updated_by = ?");
    vals.push(at, user, key);
    bi.run(`UPDATE ${e.table} SET ${sets.join(", ")} WHERE ${e.key} = ?`, vals);
    recompute(bi, e);
    const after = read(bi, e, key);
    record(bi, e, key, "update", user, current, after, at);
    return { row: after, warnings };
  });
}

export function remove(bi: BiDb, e: Entity, keyText: string, version: unknown, user: string | null) {
  const key = keyOf(e, keyText);
  if (key === null) throw new RegisterError(404, "Record not found.");
  return write(bi, e, () => {
    const current = read(bi, e, key);
    if (!current) throw new RegisterError(404, "Record not found (someone may have deleted it).");
    if (version !== undefined && version !== null && version !== "" && Number(version) !== current.version) {
      throw new RegisterError(409, `This ${e.item} was changed by ${current.updated_by ?? "someone else"} after you opened it.`, { current });
    }
    if (e.table === "contract") {
      const d = bi.get<{ s: number; v: number; r: number }>(
        `SELECT (SELECT count(*) FROM cycle_schedule WHERE code = $k) AS s, (SELECT count(*) FROM site_visit WHERE code = $k) AS v,
                (SELECT count(*) FROM monthly_report WHERE project = $k) AS r`,
        { k: key },
      )!;
      if (d.s + d.v + d.r > 0) {
        throw new RegisterError(409, `The contract has ${d.s} cycle(s), ${d.v} visit(s) and ${d.r} report(s). Delete them or change their code first.`);
      }
    }
    bi.run(`DELETE FROM ${e.table} WHERE ${e.key} = $k`, { k: key });
    recompute(bi, e);
    record(bi, e, key, "delete", user, current, null, nowIso());
    return { ok: true };
  });
}
