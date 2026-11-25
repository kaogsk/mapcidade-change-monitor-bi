import "dotenv/config";
import { resolve } from "node:path";
import { projectRoot } from "./paths.js";

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

const path = (v: string | undefined, def: string) => resolve(projectRoot, v || def);

export interface Config {
  port: number;
  tz: string;
  etlTimes: string[];
  paths: { biDb: string; sources: string; supportDb: string; directory: string };
  auth: { disabled: boolean; sessionSecret: string; sessionTtlHours: number };
  register: { editors: string[] };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT) || 4401,
    tz: env.APP_TZ || "America/Sao_Paulo",
    etlTimes: (env.ETL_TIMES || "06:10,12:40,17:10,20:10")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    paths: {
      biDb: path(env.BI_DB_PATH, "data/bi.db"),
      sources: path(env.SOURCES_PATH, "data/demo/sources.json"),
      supportDb: path(env.SUPPORT_DB_PATH, "data/demo/support.db"),
      directory: path(env.DIRECTORY_PATH, "data/demo/directory.json"),
    },
    auth: {
      disabled: env.AUTH_DISABLED === "1",
      sessionSecret: env.SESSION_SECRET || "dev-only-secret-change-me",
      sessionTtlHours: Number(env.SESSION_TTL_HOURS) || 12,
    },
    register: { editors: list(env.REGISTER_EDITORS) },
  };
}
