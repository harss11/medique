/**
 * Reviews through the real HTTP API: who can write one, the windows, privacy of the reviewer,
 * hospital reports and platform-admin moderation. Run with `pnpm test:integration`.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { signAccessToken } from "../auth/tokens.js";
import {
  cleanup,
  createDoctor,
  createPatients,
  createStaffUser,
  createWorld,
  pastVisit,
  type Patient,
  type Staff,
  type World,
} from "../../../test/fixtures.js";

let server: Server;
let base: string;
let world: World;
let other: World;
let alice: Patient;
let bob: Patient;
let aliceToken: string;
let bobToken: string;
let hospitalAdmin: Staff;
let otherAdmin: Staff;
let adminId: string;
let adminToken: string;

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function http(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body };
}

const tokenFor = (p: Patient) =>
  signAccessToken({ id: p.userId, role: "PATIENT", hospitalId: null, tokenVersion: 0 }).token;

beforeAll(async () => {
  world = await createWorld();
  other = await createWorld();
  [alice, bob] = (await createPatients(world, 2)) as [Patient, Patient];
  await prisma.user.update({ where: { id: alice.userId }, data: { name: "Sunita Devi Sharma" } });
  aliceToken = tokenFor(alice);
  bobToken = tokenFor(bob);
  hospitalAdmin = await createStaffUser(world, "HOSPITAL_ADMIN");
  otherAdmin = await createStaffUser(other, "HOSPITAL_ADMIN");
  const admin = await prisma.user.create({
    data: { role: "ADMIN", name: "Review Admin", loginId: `review-admin-${Date.now()}` },
  });
  adminId = admin.id;
  adminToken = signAccessToken({
    id: admin.id,
    role: "ADMIN",
    hospitalId: null,
    tokenVersion: 0,
  }).token;
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server?.close();
  if (world) await cleanup(world);
  if (other) await cleanup(other);
  if (adminId) {
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.user.delete({ where: { id: adminId } });
  }
  await prisma.$disconnect();
});

describe("who can write a review", () => {
  it("lets the patient rate a completed visit once, and shows it on the appointment", async () => {
    const visit = await pastVisit(world, alice);
    const before = await http("GET", `/appointments/${visit.id}`, { token: aliceToken });
    expect(before.body.data.canReview).toBe(true);
    expect(before.body.data.review).toBeNull();

    const created = await http("POST", `/appointments/${visit.id}/review`, {
      token: aliceToken,
      body: { rating: 5, comment: "Very patient doctor" },
    });
    expect(created.status).toBe(201);
    expect(created.body.data.review).toMatchObject({
      rating: 5,
      comment: "Very patient doctor",
      hidden: false,
      canEdit: true,
    });
    expect(created.body.data.canReview).toBe(false);

    const again = await http("POST", `/appointments/${visit.id}/review`, {
      token: aliceToken,
      body: { rating: 1 },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_REVIEWED");
  });

  it("answers one review when two taps race", async () => {
    const visit = await pastVisit(world, alice);
    const replies = await Promise.all(
      [1, 2, 3].map(() =>
        http("POST", `/appointments/${visit.id}/review`, {
          token: aliceToken,
          body: { rating: 4 },
        }),
      ),
    );
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await prisma.review.count({ where: { appointmentId: visit.id } })).toBe(1);
  });

  it("refuses a visit that has not happened, a cancelled one and a walk-in", async () => {
    const booked = await pastVisit(world, alice, { status: "CONFIRMED" });
    const notSeen = await http("POST", `/appointments/${booked.id}/review`, {
      token: aliceToken,
      body: { rating: 5 },
    });
    expect(notSeen.status).toBe(409);
    expect(notSeen.body.error.code).toBe("NOT_COMPLETED");

    const cancelled = await pastVisit(world, alice, { status: "CANCELLED" });
    expect(
      (
        await http("POST", `/appointments/${cancelled.id}/review`, {
          token: aliceToken,
          body: { rating: 5 },
        })
      ).status,
    ).toBe(409);

    const walkIn = await pastVisit(world, alice, { source: "WALK_IN" });
    expect(
      (
        await http("POST", `/appointments/${walkIn.id}/review`, {
          token: aliceToken,
          body: { rating: 5 },
        })
      ).status,
    ).toBe(404);
  });

  it("refuses somebody else's visit, a missing login and a bad rating", async () => {
    const visit = await pastVisit(world, alice);
    expect(
      (
        await http("POST", `/appointments/${visit.id}/review`, {
          token: bobToken,
          body: { rating: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (await http("POST", `/appointments/${visit.id}/review`, { body: { rating: 1 } })).status,
    ).toBe(401);
    for (const rating of [0, 6, 3.5, "5", null]) {
      const r = await http("POST", `/appointments/${visit.id}/review`, {
        token: aliceToken,
        body: { rating },
      });
      expect(r.status).toBe(400);
    }
    const long = await http("POST", `/appointments/${visit.id}/review`, {
      token: aliceToken,
      body: { rating: 5, comment: "x".repeat(501) },
    });
    expect(long.status).toBe(400);
    expect(await prisma.review.count({ where: { appointmentId: visit.id } })).toBe(0);
  });

  it("closes after the review window", async () => {
    const old = await pastVisit(world, alice, { daysAgo: env.REVIEW_WINDOW_DAYS + 2 });
    const r = await http("POST", `/appointments/${old.id}/review`, {
      token: aliceToken,
      body: { rating: 5 },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("REVIEW_WINDOW_CLOSED");
    const appt = await http("GET", `/appointments/${old.id}`, { token: aliceToken });
    expect(appt.body.data.canReview).toBe(false);
  });
});

describe("changing and withdrawing a review", () => {
  it("can be edited for a few days, then locked", async () => {
    const visit = await pastVisit(world, alice);
    await http("POST", `/appointments/${visit.id}/review`, {
      token: aliceToken,
      body: { rating: 2, comment: "Long wait" },
    });
    const edited = await http("PATCH", `/appointments/${visit.id}/review`, {
      token: aliceToken,
      body: { rating: 4, comment: null },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.review).toMatchObject({ rating: 4, comment: null });

    await prisma.review.update({
      where: { appointmentId: visit.id },
      data: { createdAt: new Date(Date.now() - (env.REVIEW_EDIT_DAYS + 1) * 86_400_000) },
    });
    const locked = await http("PATCH", `/appointments/${visit.id}/review`, {
      token: aliceToken,
      body: { rating: 1 },
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("REVIEW_LOCKED");
  });

  it("is private to its author", async () => {
    const visit = await pastVisit(world, alice);
    await http("POST", `/appointments/${visit.id}/review`, {
      token: aliceToken,
      body: { rating: 3 },
    });
    expect(
      (
        await http("PATCH", `/appointments/${visit.id}/review`, {
          token: bobToken,
          body: { rating: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (await http("DELETE", `/appointments/${visit.id}/review`, { token: bobToken })).status,
    ).toBe(404);
    expect((await prisma.review.findUnique({ where: { appointmentId: visit.id } }))?.rating).toBe(
      3,
    );
  });

  it("can be taken back, and then written again", async () => {
    const visit = await pastVisit(world, alice);
    await http("POST", `/appointments/${visit.id}/review`, {
      token: aliceToken,
      body: { rating: 1 },
    });
    const gone = await http("DELETE", `/appointments/${visit.id}/review`, { token: aliceToken });
    expect(gone.status).toBe(200);
    expect(gone.body.data.review).toBeNull();
    expect(gone.body.data.canReview).toBe(true);
    expect(
      (
        await http("POST", `/appointments/${visit.id}/review`, {
          token: aliceToken,
          body: { rating: 5 },
        })
      ).status,
    ).toBe(201);
  });
});

describe("what the public sees", () => {
  it("shows ratings on doctors and hospitals, and reviewers by first name and initial only", async () => {
    const doctorId = await createDoctor(world);
    const visits = [
      await pastVisit(world, alice, { doctorId }),
      await pastVisit(world, bob, { doctorId }),
    ];
    await http("POST", `/appointments/${visits[0]!.id}/review`, {
      token: aliceToken,
      body: { rating: 5, comment: "Excellent" },
    });
    await http("POST", `/appointments/${visits[1]!.id}/review`, {
      token: bobToken,
      body: { rating: 4 },
    });

    const doctor = await http("GET", `/public/doctors/${doctorId}`);
    expect(doctor.body.data.rating).toEqual({ average: 4.5, count: 2 });

    const list = await http("GET", `/public/doctors/${doctorId}/reviews`);
    expect(list.status).toBe(200);
    expect(list.body.data.summary).toMatchObject({
      average: 4.5,
      count: 2,
      distribution: { 4: 1, 5: 1 },
    });
    const names = list.body.data.items.map((i: { reviewer: string }) => i.reviewer);
    expect(names).toContain("Sunita S.");
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain("Devi");
    expect(raw).not.toContain(alice.userId);
    expect(raw).not.toContain(alice.profileId);

    const hospital = await prisma.hospital.findUniqueOrThrow({ where: { id: world.hospitalId } });
    const page = await http("GET", `/public/hospitals/${hospital.slug}`);
    expect(page.body.data.rating.count).toBeGreaterThanOrEqual(2);
    const hospitalReviews = await http("GET", `/public/hospitals/${hospital.slug}/reviews?limit=2`);
    expect(hospitalReviews.body.data.items).toHaveLength(2);
    expect(hospitalReviews.body.data.pagination.total).toBeGreaterThan(2);

    const unrated = await http("GET", `/public/doctors/${other.doctorId}`);
    expect(unrated.body.data.rating).toEqual({ average: null, count: 0 });
  });
});

describe("reports and moderation", () => {
  it("a hospital can report only its own reviews and cannot hide them", async () => {
    const visit = await pastVisit(world, alice);
    await http("POST", `/appointments/${visit.id}/review`, {
      token: aliceToken,
      body: { rating: 1, comment: "Rude staff" },
    });
    const review = await prisma.review.findUniqueOrThrow({ where: { appointmentId: visit.id } });

    // another hospital cannot even see it
    const foreign = await http("GET", "/hospital/reviews", { token: otherAdmin.token });
    expect(JSON.stringify(foreign.body)).not.toContain(review.id);
    expect(
      (
        await http("POST", `/hospital/reviews/${review.id}/report`, {
          token: otherAdmin.token,
          body: { reason: "Not a patient of ours" },
        })
      ).status,
    ).toBe(404);

    // patients and receptionists have no business here
    expect(
      (
        await http("POST", `/hospital/reviews/${review.id}/report`, {
          token: aliceToken,
          body: { reason: "Not true" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await http("POST", `/admin/reviews/${review.id}/hide`, {
          token: hospitalAdmin.token,
          body: { reason: "Hide it" },
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await http("POST", `/hospital/reviews/${review.id}/report`, {
          token: hospitalAdmin.token,
          body: { reason: "x" },
        })
      ).status,
    ).toBe(400);
    const reported = await http("POST", `/hospital/reviews/${review.id}/report`, {
      token: hospitalAdmin.token,
      body: { reason: "This patient was never rude to anyone" },
    });
    expect(reported.status).toBe(200);
    const twice = await http("POST", `/hospital/reviews/${review.id}/report`, {
      token: hospitalAdmin.token,
      body: { reason: "Reporting again" },
    });
    expect(twice.body.error.code).toBe("ALREADY_REPORTED");

    const mine = await http("GET", "/hospital/reviews?status=reported", {
      token: hospitalAdmin.token,
    });
    const row = mine.body.data.items.find((i: { id: string }) => i.id === review.id);
    expect(row).toMatchObject({
      reviewer: "Sunita S.",
      reportReason: "This patient was never rude to anyone",
    });
    expect(JSON.stringify(mine.body)).not.toContain(alice.userId);
  });

  it("the admin hides a review: it leaves the public ratings, the author cannot edit it, and it can be restored", async () => {
    const doctorId = await createDoctor(world);
    const visit = await pastVisit(world, bob, { doctorId });
    await http("POST", `/appointments/${visit.id}/review`, {
      token: bobToken,
      body: { rating: 1, comment: "Spam spam" },
    });
    const review = await prisma.review.findUniqueOrThrow({ where: { appointmentId: visit.id } });
    expect((await http("GET", `/public/doctors/${doctorId}`)).body.data.rating.count).toBe(1);

    expect(
      (await http("POST", `/admin/reviews/${review.id}/hide`, { token: adminToken, body: {} }))
        .status,
    ).toBe(400);
    const hidden = await http("POST", `/admin/reviews/${review.id}/hide`, {
      token: adminToken,
      body: { reason: "Advertising, not a review" },
    });
    expect(hidden.status).toBe(200);
    expect(
      (
        await http("POST", `/admin/reviews/${review.id}/hide`, {
          token: adminToken,
          body: { reason: "Hide again" },
        })
      ).body.error.code,
    ).toBe("INVALID_STATUS");

    expect((await http("GET", `/public/doctors/${doctorId}`)).body.data.rating).toEqual({
      average: null,
      count: 0,
    });
    expect((await http("GET", `/public/doctors/${doctorId}/reviews`)).body.data.items).toHaveLength(
      0,
    );

    const edit = await http("PATCH", `/appointments/${visit.id}/review`, {
      token: bobToken,
      body: { rating: 5 },
    });
    expect(edit.body.error.code).toBe("REVIEW_HIDDEN");
    const asBob = await http("GET", `/appointments/${visit.id}`, { token: bobToken });
    expect(asBob.body.data.review).toMatchObject({ hidden: true, canEdit: false });

    const hiddenList = await http("GET", "/admin/reviews?status=hidden", { token: adminToken });
    expect(hiddenList.body.data.items.map((i: { id: string }) => i.id)).toContain(review.id);

    expect(
      (await http("POST", `/admin/reviews/${review.id}/unhide`, { token: adminToken })).status,
    ).toBe(200);
    expect((await http("GET", `/public/doctors/${doctorId}`)).body.data.rating.count).toBe(1);
    expect(
      (await http("POST", `/admin/reviews/${review.id}/unhide`, { token: adminToken })).body.error
        .code,
    ).toBe("INVALID_STATUS");

    const actions = await prisma.auditLog.findMany({
      where: { entityType: "Review", entityId: review.id },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(["review.created", "review.hidden", "review.unhidden"]),
    );
  });

  it("the admin can dismiss a report and keep the review published", async () => {
    const visit = await pastVisit(world, alice);
    await http("POST", `/appointments/${visit.id}/review`, {
      token: aliceToken,
      body: { rating: 2 },
    });
    const review = await prisma.review.findUniqueOrThrow({ where: { appointmentId: visit.id } });
    expect(
      (await http("POST", `/admin/reviews/${review.id}/dismiss`, { token: adminToken })).body.error
        .code,
    ).toBe("INVALID_STATUS");
    await http("POST", `/hospital/reviews/${review.id}/report`, {
      token: hospitalAdmin.token,
      body: { reason: "Disagree with this" },
    });

    const queue = await http("GET", "/admin/reviews", { token: adminToken });
    expect(queue.body.data.items.map((i: { id: string }) => i.id)).toContain(review.id);

    expect(
      (await http("POST", `/admin/reviews/${review.id}/dismiss`, { token: adminToken })).status,
    ).toBe(200);
    const after = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after).toMatchObject({ isPublished: true, reportedAt: null });
    expect(
      (await http("GET", "/admin/reviews", { token: adminToken })).body.data.items.map(
        (i: { id: string }) => i.id,
      ),
    ).not.toContain(review.id);
  });

  it("only the platform admin can moderate", async () => {
    const id = "00000000-0000-7000-8000-000000000000";
    expect((await http("GET", "/admin/reviews", { token: aliceToken })).status).toBe(403);
    expect((await http("GET", "/admin/reviews", { token: hospitalAdmin.token })).status).toBe(403);
    expect((await http("POST", `/admin/reviews/${id}/dismiss`, { token: adminToken })).status).toBe(
      404,
    );
  });
});
