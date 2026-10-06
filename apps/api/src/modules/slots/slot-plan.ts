import { addDays, dayOfWeek, zonedTimeToUtc } from "../../utils/time.js";

export interface ScheduleInput {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
  capacityPerSlot: number;
}

export interface LeaveInput {
  /** inclusive, "YYYY-MM-DD" */
  startDate: string;
  endDate: string;
}

export interface PlannedSlot {
  date: string;
  startAt: Date;
  endAt: Date;
  capacity: number;
}

/**
 * Pure function: which slots should exist for a doctor in a window of local
 * dates, given weekly sessions and leave ranges. A trailing partial slot (e.g.
 * 10 minutes left of a 15-minute grid) is not created.
 */
export function planSlots(input: {
  schedules: ScheduleInput[];
  leaves: LeaveInput[];
  timezone: string;
  /** first local date of the window */
  fromDate: string;
  days: number;
}): PlannedSlot[] {
  const { schedules, leaves, timezone, fromDate, days } = input;
  const onLeave = (date: string) => leaves.some((l) => date >= l.startDate && date <= l.endDate);
  const slots: PlannedSlot[] = [];

  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    if (onLeave(date)) continue;
    const weekday = dayOfWeek(date);

    for (const s of schedules) {
      if (s.dayOfWeek !== weekday || s.slotMinutes <= 0) continue;
      for (let m = s.startMinute; m + s.slotMinutes <= s.endMinute; m += s.slotMinutes) {
        slots.push({
          date,
          startAt: zonedTimeToUtc(date, m, timezone),
          endAt: zonedTimeToUtc(date, m + s.slotMinutes, timezone),
          capacity: s.capacityPerSlot,
        });
      }
    }
  }

  return slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/** True when two sessions on the same weekday overlap in time. */
export function sessionsOverlap(a: ScheduleInput, b: ScheduleInput): boolean {
  return a.dayOfWeek === b.dayOfWeek && a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}
