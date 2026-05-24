import { describe, it, expect } from "vitest";
import { aggregateByDay, type ForecastSlot } from "../forecast.js";

function makeSlots(): ForecastSlot[] {
  // 40 three-hourly slots starting 2026-05-24 00:00 UTC — mimics OpenWeather's `/forecast` shape.
  const slots: ForecastSlot[] = [];
  const start = new Date("2026-05-24T00:00:00Z").getTime();
  for (let i = 0; i < 40; i++) {
    const d = new Date(start + i * 3 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const dt_txt =
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:00:00`;
    const base = 20 + (i % 8);
    slots.push({
      dt_txt,
      main: { temp: base, temp_min: base - 2, temp_max: base + 3 },
      weather: [
        {
          description: i % 8 === 4 ? "sunny" : "cloudy",
          main: "Clouds",
        },
      ],
    });
  }
  return slots;
}

describe("aggregateByDay", () => {
  it("collapses 40 three-hourly slots into 5 daily summaries", () => {
    const days = aggregateByDay(makeSlots());
    expect(days).toHaveLength(5);
  });

  it("picks the noon slot as the day's representative condition", () => {
    const days = aggregateByDay(makeSlots());
    expect(days.every((d) => d.condition === "sunny")).toBe(true);
  });

  it("computes per-day min/max across that day's slots", () => {
    const days = aggregateByDay(makeSlots());
    for (const d of days) {
      expect(d.tempMax).toBeGreaterThan(d.tempMin);
      expect(d.tempMax).toBe(30);
      expect(d.tempMin).toBe(18);
    }
  });

  it("returns an empty array for an empty list", () => {
    expect(aggregateByDay([])).toEqual([]);
  });

  it("returns fewer than 5 days when fewer days are present", () => {
    const oneDay = makeSlots().slice(0, 4); // 12 hours on a single date
    const days = aggregateByDay(oneDay);
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe("2026-05-24");
  });
});
