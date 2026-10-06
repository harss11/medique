import { describe, expect, it } from "vitest";
import {
  acceptsBookings,
  accessState,
  addMonths,
  daysLeft,
  monthRange,
  noticeFor,
  paidPeriod,
  withinLimit,
  type SubscriptionDates,
} from "./subscription-rules.js";

const at = (iso: string) => new Date(iso);
const now = at("2026-10-20T10:00:00Z");
const GRACE = 7;

const sub = (over: Partial<SubscriptionDates>): SubscriptionDates => ({
  status: "ACTIVE",
  trialEndsAt: null,
  currentPeriodEnd: null,
  ...over,
});

describe("the state of a subscription", () => {
  it("is active until the paid period ends, then in grace, then expired", () => {
    const end = at("2026-10-20T10:00:00Z");
    expect(accessState(sub({ currentPeriodEnd: at("2026-11-01T00:00:00Z") }), now, GRACE)).toBe(
      "ACTIVE",
    );
    expect(accessState(sub({ currentPeriodEnd: end }), now, GRACE)).toBe("ACTIVE"); // the last moment counts
    expect(accessState(sub({ currentPeriodEnd: at("2026-10-15T00:00:00Z") }), now, GRACE)).toBe(
      "GRACE",
    );
    expect(accessState(sub({ currentPeriodEnd: at("2026-10-13T10:00:00Z") }), now, GRACE)).toBe(
      "GRACE",
    );
    expect(accessState(sub({ currentPeriodEnd: at("2026-10-13T09:59:00Z") }), now, GRACE)).toBe(
      "EXPIRED",
    );
  });

  it("with no end date never runs out (a free plan)", () => {
    expect(accessState(sub({}), now, GRACE)).toBe("ACTIVE");
    expect(accessState(sub({ status: "TRIALING" }), now, GRACE)).toBe("TRIALING");
  });

  it("follows the trial end for a trial", () => {
    expect(
      accessState(sub({ status: "TRIALING", trialEndsAt: at("2026-10-25T00:00:00Z") }), now, GRACE),
    ).toBe("TRIALING");
    expect(
      accessState(sub({ status: "TRIALING", trialEndsAt: at("2026-10-18T00:00:00Z") }), now, GRACE),
    ).toBe("GRACE");
    expect(
      accessState(sub({ status: "TRIALING", trialEndsAt: at("2026-09-01T00:00:00Z") }), now, GRACE),
    ).toBe("EXPIRED");
  });

  it("is never changed by dates once an admin suspended or cancelled it", () => {
    expect(
      accessState(
        sub({ status: "SUSPENDED", currentPeriodEnd: at("2027-01-01T00:00:00Z") }),
        now,
        GRACE,
      ),
    ).toBe("SUSPENDED");
    expect(accessState(sub({ status: "CANCELLED" }), now, GRACE)).toBe("CANCELLED");
  });

  it("zero grace days means it stops the moment the period ends", () => {
    expect(accessState(sub({ currentPeriodEnd: at("2026-10-20T09:59:00Z") }), now, 0)).toBe(
      "EXPIRED",
    );
  });

  it("takes online bookings only in good standing", () => {
    expect(["TRIALING", "ACTIVE", "GRACE"].every((s) => acceptsBookings(s as never))).toBe(true);
    expect(["EXPIRED", "SUSPENDED", "CANCELLED"].some((s) => acceptsBookings(s as never))).toBe(
      false,
    );
  });
});

describe("limits", () => {
  it("allow one more while under the limit, always when unlimited, never at zero", () => {
    expect(withinLimit(null, 10_000)).toBe(true);
    expect(withinLimit(5, 4)).toBe(true);
    expect(withinLimit(5, 5)).toBe(false);
    expect(withinLimit(5, 9)).toBe(false);
    expect(withinLimit(0, 0)).toBe(false);
  });
});

describe("months", () => {
  it("add calendar months, keeping the day or using the last day of a shorter month", () => {
    expect(addMonths(at("2026-10-20T10:00:00Z"), 1).toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(addMonths(at("2026-01-31T10:00:00Z"), 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addMonths(at("2028-01-31T10:00:00Z"), 1).toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(addMonths(at("2026-11-30T10:00:00Z"), 3).toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(addMonths(at("2026-12-15T10:00:00Z"), 12).toISOString()).toBe(
      "2027-12-15T10:00:00.000Z",
    );
  });

  it("a payment continues from the end of the paid period, or from today after a lapse", () => {
    const early = paidPeriod(at("2026-11-05T00:00:00Z"), now, 1);
    expect(early.start.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(early.end.toISOString()).toBe("2026-12-05T00:00:00.000Z");
    const lapsed = paidPeriod(at("2026-09-01T00:00:00Z"), now, 2);
    expect(lapsed.start).toEqual(now);
    expect(lapsed.end.toISOString()).toBe("2026-12-20T10:00:00.000Z");
    expect(paidPeriod(null, now, 1).start).toEqual(now);
  });

  it("count days left, rounding up, and say nothing without an end date", () => {
    expect(daysLeft(null, now)).toBeNull();
    expect(daysLeft(at("2026-10-21T10:00:00Z"), now)).toBe(1);
    expect(daysLeft(at("2026-10-20T11:00:00Z"), now)).toBe(1);
    expect(daysLeft(at("2026-10-20T10:00:00Z"), now)).toBe(0);
    expect(daysLeft(at("2026-10-18T10:00:00Z"), now)).toBe(-2);
  });
});

describe("the month used for the booking limit", () => {
  it("is the hospital's local calendar month", () => {
    const r = monthRange(at("2026-10-20T10:00:00Z"), "Asia/Kolkata");
    expect(r.from.toISOString()).toBe("2026-09-30T18:30:00.000Z"); // 1 Oct 00:00 in India
    expect(r.to.toISOString()).toBe("2026-10-31T18:30:00.000Z");
  });

  it("uses local time at the edges of the month", () => {
    // 31 Oct 20:00 UTC is already 1 Nov in India.
    const r = monthRange(at("2026-10-31T20:00:00Z"), "Asia/Kolkata");
    expect(r.from.toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(r.to.toISOString()).toBe("2026-11-30T18:30:00.000Z");
  });

  it("handles December", () => {
    const r = monthRange(at("2026-12-10T10:00:00Z"), "UTC");
    expect(r.from.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("what to tell the hospital", () => {
  it("warns a week before the end, and after", () => {
    expect(noticeFor("ACTIVE", at("2026-12-01T00:00:00Z"), now)).toBe("none");
    expect(noticeFor("ACTIVE", at("2026-10-27T10:00:00Z"), now)).toBe("ending_soon");
    expect(noticeFor("TRIALING", at("2026-10-22T00:00:00Z"), now)).toBe("ending_soon");
    expect(noticeFor("ACTIVE", null, now)).toBe("none");
    expect(noticeFor("GRACE", at("2026-10-18T00:00:00Z"), now)).toBe("grace");
    expect(noticeFor("EXPIRED", at("2026-09-18T00:00:00Z"), now)).toBe("expired");
    expect(noticeFor("SUSPENDED", null, now)).toBe("suspended");
    expect(noticeFor("CANCELLED", null, now)).toBe("cancelled");
  });
});
