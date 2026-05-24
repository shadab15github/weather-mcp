import dotenv from "dotenv";
dotenv.config({ quiet: true });

import axios from "axios";
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
// CURRENT WEATHER
// =======================

server.registerTool(
  "get_current_weather",
  {
    description: "Get current weather by city",
    inputSchema: {
      city: z.string().describe("City name"),
    },
  },
  async ({ city }) => {
    const response = await axios.get(
      "https://api.openweathermap.org/data/2.5/weather",
      {
        params: {
          q: city,
          appid: API_KEY,
          units: "metric",
        },
      },
    );

    const data = response.data;

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

    return {
      content: [
        {
          type: "text",
          text:
            `Weather in ${city}\n\n` +
            `Temperature: ${data.main.temp}°C\n` +
            `Feels Like: ${data.main.feels_like}°C\n` +
            `Condition: ${data.weather[0].description}\n` +
            `Humidity: ${data.main.humidity}%\n` +
            `Wind Speed: ${data.wind.speed} m/s`,
        },
      ],
    };
  },
);

// =======================
// FORECAST
// =======================

server.registerTool(
  "get_weather_forecast",
  {
    description: "Get 5 day forecast",
    inputSchema: {
      city: z.string(),
    },
  },
  async ({ city }) => {
    const response = await axios.get(
      "https://api.openweathermap.org/data/2.5/forecast",
      {
        params: {
          q: city,
          appid: API_KEY,
          units: "metric",
        },
      },
    );

    const data = response.data.list.slice(0, 5);

    const forecast = data
      .map((item: any) => {
        return (
          `${item.dt_txt}\n` +
          `Temp: ${item.main.temp}°C\n` +
          `Condition: ${item.weather[0].description}\n`
        );
      })
      .join("\n");

    const first = data[0];
    const summary = first
      ? `First slot ${first.dt_txt}: ${first.main.temp}°C, ${first.weather[0].description}`
      : "No forecast data";

    logSearch({
      city,
      tool: "get_weather_forecast",
      summary,
      rawResponse: data,
    });

    return {
      content: [
        {
          type: "text",
          text: `Forecast for ${city}\n\n${forecast}`,
        },
      ],
    };
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
        .optional()
        .describe("Return searches from the last N days"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of rows to return"),
      city: z
        .string()
        .optional()
        .describe("Filter to a specific city (case-insensitive)"),
    },
  },
  async ({ days, limit, city }) => {
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
  },
);

// =======================
// START SERVER
// =======================

const transport = new StdioServerTransport();

await server.connect(transport);

console.error("Weather MCP Server Running...");
