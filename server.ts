import dotenv from "dotenv";
dotenv.config({ quiet: true });

import axios from "axios";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
// START SERVER
// =======================

const transport = new StdioServerTransport();

await server.connect(transport);

console.error("Weather MCP Server Running...");
