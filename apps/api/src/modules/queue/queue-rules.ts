/**
 * Pure rules for queues and desk work, kept free of I/O so they are easy to test.
 */

export type QueueState =
  /** Nobody has booked this doctor for the day. */
  | "NO_BOOKINGS"
  /** There are bookings but the doctor has not seen anyone yet. */
  | "NOT_STARTED"
  /** A patient is with the doctor right now. */
  | "SERVING"
  /** Someone just finished and the next patient is not in yet. */
  | "BETWEEN"
  /** Everyone booked has been seen (or did not come). */
  | "DONE";

export interface QueueCounts {
  /** Booked but not yet arrived (CONFIRMED). */
  booked: number;
  /** Arrived and waiting (CHECKED_IN). */
  waiting: number;
  /** With the doctor now (IN_PROGRESS). */
  inProgress: number;
  /** Seen (COMPLETED). */
  completed: number;
  /** Did not come (NO_SHOW). */
  noShow: number;
}

export function queueState(c: QueueCounts): QueueState {
  if (c.inProgress > 0) return "SERVING";
  const pending = c.booked + c.waiting;
  if (c.completed > 0) return pending > 0 ? "BETWEEN" : "DONE";
  const total = pending + c.completed + c.noShow;
  if (total === 0) return "NO_BOOKINGS";
  return pending > 0 ? "NOT_STARTED" : "DONE";
}

export interface WaitEstimate {
  /** Patients (arrived or not) with a lower token who have not been seen yet. */
  ahead: number;
  /** tokens ahead x the doctor's average consultation time. */
  minutes: number;
}

/**
 * "Tokens ahead x average consult minutes". Patients ahead who have not arrived yet
 * are counted, because they keep their place in token order until the doctor skips them.
 */
export function estimateWait(ahead: number, avgConsultMinutes: number): WaitEstimate {
  const n = Math.max(0, Math.floor(ahead));
  return { ahead: n, minutes: n * Math.max(1, Math.round(avgConsultMinutes)) };
}

export type YourTokenStatus = "WAITING" | "NOW" | "DONE" | "MISSED" | "NOT_FOUND";

/** Whole years between a date of birth and now (null when unknown). */
export function ageInYears(dateOfBirth: Date | null, now: Date = new Date()): number | null {
  if (!dateOfBirth) return null;
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dateOfBirth.getUTCMonth() ||
    (now.getUTCMonth() === dateOfBirth.getUTCMonth() &&
      now.getUTCDate() < dateOfBirth.getUTCDate());
  if (beforeBirthday) age--;
  return Math.max(0, age);
}

/**
 * Receptionists type an age, not a birth date. We store the 1st of January of the
 * implied birth year, so the age shown stays consistent (and is never off by more than a year).
 */
export function dateOfBirthFromAge(ageYears: number, now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear() - ageYears, 0, 1));
}
