/**
 * Pure rules for reviews, kept free of I/O so they are easy to test.
 * A review is a patient's rating of one completed, online-booked visit.
 */

const DAY = 86_400_000;

/** A patient can review a visit from the moment they were seen until the window closes. */
export function reviewWindowOpen(completedAt: Date | null, now: Date, windowDays: number): boolean {
  if (!completedAt) return false;
  return now.getTime() - completedAt.getTime() <= windowDays * DAY;
}

/** The patient can change their own review for a short while after writing it. */
export function reviewEditable(createdAt: Date, now: Date, editDays: number): boolean {
  return now.getTime() - createdAt.getTime() <= editDays * DAY;
}

/**
 * How a reviewer is shown to the public: first name and the initial of the last name
 * ("Sunita D."). Never a full name, phone number or anything that identifies the visit.
 */
export function reviewerLabel(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "A patient";
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last ? first + " " + Array.from(last)[0]!.toUpperCase() + "." : first;
}

export interface RatingSummary {
  /** Average of published reviews to one decimal; null when there are none. */
  average: number | null;
  count: number;
}

export function summarise(ratings: number[]): RatingSummary {
  if (ratings.length === 0) return { average: null, count: 0 };
  const sum = ratings.reduce((t, r) => t + r, 0);
  return { average: Math.round((sum / ratings.length) * 10) / 10, count: ratings.length };
}

/** How many reviews gave each number of stars (1 to 5). */
export function distribution(ratings: number[]): Record<1 | 2 | 3 | 4 | 5, number> {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of ratings) if (r >= 1 && r <= 5) out[r as 1 | 2 | 3 | 4 | 5]++;
  return out;
}

/**
 * Orders places by rating without letting one 5-star review beat fifty 4.8s: the average is
 * pulled towards a neutral prior until there are enough reviews (a Bayesian average).
 */
export function rankScore(average: number | null, count: number, prior = 4, weight = 5): number {
  if (average === null || count === 0) return prior;
  return (average * count + prior * weight) / (count + weight);
}
