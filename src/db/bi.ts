// The BI's own database (node:sqlite). Opens the file, applies the schema and registers the SQL
// functions the schema and the queries use — the business rules live in SQL, next to the data,
// as they did in the original Postgres version:
//   status_group(s)            grouped alert status (lib/status.ts)
//   try_date(text)             YYYY-MM-DD or DD/MM/YYYY → day, else NULL
//   workday_add(day, n)        Excel WORKDAY over the Register's holidays
//   business_days(from, to)    business days in [from, to]
//   percentile_cont(v, p)      aggregate, like Postgres' percentile_cont … WITHIN GROUP
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { BusinessCalendar } from "../lib/calendar.js";
import { tryDate } from "../lib/dates.js";
import { statusGroup } from "../lib/status.js";
import { schemaFile } from "../paths.js";

export type Row = Record<string, unknown>;
export type Params = Record<string, unknown> | unknown[];

/** JS value → SQLite value: booleans become 0/1, arrays/objects become JSON, undefined → NULL. */
export function toSql(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint" || v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

const namesCache = new Map<string, Set<string>>();

/** `$name` parameters a statement uses (node:sqlite rejects unknown named parameters). */
function paramNames(sql: string): Set<string> {
  let s = namesCache.get(sql);
  if (!s) {
    s = new Set([...sql.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
    namesCache.set(sql, s);
  }
  return s;
}

/**
 * Binds positional (array) or named (object) parameters. Named objects may carry more keys than
 * the statement uses — the screens share one parameter set across many queries — so only the
 * names present in the SQL are passed.
 */
function bind(sql: string, p: Params | undefined): SQLInputValue[] {
  if (p === undefined) return [];
  if (Array.isArray(p)) return p.map(toSql);
  const used = paramNames(sql);
  const o: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(p)) if (used.has(k)) o[k] = toSql(v);
  return [o as unknown as SQLInputValue]; // a named-parameter object (typings only list positional values)
}

export class BiDb {
  readonly db: DatabaseSync;
  readonly calendar = new BusinessCalendar();
  private depth = 0;

  constructor(
    readonly path: string,
    readonly tz: string,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
    this.registerFunctions();
    this.db.exec(readFileSync(schemaFile, "utf-8"));
    this.refreshCalendar();
  }

  private registerFunctions(): void {
    const cal = this.calendar;
    this.db.function("status_group", { deterministic: true }, (s) => statusGroup(s == null ? null : String(s)));
    this.db.function("try_date", { deterministic: true }, (t) => tryDate(t));
    this.db.function("workday_add", (d, n) => cal.workdayAdd(d == null ? null : String(d), n == null ? null : Number(n)));
    this.db.function("business_days", (a, b) => cal.businessDays(a == null ? null : String(a), b == null ? null : String(b)));
    // node:sqlite keeps any JS value as the accumulator; its typings only admit SQL values.
    type Acc = { v: number[]; p: number };
    const agg = {
      start: () => ({ v: [], p: 0.5 }) as Acc,
      step: (acc: Acc, value: unknown, p: unknown) => {
        if (value != null) acc.v.push(Number(value));
        acc.p = Number(p);
        return acc;
      },
      result: (acc: Acc) => percentileCont(acc.v, acc.p),
    };
    this.db.aggregate("percentile_cont", agg as unknown as Parameters<DatabaseSync["aggregate"]>[1]);
  }

  /** Reloads the holidays the business-day functions use. Call after writing `holiday`. */
  refreshCalendar(): void {
    this.calendar.reset(this.all<{ day: string }>("SELECT day FROM holiday").map((r) => r.day));
  }

  all<T = Row>(sql: string, p?: Params): T[] {
    return this.db.prepare(sql).all(...bind(sql, p)) as T[];
  }

  get<T = Row>(sql: string, p?: Params): T | undefined {
    return this.db.prepare(sql).get(...bind(sql, p)) as T | undefined;
  }

  run(sql: string, p?: Params): { changes: number; lastId: number } {
    const r = this.db.prepare(sql).run(...bind(sql, p));
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Transaction (savepoint when nested). Rolls back on throw. */
  tx<T>(fn: () => T): T {
    const name = `sp${this.depth}`;
    this.db.exec(this.depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      const r = fn();
      this.depth--;
      this.db.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${name}`);
      return r;
    } catch (e) {
      this.depth--;
      this.db.exec(this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    }
  }

  /**
   * Async transaction, for the ETL: a source stream is awaited while the BI transaction is open.
   * Only the ETL process writes through this connection, so nothing else interleaves on it.
   */
  async txAsync<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth > 0) throw new Error("txAsync cannot be nested");
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const r = await fn();
      this.depth--;
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.depth--;
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Linear-interpolation percentile (same as Postgres percentile_cont). */
export function percentileCont(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

export function openBi(path: string, tz = "America/Sao_Paulo"): BiDb {
  return new BiDb(path, tz);
}
