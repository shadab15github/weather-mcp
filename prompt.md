# Weather MCP — Test Prompts

Prompts for testing the `weather-mcp` connector. Run section 1 first to populate the local SQLite DB, then run sections 2 and 3 to query it.

Tools exposed by the server:
- `get_current_weather` — current weather for a city
- `get_weather_forecast` — 5-day forecast for a city
- `get_search_history` — past searches stored in `search_history.db` (filters: `days`, `limit`, `city`)

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

## Notes

- The connector name your client shows depends on how you registered the MCP server. The server is named `weather-mcp-server` ([server.ts:17](server.ts#L17)); the project folder is `weather-mcp`. Use whichever name appears in your client's connector list (e.g. the key under `mcpServers` in Claude Desktop's config).
- The local DB file `search_history.db` is created next to the server on first write and is git-ignored.
- You can inspect rows directly with any SQLite browser, or:
  ```
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('search_history.db');console.log(db.prepare('SELECT id,city,tool,searched_at FROM searches ORDER BY id DESC').all())"
  ```
