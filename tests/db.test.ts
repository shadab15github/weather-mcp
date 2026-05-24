import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DB_FILE = path.join(os.tmpdir(), `weather-mcp-test-${process.pid}-${Date.now()}.db`);
process.env.WEATHER_MCP_DB_PATH = DB_FILE;

// Dynamically import so the WEATHER_MCP_DB_PATH env var is honored at module init.
const db = await import("../db.js");

afterAll(() => {
  try {
    fs.unlinkSync(DB_FILE);
  } catch {
    // ignore
  }
});

beforeAll(() => {
  db.deleteHistory({ all: true });
});

describe("logSearch + getHistory basics", () => {
  it("inserts and reads back rows with all fields", () => {
    db.deleteHistory({ all: true });

    db.logSearch({
      city: "Mumbai",
      tool: "get_current_weather",
      summary: "30°C",
      rawResponse: { foo: 1 },
      lat: 19.07,
      lon: 72.88,
      country: "IN",
    });

    const rows = db.getHistory();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.city).toBe("Mumbai");
    expect(r.tool).toBe("get_current_weather");
    expect(r.summary).toBe("30°C");
    expect(r.lat).toBe(19.07);
    expect(r.lon).toBe(72.88);
    expect(r.country).toBe("IN");
    expect(r.times_searched).toBe(1);
    expect(JSON.parse(r.raw_response!).foo).toBe(1);
  });

  it("filters by city (case-insensitive)", () => {
    db.deleteHistory({ all: true });
    db.logSearch({ city: "Mumbai", tool: "get_current_weather", summary: "a", rawResponse: {} });
    db.logSearch({ city: "Delhi", tool: "get_current_weather", summary: "b", rawResponse: {} });
    expect(db.getHistory({ city: "mumbai" })).toHaveLength(1);
    expect(db.getHistory({ city: "MUMBAI" })).toHaveLength(1);
    expect(db.getHistory({ city: "Delhi" })).toHaveLength(1);
    expect(db.getHistory({ city: "Tokyo" })).toHaveLength(0);
  });

  it("limit caps the row count", () => {
    db.deleteHistory({ all: true });
    for (let i = 0; i < 10; i++) {
      db.logSearch({ city: `City${i}`, tool: "get_current_weather", summary: "x", rawResponse: {} });
    }
    expect(db.getHistory({ limit: 3 })).toHaveLength(3);
  });

  it("days returns only rows in the window", () => {
    db.deleteHistory({ all: true });
    db.logSearch({ city: "Recent", tool: "get_current_weather", summary: "x", rawResponse: {} });
    // days=0 wouldn't be valid in the schema, but the SQL accepts any positive number.
    expect(db.getHistory({ days: 1 })).toHaveLength(1);
  });
});

describe("60-second rolling dedupe", () => {
  it("collapses rapid same-city/tool searches and increments times_searched", () => {
    db.deleteHistory({ all: true });
    db.logSearch({ city: "Mumbai", tool: "get_current_weather", summary: "v1", rawResponse: {} });
    db.logSearch({ city: "MUMBAI", tool: "get_current_weather", summary: "v2", rawResponse: {} });
    db.logSearch({ city: "mumbai", tool: "get_current_weather", summary: "v3", rawResponse: {} });

    const rows = db.getHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0].times_searched).toBe(3);
    expect(rows[0].summary).toBe("v3");
  });

  it("does NOT dedupe across different tools", () => {
    db.deleteHistory({ all: true });
    db.logSearch({ city: "Mumbai", tool: "get_current_weather", summary: "a", rawResponse: {} });
    db.logSearch({ city: "Mumbai", tool: "get_weather_forecast", summary: "b", rawResponse: {} });
    expect(db.getHistory()).toHaveLength(2);
  });

  it("does NOT dedupe across different cities", () => {
    db.deleteHistory({ all: true });
    db.logSearch({ city: "Mumbai", tool: "get_current_weather", summary: "a", rawResponse: {} });
    db.logSearch({ city: "Delhi", tool: "get_current_weather", summary: "b", rawResponse: {} });
    expect(db.getHistory()).toHaveLength(2);
  });

  it("preserves country/lat/lon via COALESCE when later updates omit them", () => {
    db.deleteHistory({ all: true });
    db.logSearch({
      city: "Mumbai",
      tool: "get_current_weather",
      summary: "a",
      rawResponse: {},
      lat: 19.07,
      lon: 72.88,
      country: "IN",
    });
    db.logSearch({
      city: "Mumbai",
      tool: "get_current_weather",
      summary: "b",
      rawResponse: {},
      // no lat/lon/country passed
    });
    const rows = db.getHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0].lat).toBe(19.07);
    expect(rows[0].country).toBe("IN");
    expect(rows[0].times_searched).toBe(2);
  });
});

describe("deleteHistory", () => {
  it("refuses an unfiltered delete", () => {
    expect(() => db.deleteHistory({})).toThrow(/at least one filter/);
  });

  it("deletes by city", () => {
    db.deleteHistory({ all: true });
    db.logSearch({ city: "Mumbai", tool: "get_current_weather", summary: "a", rawResponse: {} });
    db.logSearch({ city: "Delhi", tool: "get_current_weather", summary: "b", rawResponse: {} });
    const deleted = db.deleteHistory({ city: "Mumbai" });
    expect(deleted).toBe(1);
    expect(db.getHistory()).toHaveLength(1);
  });

  it("deletes all when all=true", () => {
    db.deleteHistory({ all: true });
    db.logSearch({ city: "X", tool: "get_current_weather", summary: "x", rawResponse: {} });
    db.logSearch({ city: "Y", tool: "get_current_weather", summary: "y", rawResponse: {} });
    expect(db.deleteHistory({ all: true })).toBe(2);
    expect(db.getHistory()).toHaveLength(0);
  });
});

describe("trimRawResponses", () => {
  it("nulls raw_response only for rows older than the cutoff", async () => {
    db.deleteHistory({ all: true });
    db.logSearch({ city: "Recent", tool: "get_current_weather", summary: "a", rawResponse: { keep: true } });

    // Backdate a row using the raw DB connection — we don't have time-travel
    // exposed via the public API, so reach in via a fresh handle.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(DB_FILE);
    raw.prepare(
      `INSERT INTO searches (city, tool, summary, raw_response, searched_at)
       VALUES ('Old', 'get_current_weather', 'b', '{"old":true}', datetime('now','-10 days'))`,
    ).run();
    raw.close();

    expect(db.getHistory()).toHaveLength(2);

    const trimmed = db.trimRawResponses(7);
    expect(trimmed).toBe(1);

    const rows = db.getHistory();
    const recent = rows.find((r) => r.city === "Recent")!;
    const old = rows.find((r) => r.city === "Old")!;
    expect(recent.raw_response).not.toBeNull();
    expect(old.raw_response).toBeNull();
  });
});

describe("getStats + getDistinctCities", () => {
  it("returns zero-state when empty", () => {
    db.deleteHistory({ all: true });
    const stats = db.getStats(30);
    expect(stats.total).toBe(0);
    expect(stats.topCities).toEqual([]);
    expect(stats.firstSearchAt).toBeNull();
  });

  it("sums times_searched in topCities (intent count, not row count)", () => {
    db.deleteHistory({ all: true });
    db.logSearch({ city: "Mumbai", tool: "get_current_weather", summary: "a", rawResponse: {}, country: "IN" });
    db.logSearch({ city: "Mumbai", tool: "get_current_weather", summary: "b", rawResponse: {}, country: "IN" });
    db.logSearch({ city: "Mumbai", tool: "get_weather_forecast", summary: "c", rawResponse: {}, country: "IN" });
    // 1 deduped row (×2) + 1 distinct-tool row = 2 rows, 3 intents

    const stats = db.getStats(30);
    expect(stats.total).toBe(2);
    expect(stats.topCities[0].city).toBe("Mumbai");
    expect(stats.topCities[0].country).toBe("IN");
    expect(stats.topCities[0].count).toBe(3); // sum of times_searched
  });

  it("getDistinctCities returns one row per city with country", () => {
    db.deleteHistory({ all: true });
    db.logSearch({ city: "Mumbai", tool: "get_current_weather", summary: "a", rawResponse: {}, country: "IN" });
    db.logSearch({ city: "Tokyo",  tool: "get_current_weather", summary: "b", rawResponse: {}, country: "JP" });
    const cities = db.getDistinctCities();
    expect(cities).toHaveLength(2);
    expect(cities.find((c) => c.city === "Mumbai")?.country).toBe("IN");
    expect(cities.find((c) => c.city === "Tokyo")?.country).toBe("JP");
  });
});
