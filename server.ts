import dotenv from "dotenv";
dotenv.config({ quiet: true });

import axios, { AxiosError } from "axios";
import { z } from "zod";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  logSearch,
  getHistory,
  deleteHistory,
  getStats,
  getDistinctCities,
} from "./db.js";

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
const AQI_TTL_MS = 30 * 60 * 1000;
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;

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
  .describe("City name (optionally `city,country` e.g. `London,GB`)");

const unitsSchema = z
  .enum(["metric", "imperial", "standard"])
  .default("metric")
  .describe("metric=°C/m·s⁻¹, imperial=°F/mph, standard=K/m·s⁻¹");

type Units = z.infer<typeof unitsSchema>;

function tempUnit(units: Units): string {
  return units === "metric" ? "°C" : units === "imperial" ? "°F" : "K";
}

function windUnit(units: Units): string {
  return units === "imperial" ? "mph" : "m/s";
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

function describeApiError(err: unknown, label: string): string {
  if (err instanceof AxiosError && err.response) {
    const status = err.response.status;
    const apiMessage =
      (err.response.data as { message?: string } | undefined)?.message ??
      err.message;
    if (status === 404) return `${label} not found by OpenWeather.`;
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

async function fetchByCity<T>(
  endpoint: "weather" | "forecast",
  city: string,
  units: Units,
  ttlMs: number,
): Promise<{ data: T; cached: boolean }> {
  const key = `${endpoint}|${city.toLowerCase()}|${units}`;
  const cached = cacheGet<T>(key);
  if (cached) return { data: cached, cached: true };

  const response = await axios.get<T>(
    `https://api.openweathermap.org/data/2.5/${endpoint}`,
    {
      params: { q: city, appid: API_KEY, units },
      timeout: 10_000,
    },
  );

  cacheSet(key, response.data, ttlMs);
  return { data: response.data, cached: false };
}

async function fetchByCoords<T>(
  endpoint: "weather" | "air_pollution",
  lat: number,
  lon: number,
  units: Units | null,
  ttlMs: number,
): Promise<{ data: T; cached: boolean }> {
  const key = `${endpoint}|${lat.toFixed(4)},${lon.toFixed(4)}|${units ?? "_"}`;
  const cached = cacheGet<T>(key);
  if (cached) return { data: cached, cached: true };

  const params: Record<string, string | number> = {
    lat,
    lon,
    appid: API_KEY!,
  };
  if (units) params.units = units;

  const response = await axios.get<T>(
    `https://api.openweathermap.org/data/2.5/${endpoint}`,
    { params, timeout: 10_000 },
  );

  cacheSet(key, response.data, ttlMs);
  return { data: response.data, cached: false };
}

interface GeocodeHit {
  name: string;
  lat: number;
  lon: number;
  country: string;
  state?: string;
}

async function geocodeCity(city: string): Promise<GeocodeHit> {
  const key = `geocode|${city.toLowerCase()}`;
  const cached = cacheGet<GeocodeHit>(key);
  if (cached) return cached;

  const response = await axios.get<GeocodeHit[]>(
    `https://api.openweathermap.org/geo/1.0/direct`,
    {
      params: { q: city, limit: 1, appid: API_KEY },
      timeout: 10_000,
    },
  );

  if (!response.data || response.data.length === 0) {
    throw new AxiosError(
      `City "${city}" not found`,
      "GEOCODE_NOT_FOUND",
      undefined,
      undefined,
      { status: 404, statusText: "Not Found", data: { message: "city not found" }, headers: {}, config: {} as never },
    );
  }

  const hit = response.data[0];
  cacheSet(key, hit, GEOCODE_TTL_MS);
  return hit;
}

// =======================
// CURRENT WEATHER (BY CITY)
// =======================

interface CurrentWeatherResponse {
  main: { temp: number; feels_like: number; humidity: number };
  weather: { description: string }[];
  wind: { speed: number };
  coord?: { lat: number; lon: number };
  sys?: { country?: string };
  name?: string;
}

function renderCurrent(
  data: CurrentWeatherResponse,
  label: string,
  units: Units,
  cached: boolean,
): string {
  const t = tempUnit(units);
  const w = windUnit(units);
  const cacheNote = cached ? " (cached)" : "";
  return (
    `Weather in ${label}${cacheNote}\n\n` +
    `Temperature: ${data.main.temp}${t}\n` +
    `Feels Like: ${data.main.feels_like}${t}\n` +
    `Condition: ${data.weather[0].description}\n` +
    `Humidity: ${data.main.humidity}%\n` +
    `Wind Speed: ${data.wind.speed} ${w}`
  );
}

server.registerTool(
  "get_current_weather",
  {
    description: "Get current weather by city",
    inputSchema: {
      city: citySchema,
      units: unitsSchema.optional(),
    },
  },
  async ({ city, units }) => {
    const u: Units = units ?? "metric";
    try {
      const { data, cached } = await fetchByCity<CurrentWeatherResponse>(
        "weather",
        city,
        u,
        CURRENT_TTL_MS,
      );

      const summary =
        `Temp: ${data.main.temp}${tempUnit(u)}, ` +
        `${data.weather[0].description}, ` +
        `Humidity: ${data.main.humidity}%, ` +
        `Wind: ${data.wind.speed} ${windUnit(u)}`;

      logSearch({
        city,
        tool: "get_current_weather",
        summary,
        rawResponse: data,
        lat: data.coord?.lat ?? null,
        lon: data.coord?.lon ?? null,
        country: data.sys?.country ?? null,
      });

      return {
        content: [{ type: "text", text: renderCurrent(data, city, u, cached) }],
      };
    } catch (err) {
      return errorResult(describeApiError(err, `City "${city}"`));
    }
  },
);

// =======================
// CURRENT WEATHER (BY COORDS)
// =======================

server.registerTool(
  "get_weather_by_coords",
  {
    description:
      "Get current weather by geographic coordinates. Avoids ambiguous city names.",
    inputSchema: {
      lat: z.number().min(-90).max(90).describe("Latitude (-90 to 90)"),
      lon: z.number().min(-180).max(180).describe("Longitude (-180 to 180)"),
      units: unitsSchema.optional(),
    },
  },
  async ({ lat, lon, units }) => {
    const u: Units = units ?? "metric";
    try {
      const { data, cached } = await fetchByCoords<CurrentWeatherResponse>(
        "weather",
        lat,
        lon,
        u,
        CURRENT_TTL_MS,
      );

      const label = data.name
        ? `${data.name}${data.sys?.country ? `, ${data.sys.country}` : ""} (${lat}, ${lon})`
        : `(${lat}, ${lon})`;

      const summary =
        `Temp: ${data.main.temp}${tempUnit(u)}, ` +
        `${data.weather[0].description}, ` +
        `Humidity: ${data.main.humidity}%`;

      logSearch({
        city: data.name ?? `${lat},${lon}`,
        tool: "get_weather_by_coords",
        summary,
        rawResponse: data,
        lat,
        lon,
        country: data.sys?.country ?? null,
      });

      return {
        content: [{ type: "text", text: renderCurrent(data, label, u, cached) }],
      };
    } catch (err) {
      return errorResult(describeApiError(err, `Coordinates (${lat}, ${lon})`));
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
  city?: {
    name?: string;
    country?: string;
    coord?: { lat: number; lon: number };
  };
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
      units: unitsSchema.optional(),
    },
  },
  async ({ city, units }) => {
    const u: Units = units ?? "metric";
    try {
      const { data, cached } = await fetchByCity<ForecastResponse>(
        "forecast",
        city,
        u,
        FORECAST_TTL_MS,
      );

      const days = aggregateByDay(data.list);
      if (days.length === 0) {
        return errorResult(`No forecast data returned for ${city}.`);
      }

      const t = tempUnit(u);
      const forecast = days
        .map(
          (d) =>
            `${d.date}\n` +
            `  Min: ${d.tempMin.toFixed(1)}${t}, Max: ${d.tempMax.toFixed(1)}${t}\n` +
            `  Condition: ${d.condition}`,
        )
        .join("\n\n");

      const summary = days
        .map(
          (d) =>
            `${d.date}: ${d.tempMin.toFixed(0)}-${d.tempMax.toFixed(0)}${t} ${d.condition}`,
        )
        .join("; ");

      logSearch({
        city,
        tool: "get_weather_forecast",
        summary,
        rawResponse: days,
        lat: data.city?.coord?.lat ?? null,
        lon: data.city?.coord?.lon ?? null,
        country: data.city?.country ?? null,
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
      return errorResult(describeApiError(err, `City "${city}"`));
    }
  },
);

// =======================
// AIR QUALITY
// =======================

interface AirPollutionResponse {
  list: Array<{
    main: { aqi: 1 | 2 | 3 | 4 | 5 };
    components: {
      co: number;
      no: number;
      no2: number;
      o3: number;
      so2: number;
      pm2_5: number;
      pm10: number;
      nh3: number;
    };
  }>;
}

const AQI_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "Good",
  2: "Fair",
  3: "Moderate",
  4: "Poor",
  5: "Very Poor",
};

server.registerTool(
  "get_air_quality",
  {
    description:
      "Get current air quality index (AQI) and pollutant concentrations for a city. " +
      "AQI scale: 1=Good, 2=Fair, 3=Moderate, 4=Poor, 5=Very Poor.",
    inputSchema: {
      city: citySchema,
    },
  },
  async ({ city }) => {
    try {
      const hit = await geocodeCity(city);
      const { data, cached } = await fetchByCoords<AirPollutionResponse>(
        "air_pollution",
        hit.lat,
        hit.lon,
        null,
        AQI_TTL_MS,
      );

      if (!data.list || data.list.length === 0) {
        return errorResult(`No air quality data returned for ${city}.`);
      }

      const reading = data.list[0];
      const aqi = reading.main.aqi;
      const label = AQI_LABELS[aqi];
      const c = reading.components;

      const summary = `AQI ${aqi} (${label}), PM2.5 ${c.pm2_5} μg/m³, PM10 ${c.pm10} μg/m³`;

      logSearch({
        city,
        tool: "get_air_quality",
        summary,
        rawResponse: { hit, reading },
        lat: hit.lat,
        lon: hit.lon,
        country: hit.country,
      });

      const cacheNote = cached ? " (cached)" : "";
      const body =
        `Air Quality in ${hit.name}, ${hit.country}${cacheNote}\n\n` +
        `AQI: ${aqi} (${label})\n\n` +
        `Pollutants (μg/m³):\n` +
        `  PM2.5: ${c.pm2_5}\n` +
        `  PM10:  ${c.pm10}\n` +
        `  O3:    ${c.o3}\n` +
        `  NO2:   ${c.no2}\n` +
        `  SO2:   ${c.so2}\n` +
        `  CO:    ${c.co}`;

      return { content: [{ type: "text", text: body }] };
    } catch (err) {
      return errorResult(describeApiError(err, `City "${city}"`));
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
            { type: "text", text: "No search history found for the given filters." },
          ],
        };
      }

      const header =
        `Found ${rows.length} search${rows.length === 1 ? "" : "es"}` +
        (days !== undefined ? ` in the last ${days} day${days === 1 ? "" : "s"}` : "") +
        (city ? ` for ${city}` : "") +
        ":\n";

      const body = rows
        .map((r, i) => {
          const countryTag = r.country ? ` (${r.country})` : "";
          const timesTag =
            r.times_searched > 1 ? ` [×${r.times_searched}]` : "";
          return (
            `${i + 1}. [${r.searched_at}] ${r.city}${countryTag}${timesTag} (${r.tool})\n` +
            `   ${r.summary ?? ""}`
          );
        })
        .join("\n");

      return { content: [{ type: "text", text: `${header}\n${body}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Failed to read search history: ${msg}`);
    }
  },
);

// =======================
// DELETE SEARCH HISTORY
// =======================

server.registerTool(
  "delete_search_history",
  {
    description:
      "Delete rows from the local search history. " +
      "Provide at least one filter: `days` deletes rows OLDER than N days, " +
      "`city` deletes rows for that city, or `all=true` wipes the whole table.",
    inputSchema: {
      days: z
        .number()
        .int()
        .positive()
        .max(3650)
        .optional()
        .describe("Delete searches OLDER than N days"),
      city: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe("Delete all searches for this city"),
      all: z
        .boolean()
        .optional()
        .describe("Set to true to wipe the entire history (use with care)"),
    },
  },
  async ({ days, city, all }) => {
    try {
      const deleted = deleteHistory({ days, city, all });
      const filterDesc: string[] = [];
      if (all) filterDesc.push("all rows");
      if (days !== undefined) filterDesc.push(`older than ${days} day${days === 1 ? "" : "s"}`);
      if (city) filterDesc.push(`for city "${city}"`);

      return {
        content: [
          {
            type: "text",
            text: `Deleted ${deleted} row${deleted === 1 ? "" : "s"} (${filterDesc.join(", ")}).`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(msg);
    }
  },
);

// =======================
// SEARCH STATS
// =======================

server.registerTool(
  "get_search_stats",
  {
    description:
      "Get aggregate statistics about your search history: total count, top cities, " +
      "breakdown by tool, and searches per day for the last N days.",
    inputSchema: {
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .optional()
        .describe("Range for the per-day breakdown (default 30)"),
    },
  },
  async ({ days }) => {
    try {
      const stats = getStats(days ?? 30);

      if (stats.total === 0) {
        return {
          content: [{ type: "text", text: "No searches recorded yet." }],
        };
      }

      const topCitiesText = stats.topCities
        .map((c, i) => {
          const countryTag = c.country ? ` (${c.country})` : "";
          return `  ${i + 1}. ${c.city}${countryTag} — ${c.count}`;
        })
        .join("\n");

      const byToolText = stats.byTool
        .map((t) => `  ${t.tool}: ${t.count}`)
        .join("\n");

      const perDayText = stats.perDay.length
        ? stats.perDay.map((d) => `  ${d.date}: ${d.count}`).join("\n")
        : "  (none in window)";

      const body =
        `Search Statistics\n\n` +
        `Total searches: ${stats.total}\n` +
        `First: ${stats.firstSearchAt}\n` +
        `Last:  ${stats.lastSearchAt}\n\n` +
        `Top cities:\n${topCitiesText}\n\n` +
        `By tool:\n${byToolText}\n\n` +
        `Per day (last ${days ?? 30}):\n${perDayText}`;

      return { content: [{ type: "text", text: body }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Failed to compute stats: ${msg}`);
    }
  },
);

// =======================
// RESOURCES
// =======================

server.registerResource(
  "recent-history",
  "weather://history/recent",
  {
    title: "Recent searches",
    description: "Most recent 50 weather searches as JSON",
    mimeType: "application/json",
  },
  async (uri) => {
    const rows = getHistory({ limit: 50 });
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(rows, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "cities",
  "weather://history/cities",
  {
    title: "Searched cities",
    description: "Distinct cities in history with search counts",
    mimeType: "application/json",
  },
  async (uri) => {
    const cities = getDistinctCities();
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(cities, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "history-by-city",
  new ResourceTemplate("weather://history/city/{city}", {
    list: async () => {
      const cities = getDistinctCities();
      return {
        resources: cities.map((c) => ({
          uri: `weather://history/city/${encodeURIComponent(c.city)}`,
          name: `${c.city} (${c.count})`,
          mimeType: "application/json",
        })),
      };
    },
  }),
  {
    title: "History for a specific city",
    description: "All searches for the given city as JSON",
    mimeType: "application/json",
  },
  async (uri, { city }) => {
    const cityValue = Array.isArray(city) ? city[0] : city;
    const rows = getHistory({ city: decodeURIComponent(cityValue) });
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(rows, null, 2),
        },
      ],
    };
  },
);

// =======================
// START SERVER
// =======================

const transport = new StdioServerTransport();

await server.connect(transport);

console.error("Weather MCP Server Running...");
