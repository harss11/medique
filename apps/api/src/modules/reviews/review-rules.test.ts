import { describe, expect, it } from "vitest";
import {
  distribution,
  rankScore,
  reviewEditable,
  reviewWindowOpen,
  reviewerLabel,
  summarise,
} from "./review-rules.js";

const now = new Date("2026-10-20T10:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe("when a visit can be reviewed", () => {
  it("only after the visit, and only for the window", () => {
    expect(reviewWindowOpen(null, now, 30)).toBe(false); // never seen
    expect(reviewWindowOpen(daysAgo(0), now, 30)).toBe(true);
    expect(reviewWindowOpen(daysAgo(30), now, 30)).toBe(true);
    expect(reviewWindowOpen(daysAgo(31), now, 30)).toBe(false);
  });

  it("can be edited for a short while after writing", () => {
    expect(reviewEditable(daysAgo(7), now, 7)).toBe(true);
    expect(reviewEditable(daysAgo(8), now, 7)).toBe(false);
    expect(reviewEditable(daysAgo(0), now, 0)).toBe(true);
  });
});

describe("who the public sees", () => {
  it("shows a first name and the initial of the last name, never more", () => {
    expect(reviewerLabel("Sunita Devi Sharma")).toBe("Sunita S.");
    expect(reviewerLabel("  rahul   verma ")).toBe("rahul V.");
    expect(reviewerLabel("Madonna")).toBe("Madonna");
    expect(reviewerLabel("")).toBe("A patient");
    expect(reviewerLabel("Anil अग्रवाल")).toBe("Anil अ.");
  });
});

describe("ratings", () => {
  it("averages to one decimal and says nothing when there are no reviews", () => {
    expect(summarise([])).toEqual({ average: null, count: 0 });
    expect(summarise([5, 4, 4])).toEqual({ average: 4.3, count: 3 });
    expect(summarise([5])).toEqual({ average: 5, count: 1 });
  });

  it("counts the stars, ignoring anything out of range", () => {
    expect(distribution([5, 5, 4, 1, 9, 0])).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 2 });
  });

  it("does not let one 5-star review beat many good ones", () => {
    const one = rankScore(5, 1);
    const many = rankScore(4.8, 50);
    expect(many).toBeGreaterThan(one);
    expect(rankScore(null, 0)).toBe(4); // unreviewed sits at the neutral prior
    expect(rankScore(5, 1000)).toBeCloseTo(5, 1);
  });
});
