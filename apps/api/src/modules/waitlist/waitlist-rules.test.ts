import { describe, expect, it } from "vitest";
import {
  dateInWaitWindow,
  noticeEndsAt,
  patientsToTell,
  positionInLine,
} from "./waitlist-rules.js";

describe("which days can be waited for", () => {
  it("today up to the last bookable day, never the past", () => {
    expect(dateInWaitWindow("2026-10-06", "2026-10-06", "2026-11-05")).toBe(true);
    expect(dateInWaitWindow("2026-11-05", "2026-10-06", "2026-11-05")).toBe(true);
    expect(dateInWaitWindow("2026-11-06", "2026-10-06", "2026-11-05")).toBe(false);
    expect(dateInWaitWindow("2026-10-05", "2026-10-06", "2026-11-05")).toBe(false);
  });
});

describe("how many patients are told", () => {
  it("never more than the batch, nor more than the seats left unoffered", () => {
    expect(patientsToTell(1, 0, 3)).toBe(1);
    expect(patientsToTell(5, 0, 3)).toBe(3);
    expect(patientsToTell(5, 3, 3)).toBe(2);
    expect(patientsToTell(2, 2, 3)).toBe(0);
    expect(patientsToTell(0, 0, 3)).toBe(0);
    expect(patientsToTell(1, 4, 3)).toBe(0);
  });
});

describe("the notice period", () => {
  const told = new Date("2026-10-06T10:00:00Z");
  it("runs out after the set minutes, and only exists once the patient was told", () => {
    expect(noticeEndsAt(told, 60)).toEqual(new Date("2026-10-06T11:00:00Z"));
    expect(noticeEndsAt(null, 60)).toBeNull();
  });
});

describe("place in line", () => {
  it("counts the people who joined before you", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 6, 10, m));
    const waiting = [at(0), at(5), at(9)];
    expect(positionInLine(at(0), waiting)).toBe(1);
    expect(positionInLine(at(5), waiting)).toBe(2);
    expect(positionInLine(at(9), waiting)).toBe(3);
  });
});
