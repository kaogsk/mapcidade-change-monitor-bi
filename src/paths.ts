import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root, both from src/ (tsx) and dist/ (node). */
export const projectRoot = resolve(here, "..");
export const publicDir = resolve(projectRoot, "public");
/** SQL files ship next to the sources (read at runtime, also from dist/). */
export const sqlDir = resolve(projectRoot, "src", "etl", "sql");
export const schemaFile = resolve(projectRoot, "src", "db", "schema.sql");
