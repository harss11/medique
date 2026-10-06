/**
 * Doctor and hospital search through the real HTTP API. Every query carries a unique word so the
 * results are only this test's doctors. Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { randomToken } from "../../utils/crypto.js";
import { addDays, todayInZone } from "../../utils/time.js";
import { confirmAppointment, lockSlot } from "../appointments/booking.service.js";
import {
  TZ,
  cleanup,
  createDoctor,
  createPatients,
  createWorld,
  pastVisit,
  slotFactory,
  type Patient,
  type World,
} from "../../../test/fixtures.js";

const TAG = `srch${randomToken(4)
  .replace(/[^a-z0-9]/gi, "x")
  .toLowerCase()}`;
const CITY = `Testville${TAG}`;

let server: Server;
let base: string;
let world: World;
let pune: World;
let makeSlot: ReturnType<typeof slotFactory>;
let makePuneSlot: ReturnType<typeof slotFactory>;
let patients: Patient[];
const ids: Record<string, string> = {};

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

async function get(path: string): Promise<Reply> {
  const res = await fetch(base + path);
  const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
  return { status: res.status, data: json?.data };
}

const search = (qs: string) => get(`/public/search/doctors?q=${TAG}${qs ? `&${qs}` : ""}`);
const nameList = (r: Reply) => (r.data.items as Array<{ name: string }>).map((d) => d.name);

beforeAll(async () => {
  world = await createWorld();
  pune = await createWorld();
  makeSlot = slotFactory(world);
  makePuneSlot = slotFactory(pune);
  await prisma.hospital.update({
    where: { id: world.hospitalId },
    data: { city: CITY, emergencyPhone: "+911234567890" },
  });
  await prisma.hospital.update({ where: { id: pune.hospitalId }, data: { city: `Other${TAG}` } });
  // The doctor each test world starts with would match through the city: keep only the ones made below.
  await prisma.doctor.updateMany({
    where: { id: { in: [world.doctorId, pune.doctorId] } },
    data: { isActive: false },
  });
  patients = await createPatients(world, 3);

  const make = async (
    key: string,
    w: World,
    data: Parameters<typeof prisma.doctor.update>[0]["data"],
  ) => {
    const id = await createDoctor(w);
    await prisma.doctor.update({ where: { id }, data: { name: `Dr ${key} ${TAG}`, ...data } });
    ids[key] = id;
  };
  await make("Heart", world, {
    specialization: "Cardiology",
    qualification: "MD, DM",
    gender: "FEMALE",
    languages: ["Hindi", "English"],
    consultationFee: 80_000,
    experienceYears: 20,
  });
  await make("Skin", world, {
    specialization: "Dermatology",
    gender: "MALE",
    languages: ["English"],
    consultationFee: 30_000,
    experienceYears: 5,
  });
  await make("Bones", pune, {
    specialization: "Cardiology",
    gender: "MALE",
    languages: ["Marathi"],
    consultationFee: 50_000,
    experienceYears: 12,
  });
  await make("Gone", world, { specialization: "Cardiology", isActive: false });

  // Heart has a seat tomorrow-ish, Skin a later one, Bones none; Skin is full on day 5 only.
  await makeSlot({ doctorId: ids.Heart!, dayOffset: 4, capacity: 2 });
  await makeSlot({ doctorId: ids.Skin!, dayOffset: 6, capacity: 1 });
  const fullSlot = await makeSlot({ doctorId: ids.Skin!, dayOffset: 5, capacity: 1 });
  const hold = await lockSlot(
    patients[0]!.auth,
    { slotId: fullSlot.id, patientProfileId: patients[0]!.profileId },
    {},
  );
  await confirmAppointment(hold.id, { provider: "MOCK", method: "ONLINE" }, null);
  expect(makePuneSlot).toBeTruthy();

  // Heart: two 5-star reviews. Skin: one 3-star review.
  for (const [i, rating] of [5, 5].entries()) {
    const visit = await pastVisit(world, patients[i]!, { doctorId: ids.Heart! });
    await prisma.review.create({
      data: {
        appointmentId: visit.id,
        hospitalId: world.hospitalId,
        doctorId: ids.Heart!,
        userId: patients[i]!.userId,
        rating,
      },
    });
  }
  const skinVisit = await pastVisit(world, patients[2]!, { doctorId: ids.Skin! });
  await prisma.review.create({
    data: {
      appointmentId: skinVisit.id,
      hospitalId: world.hospitalId,
      doctorId: ids.Skin!,
      userId: patients[2]!.userId,
      rating: 3,
    },
  });

  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  if (world) await cleanup(world);
  if (pune) await cleanup(pune);
  await prisma.$disconnect();
});

describe("searching by words", () => {
  it("finds active doctors by name, speciality, qualification and city, ignoring case", async () => {
    const all = await search("");
    expect(all.status).toBe(200);
    expect(nameList(all).sort()).toEqual([`Dr Bones ${TAG}`, `Dr Heart ${TAG}`, `Dr Skin ${TAG}`]);

    expect(nameList(await search("sort=fee_asc"))).toHaveLength(3);
    expect(
      nameList(await get(`/public/search/doctors?q=${TAG.toUpperCase()}+CARDIO`)).sort(),
    ).toEqual([`Dr Bones ${TAG}`, `Dr Heart ${TAG}`]);
    expect(nameList(await get(`/public/search/doctors?q=${TAG}+MD+${CITY.toLowerCase()}`))).toEqual(
      [`Dr Heart ${TAG}`],
    );
    expect((await get(`/public/search/doctors?q=${TAG}+nothingmatchesthis`)).data.items).toEqual(
      [],
    );
  });

  it("never returns inactive doctors, hospitals that are not open, or private details", async () => {
    const r = await search("");
    expect(JSON.stringify(r.data)).not.toContain("Gone");
    expect(JSON.stringify(r.data)).not.toMatch(
      /qrToken|registrationNumber|userId|commission|loginId/,
    );

    await prisma.hospital.update({ where: { id: pune.hospitalId }, data: { status: "BLOCKED" } });
    try {
      expect(nameList(await search("")).some((n) => n.includes("Bones"))).toBe(false);
    } finally {
      await prisma.hospital.update({ where: { id: pune.hospitalId }, data: { status: "ACTIVE" } });
    }
  });
});

describe("filters", () => {
  it("by city, speciality, gender, language and fee", async () => {
    expect(nameList(await search(`city=${CITY.toLowerCase()}`)).sort()).toEqual([
      `Dr Heart ${TAG}`,
      `Dr Skin ${TAG}`,
    ]);
    expect(nameList(await search("specialization=cardiology")).sort()).toEqual([
      `Dr Bones ${TAG}`,
      `Dr Heart ${TAG}`,
    ]);
    expect(nameList(await search("gender=FEMALE"))).toEqual([`Dr Heart ${TAG}`]);
    expect(nameList(await search("language=Marathi"))).toEqual([`Dr Bones ${TAG}`]);
    expect(nameList(await search("maxFee=50000")).sort()).toEqual([
      `Dr Bones ${TAG}`,
      `Dr Skin ${TAG}`,
    ]);
  });

  it("by rating", async () => {
    expect(nameList(await search("minRating=4"))).toEqual([`Dr Heart ${TAG}`]);
    expect(nameList(await search("minRating=3")).sort()).toEqual([
      `Dr Heart ${TAG}`,
      `Dr Skin ${TAG}`,
    ]);
  });

  it("by a day with a free seat, not by days that are full", async () => {
    const heartDay = addDays(todayInZone(TZ), 4);
    expect(nameList(await search(`availableOn=${heartDay}`))).toEqual([`Dr Heart ${TAG}`]);
    expect(nameList(await search(`availableOn=${addDays(todayInZone(TZ), 5)}`))).toEqual([]); // Skin is full
    expect(nameList(await search(`availableOn=${addDays(todayInZone(TZ), 6)}`))).toEqual([
      `Dr Skin ${TAG}`,
    ]);
  });
});

describe("order, pages and filter options", () => {
  it("sorts by fee, experience, soonest seat and rating", async () => {
    expect(nameList(await search("sort=fee_asc"))).toEqual([
      `Dr Skin ${TAG}`,
      `Dr Bones ${TAG}`,
      `Dr Heart ${TAG}`,
    ]);
    expect(nameList(await search("sort=fee_desc"))[0]).toBe(`Dr Heart ${TAG}`);
    expect(nameList(await search("sort=experience"))[0]).toBe(`Dr Heart ${TAG}`);
    // Heart has the earlier seat, Skin the later one, Bones has none and goes last.
    expect(nameList(await search("sort=soonest"))).toEqual([
      `Dr Heart ${TAG}`,
      `Dr Skin ${TAG}`,
      `Dr Bones ${TAG}`,
    ]);
    expect(nameList(await search("sort=rating"))[0]).toBe(`Dr Heart ${TAG}`);
    expect(nameList(await search(""))[0]).toBe(`Dr Heart ${TAG}`); // recommended
  });

  it("shows the rating and the next free seat of each doctor", async () => {
    const r = await search("sort=soonest");
    const [heart, skin, bones] = r.data.items;
    expect(heart.rating).toEqual({ average: 5, count: 2 });
    expect(heart.nextAvailable.date).toBe(addDays(todayInZone(TZ), 4));
    expect(skin.rating).toEqual({ average: 3, count: 1 });
    expect(bones.rating).toEqual({ average: null, count: 0 });
    expect(bones.nextAvailable).toBeNull();
    expect(heart.hospital).toMatchObject({ city: CITY });
    expect(heart.hospital.slug).toBeTruthy();
  });

  it("pages the results", async () => {
    const first = await search("sort=fee_asc&limit=2&page=1");
    const second = await search("sort=fee_asc&limit=2&page=2");
    expect(first.data.items).toHaveLength(2);
    expect(second.data.items).toHaveLength(1);
    expect(first.data.pagination).toMatchObject({ total: 3, totalPages: 2 });
    expect(nameList(second)).toEqual([`Dr Heart ${TAG}`]);
  });

  it("lists what people can filter by, from everything the words match", async () => {
    const r = await search("specialization=dermatology");
    const f = r.data.facets;
    expect(f.specializations.map((s: { value: string }) => s.value).sort()).toEqual([
      "Cardiology",
      "Dermatology",
    ]);
    expect(f.specializations.find((s: { value: string }) => s.value === "Cardiology").count).toBe(
      2,
    );
    expect(f.cities.map((c: { value: string }) => c.value)).toContain(CITY);
    expect(f.languages.map((l: { value: string }) => l.value)).toEqual(
      expect.arrayContaining(["English", "Hindi", "Marathi"]),
    );
    expect(r.data.capped).toBe(false);
  });

  it("refuses bad input", async () => {
    for (const qs of [
      "sort=cheapest",
      "availableOn=tomorrow",
      "minRating=9",
      "maxFee=-1",
      "limit=100000",
      "gender=ROBOT",
      "page=0",
    ]) {
      expect((await search(qs)).status, qs).toBe(400);
    }
    // text that looks like an injection is only text
    expect(
      (await get(`/public/search/doctors?q=${encodeURIComponent('\'; DROP TABLE "Doctor"; --')}`))
        .status,
    ).toBe(200);
  });
});

describe("hospital filters", () => {
  it("by speciality and emergency line", async () => {
    const withCardio = await get(`/public/hospitals?search=${CITY}&specialization=cardiology`);
    expect(withCardio.data.items.map((h: { id: string }) => h.id)).toEqual([world.hospitalId]);
    const none = await get(`/public/hospitals?search=${CITY}&specialization=neurology`);
    expect(none.data.items).toEqual([]);
    const emergency = await get(`/public/hospitals?search=${CITY}&emergency=true`);
    expect(emergency.data.items).toHaveLength(1);
    const noEmergency = await get(`/public/hospitals?search=Other${TAG}&emergency=true`);
    expect(noEmergency.data.items).toEqual([]);
    expect((await get("/public/hospitals?emergency=maybe")).status).toBe(400);
  });
});
