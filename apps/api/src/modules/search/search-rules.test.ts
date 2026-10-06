import { describe, expect, it } from "vitest";
import { comparator, facetCounts, searchTokens, type Rankable } from "./search-rules.js";

const doc = (over: Partial<Rankable> & { name: string }): Rankable => ({
  fee: 50_000,
  experienceYears: null,
  rating: { average: null, count: 0 },
  next: null,
  ...over,
});
const at = (h: number) => new Date(Date.UTC(2026, 9, 7, h));
const names = (list: Rankable[], sort: Parameters<typeof comparator>[0]) =>
  [...list].sort(comparator(sort)).map((d) => d.name);

describe("search words", () => {
  it("splits on spaces, lowercases, and keeps a sane number of words", () => {
    expect(searchTokens("  Cardiologist   Delhi ")).toEqual(["cardiologist", "delhi"]);
    expect(searchTokens(undefined)).toEqual([]);
    expect(searchTokens("   ")).toEqual([]);
    expect(searchTokens("a b c d e f g h")).toHaveLength(6);
    expect(searchTokens("x".repeat(500))[0]).toHaveLength(40);
  });
});

describe("filter options", () => {
  it("counts values ignoring case and blanks, commonest first", () => {
    const out = facetCounts([
      "Cardiology",
      "cardiology",
      null,
      "  ",
      "ENT",
      "Cardiology",
      undefined,
      "Dental",
    ]);
    expect(out).toEqual([
      { value: "Cardiology", count: 3 },
      { value: "Dental", count: 1 },
      { value: "ENT", count: 1 },
    ]);
  });

  it("can be limited", () => {
    expect(facetCounts(["a", "b", "c"], 2)).toHaveLength(2);
  });
});

describe("the order of results", () => {
  const list = [
    doc({ name: "Dr Cheap", fee: 20_000, experienceYears: 3, next: at(12) }),
    doc({
      name: "Dr Senior",
      fee: 90_000,
      experienceYears: 30,
      next: at(10),
      rating: { average: 4.9, count: 80 },
    }),
    doc({
      name: "Dr Busy",
      fee: 50_000,
      experienceYears: 10,
      next: null,
      rating: { average: 5, count: 1 },
    }),
  ];

  it("fee and experience", () => {
    expect(names(list, "fee_asc")).toEqual(["Dr Cheap", "Dr Busy", "Dr Senior"]);
    expect(names(list, "fee_desc")).toEqual(["Dr Senior", "Dr Busy", "Dr Cheap"]);
    expect(names(list, "experience")).toEqual(["Dr Senior", "Dr Busy", "Dr Cheap"]);
  });

  it("soonest puts a doctor with no free seat last", () => {
    expect(names(list, "soonest")).toEqual(["Dr Senior", "Dr Cheap", "Dr Busy"]);
  });

  it("rating does not let a single review beat many good ones", () => {
    expect(names(list, "rating")[0]).toBe("Dr Senior");
    expect(names(list, "recommended")[0]).toBe("Dr Senior");
  });

  it("ties fall back to the soonest seat and then the name, so the order is stable", () => {
    const tied = [
      doc({ name: "B", next: at(9) }),
      doc({ name: "A", next: at(9) }),
      doc({ name: "C", next: at(8) }),
    ];
    expect(names(tied, "fee_asc")).toEqual(["C", "A", "B"]);
    expect(names(tied, "recommended")).toEqual(["C", "A", "B"]);
  });
});
