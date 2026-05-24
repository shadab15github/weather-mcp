import dotenv from "dotenv";
dotenv.config({ quiet: true });

import axios, { AxiosError } from "axios";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { logSearch, getHistory } from "./db.js";

const API_KEY = process.env.OPENWEATHER_API_KEY;

if (!API_KEY) {
  throw new Error("Missing OPENWEATHER_API_KEY");
}

const server = new McpServer({
  name: "weather-mcp-server",
  version: "1.0.0",
});

// =======================
// SHARED HELPERS
// =======================

const CURRENT_TTL_MS = 10 * 60 * 1000;
const FORECAST_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function cacheSet(key: string, data: unknown, ttlMs: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

const citySchema = z
  .string()
  .trim()
  .min(1, "City must not be empty")
  .max(100, "City name too long")
  .describe("City name");

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

function describeApiError(err: unknown, city: string): string {
  if (err instanceof AxiosError && err.response) {
    const status = err.response.status;
    const apiMessage =
      (err.response.data as { message?: string } | undefined)?.message ??
      err.message;
    if (status === 404) return `City "${city}" not found by OpenWeather.`;
    if (status === 401) return `OpenWeather API key is invalid or unauthorized.`;
    if (status === 429)
      return `OpenWeather rate limit hit. Please retry in a minute.`;
    return `OpenWeather error (${status}): ${apiMessage}`;
  }
  if (err instanceof AxiosError && err.code === "ECONNABORTED") {
    return `OpenWeather request timed out. Check your network.`;
  }
  if (err instanceof Error) return `Network error: ${err.message}`;
  return `Unknown error: ${String(err)}`;
}

async function fetchWeather<T>(
  endpoint: "weather" | "forecast",
  city: string,
  ttlMs: number,
): Promise<{ data: T; cached: boolean }> {
  const key = `${endpoint}|${city.toLowerCase()}`;
  const cached = cacheGet<T>(key);
  if (cached) return { data: cached, cached: true };

  const response = await axios.get<T>(
    `https://api.openweathermap.org/data/2.5/${endpoint}`,
    {
      params: { q: city, appid: API_KEY, units: "metric" },
      timeout: 10_000,
    },
  );

  cacheSet(key, response.data, ttlMs);
  return { data: response.data, cached: false };
}

// =======================
// CURRENT WEATHER
// =======================

interface CurrentWeatherResponse {
  main: { temp: number; feels_like: number; humidity: number };
  weather: { description: string }[];
  wind: { speed: number };
}

server.registerTool(
  "get_current_weather",
  {
    description: "Get current weather by city",
    inputSchema: {
      city: citySchema,
    },
  },
  async ({ city }) => {
    try {
      const { data, cached } = await fetchWeather<CurrentWeatherResponse>(
        "weather",
        city,
        CURRENT_TTL_MS,
      );

      const summary =
        `Temp: ${data.main.temp}°C, ` +
        `Feels: ${data.main.feels_like}°C, ` +
        `${data.weather[0].description}, ` +
        `Humidity: ${data.main.humidity}%, ` +
        `Wind: ${data.wind.speed} m/s`;

      logSearch({
        city,
        tool: "get_current_weather",
        summary,
        rawResponse: data,
      });

      const cacheNote = cached ? " (cached)" : "";

      return {
        content: [
          {
            type: "text",
            text:
              `Weather in ${city}${cacheNote}\n\n` +
              `Temperature: ${data.main.temp}°C\n` +
              `Feels Like: ${data.main.feels_like}°C\n` +
              `Condition: ${data.weather[0].description}\n` +
              `Humidity: ${data.main.humidity}%\n` +
              `Wind Speed: ${data.wind.speed} m/s`,
          },
        ],
      };
    } catch (err) {
      return errorResult(describeApiError(err, city));
    }
  },
);

// =======================
// FORECAST
// =======================

interface ForecastSlot {
  dt_txt: string;
  main: { temp: number; temp_min: number; temp_max: number };
  weather: { description: string; main: string }[];
}

interface ForecastResponse {
  list: ForecastSlot[];
}

interface DailySummary {
  date: string;
  tempMin: number;
  tempMax: number;
  condition: string;
}

function aggregateByDay(list: ForecastSlot[]): DailySummary[] {
  const byDate = new Map<string, ForecastSlot[]>();
  for (const slot of list) {
    const date = slot.dt_txt.split(" ")[0];
    const bucket = byDate.get(date) ?? [];
    bucket.push(slot);
    byDate.set(date, bucket);
  }

  return Array.from(byDate.entries())
    .slice(0, 5)
    .map(([date, slots]) => {
      const tempMin = Math.min(...slots.map((s) => s.main.temp_min));
      const tempMax = Math.max(...slots.map((s) => s.main.temp_max));

      const midday = slots.reduce((best, s) => {
        const hour = parseInt(s.dt_txt.split(" ")[1].slice(0, 2), 10);
        const bestHour = parseInt(best.dt_txt.split(" ")[1].slice(0, 2), 10);
        return Math.abs(hour - 12) < Math.abs(bestHour - 12) ? s : best;
      });

      return {
        date,
        tempMin,
        tempMax,
        condition: midday.weather[0].description,
      };
    });
}

server.registerTool(
  "get_weather_forecast",
  {
    description: "Get 5 day daily forecast (min/max temp and midday condition)",
    inputSchema: {
      city: citySchema,
    },
  },
  async ({ city }) => {
    try {
      const { data, cached } = await fetchWeather<ForecastResponse>(
        "forecast",
        city,
        FORECAST_TTL_MS,
      );

      const days = aggregateByDay(data.list);

      if (days.length === 0) {
        return errorResult(`No forecast data returned for ${city}.`);
      }

      const forecast = days
        .map(
          (d) =>
            `${d.date}\n` +
            `  Min: ${d.tempMin.toFixed(1)}°C, Max: ${d.tempMax.toFixed(1)}°C\n` +
            `  Condition: ${d.condition}`,
        )
        .join("\n\n");

      const summary = days
        .map((d) => `${d.date}: ${d.tempMin.toFixed(0)}-${d.tempMax.toFixed(0)}°C ${d.condition}`)
        .join("; ");

      logSearch({
        city,
        tool: "get_weather_forecast",
        summary,
        rawResponse: days,
      });

      const cacheNote = cached ? " (cached)" : "";

      return {
        content: [
          {
            type: "text",
            text: `5-Day Forecast for ${city}${cacheNote}\n\n${forecast}`,
          },
        ],
      };
    } catch (err) {
      return errorResult(describeApiError(err, city));
    }
  },
);

// =======================
// SEARCH HISTORY
// =======================

server.registerTool(
  "get_search_history",
  {
    description:
      "Get past weather searches stored locally. " +
      "Use `days` to get all searches from the last N days (e.g. days=10 for '10 days search story'), " +
      "`limit` to cap how many rows are returned, and `city` to filter by a specific city.",
    inputSchema: {
      days: z
        .number()
        .int()
        .positive()
        .max(3650)
        .optional()
        .describe("Return searches from the last N days (max 3650)"),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Maximum number of rows to return (max 500)"),
      city: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe("Filter to a specific city (case-insensitive)"),
    },
  },
  async ({ days, limit, city }) => {
    try {
      const rows = getHistory({ days, limit, city });

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No search history found for the given filters.",
            },
          ],
        };
      }

      const header =
        `Found ${rows.length} search${rows.length === 1 ? "" : "es"}` +
        (days !== undefined ? ` in the last ${days} day${days === 1 ? "" : "s"}` : "") +
        (city ? ` for ${city}` : "") +
        ":\n";

      const body = rows
        .map(
          (r, i) =>
            `${i + 1}. [${r.searched_at}] ${r.city} (${r.tool})\n   ${r.summary ?? ""}`,
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `${header}\n${body}`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Failed to read search history: ${msg}`);
    }
  },
);

// =======================
// START SERVER
// =======================

const transport = new StdioServerTransport();

await server.connect(transport);

console.error("Weather MCP Server Running...");
