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
