/**
 * Waitlist rules. A patient waits for "any seat with this doctor on this day" once every slot of
 * that day is full. When seats free up the oldest waiting patients are told, a few at a time; the
 * seat itself is not held: whoever books first gets it.
 */

/** A day can be waited for from today until the end of the booking window. */
export function dateInWaitWindow(date: string, today: string, lastBookableDay: string): boolean {
  return date >= today && date <= lastBookableDay;
}

/**
 * How many more patients to tell. Seats already offered to patients who are still inside their
 * notice period count as taken, so two seats are never offered to ten people at once.
 */
export function patientsToTell(freeSeats: number, stillOffered: number, batch: number): number {
  return Math.max(0, Math.min(batch, freeSeats - stillOffered));
}

/** A told patient who has not booked by this time loses their place to the next in line. */
export function noticeEndsAt(notifiedAt: Date | null, noticeMinutes: number): Date | null {
  return notifiedAt ? new Date(notifiedAt.getTime() + noticeMinutes * 60_000) : null;
}

/** 1-based place in the line among the patients still waiting, oldest first. */
export function positionInLine(createdAt: Date, waitingCreatedAt: readonly Date[]): number {
  return waitingCreatedAt.filter((c) => c.getTime() < createdAt.getTime()).length + 1;
}
