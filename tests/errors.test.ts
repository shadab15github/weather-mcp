import { describe, it, expect } from "vitest";
import { AxiosError } from "axios";
import {
  describeApiError,
  tempUnit,
  windUnit,
  AQI_LABELS,
  errorResult,
} from "../errors.js";

function makeAxiosError(status: number, message = "boom"): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
    undefined,
    undefined,
    {
      status,
      statusText: "Error",
      data: { message },
      headers: {},
      config: {} as never,
    },
  );
}

describe("describeApiError", () => {
  it("maps 404 to a city-not-found message", () => {
    expect(describeApiError(makeAxiosError(404), `City "Atlantis"`)).toContain(
      `City "Atlantis" not found`,
    );
  });

  it("maps 401 to an invalid-key message", () => {
    expect(describeApiError(makeAxiosError(401), `City "X"`)).toMatch(
      /invalid|unauthorized/i,
    );
  });

  it("maps 429 to a rate-limit message", () => {
    expect(describeApiError(makeAxiosError(429), `City "X"`)).toMatch(
      /rate limit/i,
    );
  });

  it("includes the upstream message for unhandled statuses", () => {
    expect(
      describeApiError(makeAxiosError(503, "service down"), `City "X"`),
    ).toContain("service down");
  });

  it("recognizes timeout errors (ECONNABORTED)", () => {
    const err = new AxiosError("timeout", "ECONNABORTED");
    expect(describeApiError(err, `City "X"`)).toMatch(/timed out/i);
  });

  it("falls back to a network-error message for generic Errors", () => {
    expect(
      describeApiError(new Error("DNS lookup failed"), `City "X"`),
    ).toContain("DNS lookup failed");
  });

  it("handles non-Error throwables", () => {
    expect(describeApiError("string thrown", `City "X"`)).toContain(
      "string thrown",
    );
  });
});

describe("unit helpers", () => {
  it("tempUnit maps each value", () => {
    expect(tempUnit("metric")).toBe("°C");
    expect(tempUnit("imperial")).toBe("°F");
    expect(tempUnit("standard")).toBe("K");
  });

  it("windUnit uses mph only for imperial", () => {
    expect(windUnit("metric")).toBe("m/s");
    expect(windUnit("standard")).toBe("m/s");
    expect(windUnit("imperial")).toBe("mph");
  });
});

describe("AQI_LABELS", () => {
  it("covers all 5 AQI levels", () => {
    expect(AQI_LABELS[1]).toBe("Good");
    expect(AQI_LABELS[2]).toBe("Fair");
    expect(AQI_LABELS[3]).toBe("Moderate");
    expect(AQI_LABELS[4]).toBe("Poor");
    expect(AQI_LABELS[5]).toBe("Very Poor");
  });
});

describe("errorResult", () => {
  it("wraps text in the MCP error envelope", () => {
    const res = errorResult("bad");
    expect(res.isError).toBe(true);
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toBe("bad");
  });
});
