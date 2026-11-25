// Each monitored city has its own GIS database with an edit log (who inserted/updated/deleted
// which record of which table, from which endpoint). The BI reads it — SELECT only — to know
// whether and when an alert was actually analyzed by the city's staff.
//
// sources.json plays the role of the shared connection catalogue the real ETL used: a list of
// { id, database, host, dsn }. A city can appear twice (production and staging on different
// hosts), so the entry is chosen by database name AND the host the support database lists.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface SourceEntry {
  id: string;
  database: string;
  host: string | null;
  dsn: string;
}

export interface MunicipalSource {
  tableExists(name: string): Promise<boolean>;
  query<T = Record<string, unknown>>(sql: string, params: Record<string, SQLInputValue>): Promise<T[]>;
  close(): Promise<void>;
}

export type MunicipalConnector = (entry: SourceEntry) => Promise<MunicipalSource>;

export function loadSources(path: string): SourceEntry[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { sources?: SourceEntry[] };
  const base = dirname(path);
  return (raw.sources ?? []).map((s) => ({
    ...s,
    host: s.host ?? null,
    // relative sqlite paths are relative to the catalogue file
    dsn: s.dsn.startsWith("sqlite:") && !isAbsolute(s.dsn.slice(7)) ? `sqlite:${resolve(base, s.dsn.slice(7))}` : s.dsn,
  }));
}

/** Same database name: if there is only one entry, take it; with several, the one on the same host. */
export function findSource(sources: SourceEntry[], database: string, host: string | null): SourceEntry | null {
  const same = sources.filter((s) => s.database === database);
  if (same.length <= 1) return same[0] ?? null;
  return same.find((s) => s.host === host) ?? null;
}

/** sqlite:<path> → read-only SQLite connection. Other schemes would plug a Postgres client here. */
export const connectMunicipal: MunicipalConnector = async (entry) => {
  if (!entry.dsn.startsWith("sqlite:")) throw new Error(`unsupported source driver for ${entry.id}`);
  const file = entry.dsn.slice("sqlite:".length);
  if (!existsSync(file)) throw new Error(`could not connect to ${entry.id}: database file missing`);
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    async tableExists(name) {
      return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(name);
    },
    async query<T>(sql: string, params: Record<string, SQLInputValue>) {
      return db.prepare(sql).all(params) as T[];
    },
    async close() {
      db.close();
    },
  };
};
