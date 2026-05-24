# Weather MCP — Test Prompts

Prompts for testing the `weather-mcp` connector. Run section 1 first to populate the local SQLite DB, then run sections 2 and 3 to query it.

Tools exposed by the server:
- `get_current_weather` — current weather for a city (supports `units`)
- `get_weather_by_coords` — current weather for raw `lat`/`lon` (supports `units`)
- `get_weather_forecast` — 5-day forecast for a city (supports `units`)
- `get_air_quality` — current AQI + pollutants for a city
- `get_search_history` — past searches stored in `search_history.db` (filters: `days`, `limit`, `city`)
- `delete_search_history` — prune rows (`days` / `city` / `all`)
- `get_search_stats` — aggregate stats: total, top cities, by tool, per day

Resources (URI-addressable, read-only):
- `weather://history/recent` — last 50 searches as JSON
- `weather://history/cities` — distinct searched cities with counts
- `weather://history/city/{city}` — all searches for a given city

---

## 1. Populate search history

```
Using weather-mcp, what's the current weather in Mumbai?
```
```
Using weather-mcp, get current weather for Delhi.
```
```
Using weather-mcp, how's the weather in Bangalore right now?
```
```
Using weather-mcp, show me current weather in London.
```
```
Using weather-mcp, what's the weather like in New York?
```
```
Using weather-mcp, give me the 5 day forecast for Mumbai.
```
```
Using weather-mcp, show forecast for Tokyo.
```
```
Using weather-mcp, forecast for Paris please.
```

---

## 2. Query search history

```
Using weather-mcp, tell me my 10 days search story.
```
```
Using weather-mcp, show me all weather searches from the last 7 days.
```
```
Using weather-mcp, what did I search yesterday? (days = 1)
```
```
Using weather-mcp, give me my last 5 searches.
```
```
Using weather-mcp, show only my Mumbai searches.
```
```
Using weather-mcp, list all searches for Delhi in the last 30 days.
```
```
Using weather-mcp, show me the 3 most recent forecast searches for Tokyo.
```

---

## 3. Edge / sanity checks

```
Using weather-mcp, show me searches from the last 1 day, limit 2.
```
```
Using weather-mcp, get search history for the city "atlantis".
```
```
Using weather-mcp, what cities have I searched this month?
```

---

## 4. Explicit tool calls (if the client needs hand-holding)

```
Using weather-mcp, call get_search_history with days=10.
```
```
Using weather-mcp, call get_search_history with city="Mumbai", limit=5.
```
```
Using weather-mcp, call get_current_weather with city="Mumbai".
```
```
Using weather-mcp, call get_weather_forecast with city="Tokyo".
```

---

# Hardening Tests

Prompts that exercise the high-impact improvements: **input validation**, **TTL cache**, **fixed 5-day forecast aggregation**, and **graceful error handling**. Each section maps to one improvement.

## 5. Input validation (should be rejected by schema before any API call)

```
Using weather-mcp, get current weather for city "".
```
```
Using weather-mcp, get current weather for city "   ".
```
```
Using weather-mcp, get current weather for "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" (over 100 chars).
```
```
Using weather-mcp, call get_search_history with days=-1.
```
```
Using weather-mcp, call get_search_history with days=99999.
```
```
Using weather-mcp, call get_search_history with limit=10000.
```
```
Using weather-mcp, call get_search_history with limit=0.
```

## 6. Cache behavior (look for the `(cached)` tag on the second call)

```
Using weather-mcp, what's the current weather in Mumbai?
```
*(immediately after the above)*
```
Using weather-mcp, what's the current weather in Mumbai again?
```
```
Using weather-mcp, what's the weather in MUMBAI?
```
*(case-insensitive — should also hit the cache)*
```
Using weather-mcp, give me the 5 day forecast for Tokyo.
```
*(immediately after the above)*
```
Using weather-mcp, give me the 5 day forecast for Tokyo again.
```

Cache TTLs: current weather = 10 min, forecast = 30 min.

## 7. Fixed forecast (should now show 5 distinct dates with min/max + midday condition)

```
Using weather-mcp, give me the 5 day forecast for London.
```
```
Using weather-mcp, forecast for Delhi.
```
```
Using weather-mcp, what does the weather look like over the next 5 days in Paris?
```

Expected output shape (per day):

```
2026-05-24
  Min: 18.4°C, Max: 27.1°C
  Condition: clear sky
```

## 8. Graceful error handling (no stack traces, friendly messages)

```
Using weather-mcp, get current weather for "Atlantis".
```
*(expect: `City "Atlantis" not found by OpenWeather.`)*
```
Using weather-mcp, get forecast for "Zzzzzzz-not-a-city".
```
```
Using weather-mcp, current weather in "!!!@@@###".
```
```
Using weather-mcp, get current weather for "São Paulo".
```
*(should succeed — unicode is fine)*
```
Using weather-mcp, get current weather for "New York,US".
```
*(OpenWeather's `city,country` syntax — should succeed)*

To test the **invalid API key** branch (401), temporarily edit `.env`:

```
OPENWEATHER_API_KEY=invalid_key_for_testing
```

Then:

```
Using weather-mcp, get current weather in Mumbai.
```
*(expect: `OpenWeather API key is invalid or unauthorized.`)*

Restore the real key after.

## 9. Regression — history still works after hardening

```
Using weather-mcp, tell me my 10 days search story.
```
```
Using weather-mcp, give me my last 5 searches.
```
```
Using weather-mcp, show only my Mumbai searches.
```

---

# Medium-Impact Features

Prompts for the four medium-impact additions: **`units` param**, **coords-based lookup**, **air quality**, **admin tools** (delete + stats), and **MCP resources**.

## 10. `units` param (metric / imperial / standard)

```
Using weather-mcp, get current weather in Mumbai with units=imperial.
```
*(expect °F and mph)*
```
Using weather-mcp, get current weather in London with units=standard.
```
*(expect Kelvin)*
```
Using weather-mcp, give me the 5 day forecast for Tokyo with units=imperial.
```
*(daily min/max in °F)*
```
Using weather-mcp, current weather in Delhi.
```
*(no units → defaults to metric)*

## 11. Coordinate lookup (`get_weather_by_coords`)

```
Using weather-mcp, get weather by coords lat=19.0760, lon=72.8777.
```
*(Mumbai)*
```
Using weather-mcp, get weather by coords lat=40.7128, lon=-74.0060 units=imperial.
```
*(New York in °F)*
```
Using weather-mcp, get weather by coords lat=35.6762, lon=139.6503.
```
*(Tokyo)*
```
Using weather-mcp, get weather by coords lat=200, lon=0.
```
*(expect validation error — lat must be ≤ 90)*

## 12. Air quality (`get_air_quality`)

```
Using weather-mcp, what's the air quality in Delhi?
```
```
Using weather-mcp, get air quality for Beijing.
```
```
Using weather-mcp, AQI in Los Angeles please.
```
```
Using weather-mcp, get air quality for "Atlantis".
```
*(geocoder 404 → friendly message)*

AQI scale: 1=Good, 2=Fair, 3=Moderate, 4=Poor, 5=Very Poor.

## 13. Stats (`get_search_stats`)

Run after populating some history.

```
Using weather-mcp, give me my search stats.
```
```
Using weather-mcp, get_search_stats with days=7.
```
```
Using weather-mcp, what's my most-searched city?
```

## 14. Delete history (`delete_search_history`)

**Each prompt requires at least one filter** — the tool refuses an unfiltered call.

```
Using weather-mcp, delete search history for city "Tokyo".
```
```
Using weather-mcp, delete_search_history with days=30.
```
*(deletes rows OLDER than 30 days)*
```
Using weather-mcp, delete_search_history with no filters.
```
*(expect an error: "requires at least one filter")*
```
Using weather-mcp, delete_search_history with all=true.
```
*(wipes the whole table — use carefully)*

## 15. MCP resources (read via `resources/read`)

If your client supports MCP resources, point it at:

```
weather://history/recent
weather://history/cities
weather://history/city/Mumbai
weather://history/city/Delhi
```

Or ask the model:

```
Using weather-mcp, read the resource at weather://history/recent.
```
```
Using weather-mcp, what's in weather://history/cities?
```
```
Using weather-mcp, show me the resource weather://history/city/Mumbai.
```

---

# Data Quality

Prompts that exercise the DB data-quality improvements: **coords + country code stored per row**, **60-second rolling dedupe** with a `times_searched` counter, and **automatic raw_response trim** for rows older than 7 days.

## 16. Country code & coords in history

```
Using weather-mcp, get current weather in Mumbai.
```
```
Using weather-mcp, get current weather in "London,GB".
```
```
Using weather-mcp, get weather by coords lat=35.6762, lon=139.6503.
```
*(Tokyo — country resolved from API)*
```
Using weather-mcp, tell me my recent searches.
```

Expected: each row now shows the country tag, e.g.

```
1. [2026-05-24 07:30:12] Mumbai (IN) (get_current_weather)
   Temp: 30.5°C, scattered clouds, Humidity: 70%, Wind: 3.5 m/s
```

## 17. Springfield ambiguity (two cities with the same name, different country)

```
Using weather-mcp, get current weather in "Springfield,US".
```
```
Using weather-mcp, get current weather in "Springfield,AU".
```
```
Using weather-mcp, show only my Springfield searches.
```

Both rows appear with their distinct country tags (US vs AU) — no more silent collision.

## 18. Rolling 60-second dedupe (`×N` counter)

Spam the same city/tool a few times within ~10 seconds:

```
Using weather-mcp, get current weather in Mumbai.
```
```
Using weather-mcp, get current weather in Mumbai.
```
```
Using weather-mcp, what's the weather in MUMBAI?
```
*(case-insensitive — still dedupes)*
```
Using weather-mcp, show me my Mumbai searches.
```

Expected: **one** row with `[×3]` next to the city, summary reflects the most recent call. Same-city searches more than 60 s apart create a fresh row.

```
Using weather-mcp, give me my search stats.
```

Top-cities count uses `SUM(times_searched)`, so the `[×3]` row counts as 3 intents.

## 19. Different tool / different city should NOT dedupe

```
Using weather-mcp, get current weather in Mumbai.
```
```
Using weather-mcp, give me the 5 day forecast for Mumbai.
```
```
Using weather-mcp, get air quality for Mumbai.
```
```
Using weather-mcp, show only my Mumbai searches.
```

Expected: 3 distinct rows (one per tool), each with its own `times_searched` counter.

## 20. raw_response trim (manual verification)

The server auto-trims `raw_response` for rows older than 7 days on startup and after every 100 inserts. To verify manually after some history exists:

```
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('search_history.db');console.log(db.prepare('SELECT id, city, searched_at, length(raw_response) AS raw_len FROM searches ORDER BY searched_at DESC LIMIT 20').all())"
```

Rows older than 7 days will show `raw_len: null` (raw_response was trimmed). Recent rows still carry their JSON.

To force a trim cycle (e.g. for testing), backdate a row and restart the server:

```
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('search_history.db');db.exec(\"UPDATE searches SET searched_at='2020-01-01 00:00:00' WHERE id=1\")"
```

Then run `npm start` — startup trim will null its `raw_response`.

---

# Polish

Polish-level improvements: **silenced SQLite ExperimentalWarning**, **startup API-key probe**, **HTTP transport option**, and **vitest test suite**.

## 21. Silenced ExperimentalWarning

Just start the server normally; the `(node:NNNN) ExperimentalWarning: SQLite is an experimental feature` line that used to spam every launch is now suppressed (everything else still prints).

```
npm start
```

Expected stderr (no warning):

```
[weather-mcp] OpenWeather API key verified.
Weather MCP Server running on stdio.
```

## 22. API-key startup probe

`server.ts` makes a one-shot `GET /weather?q=London` to OpenWeather before accepting requests. Three outcomes:

```
npm start
```

- Valid key → `[weather-mcp] OpenWeather API key verified.`
- Invalid key → `[weather-mcp] WARNING: OPENWEATHER_API_KEY is invalid (401). The server will start but every weather call will fail until you fix it.`
- Network down → `[weather-mcp] WARNING: Could not verify API key: <reason>`

The server starts in all three cases — the probe is informational, not blocking.

## 23. HTTP transport option

Default transport is stdio (no change). Opt-in to HTTP with two env vars:

```
$env:MCP_TRANSPORT='http'
$env:MCP_HTTP_PORT='3737'    # optional; default 3000
npm start
```

Expected:

```
[weather-mcp] OpenWeather API key verified.
Weather MCP Server running on http://localhost:3737/mcp
```

Health check:

```
curl http://localhost:3737/health
# {"status":"ok","transport":"http"}
```

MCP endpoints:

- `POST /mcp` — initialize + tool calls (with `Mcp-Session-Id` header after the first response)
- `GET /mcp`  — SSE notification stream
- `DELETE /mcp` — close session

Useful for connecting multiple clients to a single running server, or exposing it to a non-local client.

## 24. Test suite

```
npm test          # one-shot
npm run test:watch  # watch mode
```

Covers:
- `forecast.ts` — `aggregateByDay` (5 cases, including empty + single-day)
- `errors.ts` — `describeApiError` (404 / 401 / 429 / generic / timeout / non-Error), unit helpers, AQI labels, error envelope
- `db.ts` — `logSearch` / `getHistory` basics, 60-second rolling dedupe (collapse + tool/city non-collision + COALESCE), `deleteHistory` (unfiltered refusal + by-city + all), `trimRawResponses` (only ages out old rows), `getStats` + `getDistinctCities`

Tests use a temp SQLite file via `WEATHER_MCP_DB_PATH` so they never touch the real `search_history.db`.

---

## Notes

- The connector name your client shows depends on how you registered the MCP server. The server is named `weather-mcp-server` (see `server.ts`); the project folder is `weather-mcp`. Use whichever name appears in your client's connector list (e.g. the key under `mcpServers` in Claude Desktop's config).
- The local DB file `search_history.db` is created next to the server on first write and is git-ignored.
- Run the server with:
  - `npm start` — one-shot via `tsx` (stdio transport, default)
  - `npm run dev` — auto-restart on file changes (`tsx watch`)
  - `npm run start:http` — HTTP transport on `MCP_HTTP_PORT` (default 3000)
  - `npm run typecheck` — `tsc --noEmit`
  - `npm test` / `npm run test:watch` — vitest suite
- You can inspect rows directly with any SQLite browser, or:
  ```
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('search_history.db');console.log(db.prepare('SELECT id,city,tool,searched_at FROM searches ORDER BY id DESC').all())"
  ```
