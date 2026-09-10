/**
 * DevJavu - Productivity algorithm + TimeSeriesIndex runtime module.
 */

export function computeProductivityScore(entries, targetDate) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const filter = targetDate || todayStr;
  const dayEntries = entries.filter((entry) => (entry.date || entry.createdAt.slice(0, 10)) === filter);
  const count = dayEntries.length;
  if (count === 0) {
    return { score: 0, metrics: { entryDensity: 0, contentDepth: 0, codePresence: 0, consistencyScore: 0, intensityIndex: 0 }, insights: ["No entries today."], count: 0, chars: 0, tags: 0, span: 0 };
  }

  const chars = dayEntries.reduce((sum, entry) => sum + (entry.body || "").length, 0);
  const codePresence = Math.min(1, Math.round((dayEntries.filter((entry) => (entry.body || "").includes("```")) .length / Math.max(1, count)) * 100) / 100);
  const density = Math.min(1, count / 8);
  const depth = Math.min(1, chars / 2000);
  const variety = Math.min(1, new Set(dayEntries.flatMap((entry) => entry.tags || [])).size / 4);
  const focus = Math.min(1, Math.round(count * 0.5));
  const score = Math.round((density * 0.35 + depth * 0.35 + variety * 0.15 + focus * 0.15) * 100);
  const hours = dayEntries.map((entry) => { const [hour, minute] = (entry.time || "09:00").split(":").map(Number); return hour + minute / 60; });
  const span = hours.length > 1 ? Math.round((Math.max(...hours) - Math.min(...hours)) * 10) / 10 : 0;

  const insights = [];
  if (score >= 80) insights.push("Deep work sustained.");
  else if (score >= 60) insights.push("Focused output today.");
  else if (score >= 40) insights.push("Moderate progress - keep going.");
  else if (score >= 20) insights.push("Started - build momentum.");
  else insights.push("No entries - record something.");

  return { score, metrics: { entryDensity: density, contentDepth: depth, codePresence, consistencyScore: 0, intensityIndex: 0 }, insights, count, chars, tags: new Set(dayEntries.flatMap((entry) => entry.tags || [])).size, span };
}

export class TimeSeriesIndex {
  constructor() { this.index = new Map(); }
  build(entries) {
    this.index.clear();
    for (const entry of entries) {
      const date = entry.date || (entry.createdAt ? entry.createdAt.slice(0, 10) : new Date().toISOString().slice(0, 10));
      const hour = (entry.time || "00:00").slice(0, 2);
      if (!this.index.has(date)) this.index.set(date, new Map());
      const dateMap = this.index.get(date);
      if (!dateMap.has(hour)) dateMap.set(hour, []);
      dateMap.get(hour).push(entry);
    }
  }
  getByDate(date) {
    const dateMap = this.index.get(date);
    if (!dateMap) return [];
    const result = [];
    for (const hour of Array.from(dateMap.keys()).sort()) result.push(...(dateMap.get(hour) || []));
    return result.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  }
  getAllDates() { return Array.from(this.index.keys()).sort().reverse(); }
  search(query) {
    const q = query.toLowerCase();
    const results = [];
    for (const dateMap of this.index.values()) {
      for (const entries of dateMap.values()) {
        for (const entry of entries) {
          if (entry.title.toLowerCase().includes(q) || entry.body.toLowerCase().includes(q) || (entry.tags || []).some((tag) => tag.toLowerCase().includes(q))) results.push(entry);
        }
      }
    }
    return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
}
