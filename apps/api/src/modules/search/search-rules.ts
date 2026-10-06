import { rankScore } from "../reviews/review-rules.js";

/**
 * Search rules, kept pure so they are easy to test. Searching works on a bounded set of
 * candidate doctors (see `CANDIDATE_LIMIT` in the service), so these run in memory.
 */

export const SORTS = [
  "recommended",
  "soonest",
  "rating",
  "fee_asc",
  "fee_desc",
  "experience",
] as const;
export type SearchSort = (typeof SORTS)[number];

const MAX_TOKENS = 6;
const MAX_TOKEN_LENGTH = 40;

/** "Cardiologist  Delhi" becomes ["cardiologist", "delhi"]: every word must match somewhere. */
export function searchTokens(q: string | undefined): string[] {
  if (!q) return [];
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, MAX_TOKEN_LENGTH));
}

export interface Facet {
  value: string;
  count: number;
}

/** Counts of the values people can filter by, commonest first, ignoring case and empty values. */
export function facetCounts(values: ReadonlyArray<string | null | undefined>, limit = 20): Facet[] {
  const seen = new Map<string, Facet>();
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const entry = seen.get(key);
    if (entry) entry.count++;
    else seen.set(key, { value, count: 1 });
  }
  return [...seen.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

export interface Rankable {
  name: string;
  fee: number;
  experienceYears: number | null;
  rating: { average: number | null; count: number };
  /** First bookable seat, or null when there is none in the booking window. */
  next: Date | null;
}

const byName = (a: Rankable, b: Rankable) => a.name.localeCompare(b.name);
/** Earliest first; a doctor with no free seat goes last. */
const bySoonest = (a: Rankable, b: Rankable) =>
  (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity) || 0;
const score = (d: Rankable) => rankScore(d.rating.average, d.rating.count);

/** The order of results. Ties always fall back to a stable order: soonest seat, then name. */
export function comparator(sort: SearchSort): (a: Rankable, b: Rankable) => number {
  const primary: (a: Rankable, b: Rankable) => number = {
    recommended: (a: Rankable, b: Rankable) => score(b) - score(a),
    soonest: bySoonest,
    rating: (a: Rankable, b: Rankable) => score(b) - score(a),
    fee_asc: (a: Rankable, b: Rankable) => a.fee - b.fee,
    fee_desc: (a: Rankable, b: Rankable) => b.fee - a.fee,
    experience: (a: Rankable, b: Rankable) => (b.experienceYears ?? -1) - (a.experienceYears ?? -1),
  }[sort];
  return (a, b) => primary(a, b) || bySoonest(a, b) || byName(a, b);
}
