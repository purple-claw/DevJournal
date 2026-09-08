/** ════════════════════════════════════════════
 *  DevJavu — Productivity algorithm + TimeSeriesIndex
 * ════════════════════════════════════════════ */

export interface JournalEntry {
  id: string; date: string; time: string; title: string; body: string; tags: string[]; createdAt: string; files?: string[];
}

export interface ProductivityMetrics {
  entryDensity: number; contentDepth: number; codePresence: number; consistencyScore: number; intensityIndex: number;
}

export function computeProductivityScore(entries: JournalEntry[], targetDate?: string): { score: number; metrics: ProductivityMetrics; insights: string[]; count: number; chars: number; tags: number; span: number } {
  const todayStr = new Date().toISOString().slice(0, 10);
  const filter = targetDate || todayStr;
  const dayEntries = entries.filter(e => (e.date || e.createdAt.slice(0, 10)) === filter);
  const count = dayEntries.length;
  if (count === 0) return { score: 0, metrics: { entryDensity: 0, contentDepth: 0, codePresence: 0, consistencyScore: 0, intensityIndex: 0 }, insights: ["No entries today."], count: 0, chars: 0, tags: 0, span: 0 };

  const chars = dayEntries.reduce((s, e) => s + (e.body || "").length, 0);
  const codePresence = Math.min(1, Math.round((dayEntries.filter(e => (e.body || "").includes("```")).length / Math.max(1, count)) * 100) / 100);
  const density = Math.min(1, count / 8);
  const depth = Math.min(1, chars / 2000);
  const variety = Math.min(1, new Set(dayEntries.flatMap(e => e.tags || [])).size / 4);
  const focus = Math.min(1, Math.round(count * 0.5));
  const score = Math.round((density * 0.35 + depth * 0.35 + variety * 0.15 + focus * 0.15) * 100);

  const hours = dayEntries.map(e => { const [h, m] = (e.time || "09:00").split(":").map(Number); return h + m / 60; });
  const spanH = hours.length > 1 ? Math.round((Math.max(...hours) - Math.min(...hours)) * 10) / 10 : 0;

  const insights: string[] = [];
  if (score >= 80) insights.push("Deep work sustained.");
  else if (score >= 60) insights.push("Focused output today.");
  else if (score >= 40) insights.push("Moderate progress — keep going.");
  else if (score >= 20) insights.push("Started — build momentum.");
  else insights.push("No entries — record something.");

  return { score, metrics: { entryDensity: density, contentDepth: depth, codePresence, consistencyScore: 0, intensityIndex: 0 }, insights, count, chars, tags: new Set(dayEntries.flatMap(e => e.tags)).size, span: spanH };
}

export class TimeSeriesIndex {
  private index: Map<string, Map<string, JournalEntry[]>>;
  constructor() { this.index = new Map(); }
  build(entries: JournalEntry[]) {
    this.index.clear();
    for (const entry of entries) {
      const date = entry.date || (entry.createdAt ? entry.createdAt.slice(0, 10) : new Date().toISOString().slice(0, 10));
      const hour = (entry.time || "00:00").slice(0, 2);
      if (!this.index.has(date)) this.index.set(date, new Map());
      const dateMap = this.index.get(date)!;
      if (!dateMap.has(hour)) dateMap.set(hour, []);
      dateMap.get(hour)!.push(entry);
    }
  }
  getByDate(date: string): JournalEntry[] {
    const dateMap = this.index.get(date);
    if (!dateMap) return [];
    const result: JournalEntry[] = [];
    const sortedHours = Array.from(dateMap.keys()).sort();
    for (const h of sortedHours) result.push(...(dateMap.get(h) || []));
    return result.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  }
  getAllDates(): string[] {
    return Array.from(this.index.keys()).sort().reverse();
  }
  search(query: string): JournalEntry[] {
    const q = query.toLowerCase();
    const results: JournalEntry[] = [];
    for (const [date, dateMap] of this.index) {
      for (const entries of dateMap.values()) {
        for (const entry of entries) {
          if (entry.title.toLowerCase().includes(q) || entry.body.toLowerCase().includes(q) || (entry.tags || []).some(t => t.toLowerCase().includes(q))) results.push(entry);
        }
      }
    }
    return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
}
