import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openBi } from "../src/db/bi.js";
import { seed } from "../src/demo/seed.js";
import { BusinessCalendar } from "../src/lib/calendar.js";

it("generates sources, preserves snapshots and exposes an authenticated monitoring API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mapcidade-change-"));
  const cfg = loadConfig({
    BI_DB_PATH: join(dir, "bi.db"),
    SOURCES_PATH: join(dir, "sources.json"),
    SUPPORT_DB_PATH: join(dir, "support.db"),
    DIRECTORY_PATH: join(dir, "directory.json"),
  });
  try {
    const first = await seed(cfg, "2026-10-31");
    expect(first.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ routine: "alerts", r: expect.objectContaining({ status: "ok", database: "pinecrest" }) }),
      expect.objectContaining({ routine: "edits", r: expect.objectContaining({ status: "error", database: "stonebridge" }) }),
    ]));
    const next = await seed(cfg, "2026-11-02");
    expect(next.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ routine: "alerts", r: expect.objectContaining({ status: "kept", database: "pinecrest" }) }),
    ]));
    const bi = openBi(cfg.paths.biDb, cfg.tz);
    try {
      const app = request.agent(buildApp({ bi, config: cfg }));
      await app.get("/api/monitor").expect(401);
      await app.post("/auth/login").send({ username: "demo", password: "demo-password" }).expect(200);
      const meta = await app.get("/api/meta").expect(200);
      expect(meta.body.municipalities).toContain("Lakeside");
      const history = await app.get("/api/history").expect(200);
      expect(history.body.series.some((row: { day: string }) => row.day === "2026-10-31")).toBe(true);
      expect(history.body.series.some((row: { day: string }) => row.day === "2026-11-02")).toBe(true);
      await app.get("/api/monitor?municipality=Lakeside").expect(200);
    } finally {
      bi.close();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}, 15000);

it("counts business days across weekends and holidays", () => {
  const cal = new BusinessCalendar(["2026-06-05"]);
  expect(cal.workdayAdd("2026-06-04", 1)).toBe("2026-06-08");
  expect(cal.businessDays("2026-06-04", "2026-06-08")).toBe(2);
});
