import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openBi } from "./db/bi.js";

const config = loadConfig();
const bi = openBi(config.paths.biDb, config.tz);
const app = buildApp({ bi, config });
const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`[change-monitor-bi] http://127.0.0.1:${config.port}`);
});

const shutdown = () => {
  server.close(() => {
    bi.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
