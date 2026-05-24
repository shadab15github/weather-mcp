import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "search_history.db");

const db = new DatabaseSync(DB_PATH);

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

const insertStmt = db.prepare(
  `INSERT INTO searches (city, tool, summary, raw_response)
   VALUES (?, ?, ?, ?)`,
);

export interface LogSearchInput {
  city: string;
  tool: string;
  summary: string;
  rawResponse: unknown;
}

export function logSearch({ city, tool, summary, rawResponse }: LogSearchInput) {
  try {
    insertStmt.run(city, tool, summary, JSON.stringify(rawResponse));
  } catch (err) {
    console.error(
      `[weather-mcp] Failed to log search for ${city}/${tool}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export interface SearchRow {
  id: number;
  city: string;
  tool: string;
  summary: string | null;
  raw_response: string | null;
  searched_at: string;
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
    SELECT id, city, tool, summary, raw_response, searched_at
    FROM searches
    ${whereSql}
    ORDER BY searched_at DESC
    ${limitSql}
  `;

  return db.prepare(sql).all(...params) as unknown as SearchRow[];
}

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

export interface SearchStats {
  total: number;
  byTool: Array<{ tool: string; count: number }>;
  topCities: Array<{ city: string; count: number }>;
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
      `SELECT city, COUNT(*) AS count FROM searches GROUP BY city ORDER BY count DESC LIMIT 5`,
    )
    .all() as Array<{ city: string; count: number }>;

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

export function getDistinctCities(): Array<{ city: string; count: number }> {
  return db
    .prepare(
      `SELECT city, COUNT(*) AS count FROM searches GROUP BY city ORDER BY count DESC`,
    )
    .all() as Array<{ city: string; count: number }>;
}
