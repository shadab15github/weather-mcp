export interface ForecastSlot {
  dt_txt: string;
  main: { temp: number; temp_min: number; temp_max: number };
  weather: { description: string; main: string }[];
}

export interface DailySummary {
  date: string;
  tempMin: number;
  tempMax: number;
  condition: string;
}

/**
 * Group OpenWeather's 40 three-hourly forecast slots by date, returning up to
 * 5 daily summaries with min/max temp and the midday condition as the
 * representative one for that day.
 */
export function aggregateByDay(list: ForecastSlot[]): DailySummary[] {
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
