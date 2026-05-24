# Weather MCP — Test Prompts

One prompt per tool / resource. Run them in order — section 1 populates the DB before the history tools have anything to read.

## Tools

### `get_current_weather`
```
Using weather-mcp, what's the current weather in Mumbai?
```

### `get_weather_by_coords`
```
Using weather-mcp, get weather by coords lat=19.0760, lon=72.8777.
```

### `get_weather_forecast`
```
Using weather-mcp, give me the 5 day forecast for Tokyo.
```

### `get_air_quality`
```
Using weather-mcp, what's the air quality in Delhi?
```

### `get_search_history`
```
Using weather-mcp, give me my last 5 searches.
```

### `get_search_stats`
```
Using weather-mcp, give me my search stats.
```

### `delete_search_history`
```
Using weather-mcp, delete search history for city "Tokyo".
```
*(Tool refuses unfiltered calls — always pass `city`, `days`, or `all=true`.)*

## Resources

### `weather://history/recent`
```
Using weather-mcp, read the resource at weather://history/recent.
```

### `weather://history/cities`
```
Using weather-mcp, what's in weather://history/cities?
```

### `weather://history/city/{city}`
```
Using weather-mcp, show me the resource weather://history/city/Mumbai.
```

---

## Optional flags

- **Units** — append `units=imperial` (°F/mph) or `units=standard` (Kelvin); default is metric.
- **City + country disambiguation** — use `"City,CC"` form, e.g. `"Springfield,US"` vs `"Springfield,AU"`.
- **Cache** — repeating a current-weather call within 10 min (forecast: 30 min) returns a `(cached)` result.
- **Dedupe** — same city + tool within 60 s collapses into one row with a `[×N]` counter.

## Running the server

```
npm start             # stdio transport (default)
npm run start:http    # HTTP transport on MCP_HTTP_PORT (default 3000)
npm test              # vitest suite
```

Inspect the DB directly:
```
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('search_history.db');console.log(db.prepare('SELECT id,city,tool,searched_at FROM searches ORDER BY id DESC').all())"
```
