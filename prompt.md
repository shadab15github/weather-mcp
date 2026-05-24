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

## Notes

- The connector name your client shows depends on how you registered the MCP server. The server is named `weather-mcp-server` ([server.ts:17](server.ts#L17)); the project folder is `weather-mcp`. Use whichever name appears in your client's connector list (e.g. the key under `mcpServers` in Claude Desktop's config).
- The local DB file `search_history.db` is created next to the server on first write and is git-ignored.
- You can inspect rows directly with any SQLite browser, or:
  ```
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('search_history.db');console.log(db.prepare('SELECT id,city,tool,searched_at FROM searches ORDER BY id DESC').all())"
  ```
