import { AxiosError } from "axios";

export type Units = "metric" | "imperial" | "standard";

export function tempUnit(units: Units): string {
  return units === "metric" ? "°C" : units === "imperial" ? "°F" : "K";
}

export function windUnit(units: Units): string {
  return units === "imperial" ? "mph" : "m/s";
}

export const AQI_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "Good",
  2: "Fair",
  3: "Moderate",
  4: "Poor",
  5: "Very Poor",
};

/**
 * Convert axios/network errors into a user-readable string. `label` is the
 * subject of the failed lookup (e.g. `City "Mumbai"` or `Coordinates (19, 72)`).
 */
export function describeApiError(err: unknown, label: string): string {
  if (err instanceof AxiosError && err.response) {
    const status = err.response.status;
    const apiMessage =
      (err.response.data as { message?: string } | undefined)?.message ??
      err.message;
    if (status === 404) return `${label} not found by OpenWeather.`;
    if (status === 401)
      return `OpenWeather API key is invalid or unauthorized.`;
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

export function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}
