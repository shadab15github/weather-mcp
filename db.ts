import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "search_history.db");

const db = new DatabaseSync(DB_PATH);

const DEDUPE_WINDOW_SECONDS = 60;
const RAW_RESPONSE_TTL_DAYS = 7;
const AUTO_TRIM_EVERY_N_INSERTS = 100;

// =======================
// SCHEMA + MIGRATIONS
// =======================

db.exec(`
  CREATE TABLE IF NOT EXISTS searches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    city          TEXT    NOT NULL,
    tool          TEXT    NOT NULL,
    summary       TEXT,
    raw_response  TEXT,
    searched_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_searches_searched_at ON searches(searched_at);
  CREATE INDEX IF NOT EXISTS idx_searches_city        ON searches(city);
`);

function existingColumns(): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(searches)`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function ensureColumn(name: string, ddl: string) {
  if (!existingColumns().has(name)) {
    db.exec(`ALTER TABLE searches ADD COLUMN ${ddl}`);
  }
}

ensureColumn("lat", "lat REAL");
ensureColumn("lon", "lon REAL");
ensureColumn("country", "country TEXT");
ensureColumn("times_searched", "times_searched INTEGER NOT NULL DEFAULT 1");

// =======================
// PREPARED STATEMENTS
// =======================

const findRecentStmt = db.prepare(
  `SELECT id, times_searched
   FROM searches
   WHERE LOWER(city) = LOWER(?) AND tool = ?
     AND searched_at >= datetime('now', ?)
   ORDER BY searched_at DESC
   LIMIT 1`,
);

const updateRecentStmt = db.prepare(
  `UPDATE searches
   SET searched_at    = datetime('now'),
       times_searched = times_searched + 1,
       summary        = ?,
       raw_response   = ?,
       lat            = COALESCE(?, lat),
       lon            = COALESCE(?, lon),
       country        = COALESCE(?, country)
   WHERE id = ?`,
);

const insertStmt = db.prepare(
  `INSERT INTO searches (city, tool, summary, raw_response, lat, lon, country)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

const trimStmt = db.prepare(
  `UPDATE searches
   SET raw_response = NULL
   WHERE raw_response IS NOT NULL
     AND searched_at < datetime('now', ?)`,
);

// =======================
// LOG / DEDUPE
// =======================

export interface LogSearchInput {
  city: string;
  tool: string;
  summary: string;
  rawResponse: unknown;
  lat?: number | null;
  lon?: number | null;
  country?: string | null;
}

let insertsSinceTrim = 0;

export function logSearch({
  city,
  tool,
  summary,
  rawResponse,
  lat = null,
  lon = null,
  country = null,
}: LogSearchInput) {
  try {
    const existing = findRecentStmt.get(
      city,
      tool,
      `-${DEDUPE_WINDOW_SECONDS} seconds`,
    ) as { id: number; times_searched: number } | undefined;

    const rawJson = JSON.stringify(rawResponse);

    if (existing) {
      updateRecentStmt.run(summary, rawJson, lat, lon, country, existing.id);
    } else {
      insertStmt.run(city, tool, summary, rawJson, lat, lon, country);
    }

    insertsSinceTrim++;
    if (insertsSinceTrim >= AUTO_TRIM_EVERY_N_INSERTS) {
      trimRawResponses();
      insertsSinceTrim = 0;
    }
  } catch (err) {
    console.error(
      `[weather-mcp] Failed to log search for ${city}/${tool}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export function trimRawResponses(daysOld = RAW_RESPONSE_TTL_DAYS): number {
  try {
    const result = trimStmt.run(`-${daysOld} days`);
    return Number(result.changes);
  } catch (err) {
    console.error(
      `[weather-mcp] trimRawResponses failed:`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

// Run once at startup so a long-idle DB gets trimmed even without new inserts.
trimRawResponses();

// =======================
// READ
// =======================

export interface SearchRow {
  id: number;
  city: string;
  tool: string;
  summary: string | null;
  raw_response: string | null;
  searched_at: string;
  lat: number | null;
  lon: number | null;
  country: string | null;
  times_searched: number;
}

export interface GetHistoryOptions {
  days?: number;
  limit?: number;
  city?: string;
}

export function getHistory({ days, limit, city }: GetHistoryOptions = {}): SearchRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (days !== undefined) {
    where.push(`searched_at >= datetime('now', ?)`);
    params.push(`-${days} days`);
  }

  if (city) {
    where.push(`LOWER(city) = LOWER(?)`);
    params.push(city);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limitSql = limit !== undefined ? `LIMIT ${Math.max(1, Math.floor(limit))}` : "";

  const sql = `
    SELECT id, city, tool, summary, raw_response, searched_at,
           lat, lon, country, times_searched
    FROM searches
    ${whereSql}
    ORDER BY searched_at DESC
    ${limitSql}
  `;

  return db.prepare(sql).all(...params) as unknown as SearchRow[];
}

// =======================
// DELETE
// =======================

export interface DeleteHistoryOptions {
  days?: number;
  city?: string;
  all?: boolean;
}

export function deleteHistory({ days, city, all }: DeleteHistoryOptions): number {
  if (!all && days === undefined && !city) {
    throw new Error(
      "deleteHistory requires at least one filter (days, city, or all=true).",
    );
  }

  if (all) {
    const result = db.prepare(`DELETE FROM searches`).run();
    return Number(result.changes);
  }

  const where: string[] = [];
  const params: (string | number)[] = [];

  if (days !== undefined) {
    where.push(`searched_at < datetime('now', ?)`);
    params.push(`-${days} days`);
  }

  if (city) {
    where.push(`LOWER(city) = LOWER(?)`);
    params.push(city);
  }

  const sql = `DELETE FROM searches WHERE ${where.join(" AND ")}`;
  const result = db.prepare(sql).run(...params);
  return Number(result.changes);
}

// =======================
// STATS
// =======================

export interface SearchStats {
  total: number;
  byTool: Array<{ tool: string; count: number }>;
  topCities: Array<{ city: string; country: string | null; count: number }>;
  perDay: Array<{ date: string; count: number }>;
  firstSearchAt: string | null;
  lastSearchAt: string | null;
}

export function getStats(days = 30): SearchStats {
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM searches`).get() as { n: number }
  ).n;

  if (total === 0) {
    return {
      total: 0,
      byTool: [],
      topCities: [],
      perDay: [],
      firstSearchAt: null,
      lastSearchAt: null,
    };
  }

  const byTool = db
    .prepare(
      `SELECT tool, COUNT(*) AS count FROM searches GROUP BY tool ORDER BY count DESC`,
    )
    .all() as Array<{ tool: string; count: number }>;

  const topCities = db
    .prepare(
      `SELECT city,
              MAX(country) AS country,
              SUM(times_searched) AS count
       FROM searches
       GROUP BY LOWER(city)
       ORDER BY count DESC
       LIMIT 5`,
    )
    .all() as Array<{ city: string; country: string | null; count: number }>;

  const perDay = db
    .prepare(
      `SELECT DATE(searched_at) AS date, COUNT(*) AS count
       FROM searches
       WHERE searched_at >= datetime('now', ?)
       GROUP BY DATE(searched_at)
       ORDER BY date DESC`,
    )
    .all(`-${days} days`) as Array<{ date: string; count: number }>;

  const range = db
    .prepare(
      `SELECT MIN(searched_at) AS first, MAX(searched_at) AS last FROM searches`,
    )
    .get() as { first: string | null; last: string | null };

  return {
    total,
    byTool,
    topCities,
    perDay,
    firstSearchAt: range.first,
    lastSearchAt: range.last,
  };
}

export function getDistinctCities(): Array<{
  city: string;
  country: string | null;
  count: number;
}> {
  return db
    .prepare(
      `SELECT city,
              MAX(country) AS country,
              COUNT(*) AS count
       FROM searches
       GROUP BY LOWER(city)
       ORDER BY count DESC`,
    )
    .all() as Array<{ city: string; country: string | null; count: number }>;
}
