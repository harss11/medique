/**
 * Emergency blood requests: verified by a code, who is alerted, "I can help", and when contact
 * numbers are shown. On a real PostgreSQL. Run with `pnpm test:integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { mockOutbox } from "../../services/sms/index.js";
import {
  call,
  cleanupBlood,
  codeFor,
  createAdmin,
  createBank,
  createDonor,
  newCreated,
  sentTo,
  startServer,
  validPhone,
} from "../../../test/blood-helpers.js";
import { expireBloodRequests, purgeOldBloodRequests } from "./request-expiry.js";

const created = newCreated();
let base: string;
let closeServer: () => Promise<void>;
let admin: string;

const api = (
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => call(base, method, path, token, body, headers);
const withKey = (key: string) => ({ "X-Blood-Request-Key": key });

const HOSPITAL = { latitude: 28.6139, longitude: 77.209, city: "Testville" };

function requestBody(phone: string, code: string, over: Record<string, unknown> = {}) {
  return {
    phone,
    code,
    requesterName: "Ravi Kumar",
    bloodGroup: "O_POS",
    unitsNeeded: 2,
    urgency: "EMERGENCY",
    hospitalName: "City Hospital " + Math.random().toString(36).slice(2, 6),
    radiusKm: 25,
    note: "Surgery tomorrow morning",
    acceptDisclaimer: true,
    ...HOSPITAL,
    ...over,
  };
}

/** A new requester with a verified phone makes a request. */
async function makeRequest(over: Record<string, unknown> = {}, phone = validPhone()) {
  created.phones.push(phone);
  const code = await codeFor(base, phone, "REQUEST");
  const res = await api("POST", "/blood/requests", undefined, requestBody(phone, code, over));
  return { res, phone, id: res.data?.request?.id as string, key: res.data?.key as string };
}

const view = (id: string, key: string) =>
  api("GET", "/blood/requests/" + id, undefined, undefined, withKey(key));

beforeAll(async () => {
  const server = await startServer();
  base = server.base;
  closeServer = server.close;
  admin = await createAdmin(created);
});

afterAll(async () => {
  await closeServer();
  await cleanupBlood(created);
  await prisma.bloodRequest.deleteMany({ where: { requesterPhone: "[erased]" } });
  await prisma.$disconnect();
});

describe("who is alerted about a request", () => {
  const people: Record<string, Awaited<ReturnType<typeof createDonor>>> = {};
  let nearBank: Awaited<ReturnType<typeof createBank>>;
  let farBank: Awaited<ReturnType<typeof createBank>>;
  let pendingBank: Awaited<ReturnType<typeof createBank>>;
  let id = "";
  let key = "";
  let requesterPhone = "";

  beforeAll(async () => {
    people.eligible = await createDonor(created, { name: "Anil Eligible" });
    people.byCity = await createDonor(created, { name: "Bina ByCity", lat: null, lng: null });
    people.second = await createDonor(created, { name: "Chetan Second" });
    people.far = await createDonor(created, { lat: 19.07, lng: 72.87, city: "Mumbai" });
    people.wrongGroup = await createDonor(created, { bloodGroup: "A_POS" });
    people.paused = await createDonor(created, { isAvailable: false });
    people.waiting = await createDonor(created, {
      lastDonationAt: new Date(Date.now() - 10 * 86_400_000),
    });
    people.requester = await createDonor(created, { name: "Dev Requester" }); // a donor who is also the one asking
    people.young = await createDonor(created, { dateOfBirth: "2012-01-01" });
    nearBank = await createBank(created, { name: "Near Alert Bank" });
    farBank = await createBank(created, { lat: 19.07, lng: 72.87, city: "Mumbai" });
    pendingBank = await createBank(created, { status: "PENDING_VERIFICATION" });
    requesterPhone = people.requester.phone;
  });

  it("needs the code sent to the phone, and a confirmation that the requester understands", async () => {
    created.phones.push(requesterPhone);
    const code = await codeFor(base, requesterPhone, "REQUEST");
    const wrong = await api(
      "POST",
      "/blood/requests",
      undefined,
      requestBody(requesterPhone, code === "000000" ? "111111" : "000000"),
    );
    expect(wrong.code).toBe("OTP_INVALID");
    const noAck = await api(
      "POST",
      "/blood/requests",
      undefined,
      requestBody(requesterPhone, code, { acceptDisclaimer: false }),
    );
    expect(noAck.status).toBe(400);

    const res = await api(
      "POST",
      "/blood/requests",
      undefined,
      requestBody(requesterPhone, code, { hospitalName: "Alert Test Hospital" }),
    );
    expect(res.status).toBe(201);
    id = res.data.request.id;
    key = res.data.key;
    expect(key.length).toBeGreaterThan(30);
    expect(res.data.request).toMatchObject({ status: "OPEN", bloodGroup: "O_POS", unitsNeeded: 2 });
    // The key is stored only as a hash, and the response never carries it back out.
    const row = await prisma.bloodRequest.findUniqueOrThrow({ where: { id } });
    expect(row.requesterKeyHash).not.toContain(key);
    expect(JSON.stringify(res.data.request)).not.toMatch(/KeyHash|requesterPhone/);
  });

  it("alerts exactly the eligible donors of that group nearby, and the nearby verified banks", async () => {
    const row = await prisma.bloodRequest.findUniqueOrThrow({ where: { id } });
    expect([row.alertedDonors, row.alertedBanks]).toEqual([3, 1]); // eligible, by-city and second; the near bank

    const alerts = await prisma.bloodRequestAlert.findMany({ where: { requestId: id } });
    const donorIds = new Set(alerts.flatMap((a) => (a.donorId ? [a.donorId] : [])));
    expect(donorIds).toEqual(
      new Set([people.eligible!.donorId, people.byCity!.donorId, people.second!.donorId]),
    );
    const bankIds = alerts.flatMap((a) => (a.bloodBankId ? [a.bloodBankId] : []));
    expect(bankIds).toEqual([nearBank.bank.id]);
    // Nearest first, and the donor matched by city has no distance.
    expect(alerts.find((a) => a.donorId === people.eligible!.donorId)?.distanceKm).toBeGreaterThan(
      0,
    );
    expect(alerts.find((a) => a.donorId === people.byCity!.donorId)?.distanceKm).toBeNull();
  });

  it("sends each of them one SMS, and nobody else", async () => {
    for (const who of ["eligible", "byCity", "second"]) {
      const sms = await sentTo(people[who]!.phone, "blood_request_alert");
      expect(sms, who).toHaveLength(1);
      expect(sms[0]!.body).toMatch(
        /2 unit\(s\) of O\+ blood needed at Alert Test Hospital, Testville/,
      );
      expect(sms[0]!.body).not.toContain(requesterPhone);
    }
    for (const who of ["far", "wrongGroup", "paused", "waiting", "requester", "young"]) {
      expect(await sentTo(people[who]!.phone, "blood_request_alert"), who).toHaveLength(0);
    }
    expect(await sentTo(nearBank.phone, "blood_request_bank_alert")).toHaveLength(1);
    expect(await sentTo(farBank.phone, "blood_request_bank_alert")).toHaveLength(0);
    expect(await sentTo(pendingBank.phone, "blood_request_bank_alert")).toHaveLength(0);
    // No message is ever sent twice, however often the dispatcher runs.
    expect(await sentTo(people.eligible!.phone, "blood_request_alert")).toHaveLength(1);
  });

  it("is opened only with the secret key, and a wrong key looks like a wrong request", async () => {
    expect((await view(id, key)).status).toBe(200);
    expect((await api("GET", "/blood/requests/" + id)).code).toBe("REQUEST_NOT_FOUND");
    expect((await view(id, "not-the-key")).code).toBe("REQUEST_NOT_FOUND");
    expect((await view("00000000-0000-7000-8000-000000000000", key)).code).toBe(
      "REQUEST_NOT_FOUND",
    );
    const other = await makeRequest({ bloodGroup: "B_NEG" });
    expect((await view(id, other.key)).code).toBe("REQUEST_NOT_FOUND"); // another request's key opens nothing here
    expect((await api("GET", "/blood/requests/" + id + "?key=" + key)).code).toBe(
      "REQUEST_NOT_FOUND",
    ); // never from the URL
  });

  it("shows donors the request without the requester's number, and only to donors who were alerted", async () => {
    const mine = await api("GET", "/donor/requests", people.eligible!.token);
    expect(mine.data.items).toHaveLength(1);
    expect(mine.data.items[0]).toMatchObject({
      id,
      bloodGroup: "O_POS",
      hospitalName: "Alert Test Hospital",
      requesterFirstName: "Ravi",
      myResponse: null,
    });
    expect(mine.text).not.toContain(requesterPhone);
    expect(mine.text).not.toMatch(/Kumar|requesterPhone|KeyHash/);

    expect((await api("GET", "/donor/requests", people.wrongGroup!.token)).data.items).toEqual([]);
    const outsider = await api("POST", `/donor/requests/${id}/respond`, people.wrongGroup!.token, {
      response: "CAN_HELP",
    });
    expect(outsider.status).toBe(404);
    expect(
      (
        await api("POST", `/donor/requests/${id}/respond`, people.far!.token, {
          response: "CAN_HELP",
        })
      ).status,
    ).toBe(404);
  });

  it("shows the requester no donor, and no number, until a donor says I can help", async () => {
    const before = await view(id, key);
    expect(before.data.donors).toEqual([]);
    expect(before.data.banks).toEqual([]);
    expect(before.text).not.toContain(people.eligible!.phone);
    expect(before.data.request).toMatchObject({ alertedDonors: 3, alertedBanks: 1 });
  });

  it("reveals a donor's number to the requester after I can help, and tells the requester only once", async () => {
    const ok1 = await api("POST", `/donor/requests/${id}/respond`, people.eligible!.token, {
      response: "CAN_HELP",
    });
    expect(ok1.status).toBe(200);
    const ok2 = await api("POST", `/donor/requests/${id}/respond`, people.second!.token, {
      response: "CAN_HELP",
    });
    expect(ok2.status).toBe(200);

    const after = await view(id, key);
    expect(after.data.donors).toHaveLength(2);
    expect(after.data.donors.map((d: { firstName: string }) => d.firstName).sort()).toEqual([
      "Anil",
      "Chetan",
    ]);
    expect(
      after.data.donors.find((d: { firstName: string }) => d.firstName === "Anil"),
    ).toMatchObject({ phone: people.eligible!.phone, bloodGroup: "O_POS" });
    // Only first names: a surname never reaches the requester before they meet.
    expect(after.text).not.toMatch(/Eligible|Second/);
    // The donor who did not answer stays hidden.
    expect(after.text).not.toContain(people.byCity!.phone);

    const told = mockOutbox.filter(
      (m) => m.to === requesterPhone && m.template === "blood_request_answered",
    );
    await sentTo(requesterPhone, "blood_request_answered");
    expect(
      mockOutbox.filter((m) => m.to === requesterPhone && m.template === "blood_request_answered"),
    ).toHaveLength(told.length || 1);
    expect(
      mockOutbox.filter((m) => m.to === requesterPhone && m.template === "blood_request_answered"),
    ).toHaveLength(1);

    const mine = await api("GET", "/donor/requests", people.eligible!.token);
    expect(mine.data.items[0].myResponse).toBe("CAN_HELP");
  });

  it("hides the number again when the donor withdraws", async () => {
    const out = await api("POST", `/donor/requests/${id}/respond`, people.second!.token, {
      response: "CANNOT",
    });
    expect(out.status).toBe(200);
    const after = await view(id, key);
    expect(after.data.donors.map((d: { firstName: string }) => d.firstName)).toEqual(["Anil"]);
    expect(after.text).not.toContain(people.second!.phone);
  });

  it("does not let a donor in their waiting period say they can help", async () => {
    await prisma.donorProfile.update({
      where: { id: people.byCity!.donorId },
      data: { lastDonationAt: new Date(Date.now() - 5 * 86_400_000) },
    });
    const res = await api("POST", `/donor/requests/${id}/respond`, people.byCity!.token, {
      response: "CAN_HELP",
    });
    expect(res.status).toBe(409);
    expect(res.code).toBe("DONOR_NOT_ELIGIBLE");
    expect((await view(id, key)).text).not.toContain(people.byCity!.phone);
  });

  it("lets an alerted blood bank answer, and shows the requester its public number", async () => {
    const list = await api("GET", "/blood-bank/requests", nearBank.token);
    // Banks are told about every request near them, whatever the blood group.
    expect(list.data.items.map((r: { id: string }) => r.id)).toContain(id);
    expect(list.text).not.toContain(requesterPhone);
    expect((await api("GET", "/blood-bank/requests", farBank.token)).data.items).toEqual([]);
    expect(
      (
        await api("POST", `/blood-bank/requests/${id}/respond`, farBank.token, {
          response: "CAN_HELP",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("POST", `/blood-bank/requests/${id}/respond`, pendingBank.token, {
          response: "CAN_HELP",
        })
      ).code,
    ).toBe("BANK_NOT_VERIFIED");

    expect(
      (
        await api("POST", `/blood-bank/requests/${id}/respond`, nearBank.token, {
          response: "CAN_HELP",
        })
      ).status,
    ).toBe(200);
    const after = await view(id, key);
    expect(after.data.banks).toEqual([
      expect.objectContaining({ name: "Near Alert Bank", phone: nearBank.phone }),
    ]);
  });

  it("takes the numbers away when the request is closed, and refuses further answers", async () => {
    const closed = await api(
      "POST",
      `/blood/requests/${id}/close`,
      undefined,
      { outcome: "FULFILLED" },
      withKey(key),
    );
    expect(closed.data.request.status).toBe("FULFILLED");
    const after = await view(id, key);
    expect(after.data.request.status).toBe("FULFILLED");
    expect(after.data.donors).toHaveLength(1); // who helped is remembered...
    expect(after.data.donors[0].phone).toBeNull(); // ...but the number is gone
    expect(after.text).not.toContain(people.eligible!.phone);
    expect(after.data.banks[0].phone).toBeNull();

    expect(
      (
        await api("POST", `/donor/requests/${id}/respond`, people.byCity!.token, {
          response: "CAN_HELP",
        })
      ).code,
    ).toBe("REQUEST_CLOSED");
    expect((await api("GET", "/donor/requests", people.eligible!.token)).data.items).toEqual([]);
    const stillOpen = await api("GET", "/blood-bank/requests", nearBank.token);
    expect(stillOpen.data.items.map((r: { id: string }) => r.id)).not.toContain(id);
    // Closing again changes nothing.
    expect(
      (
        await api(
          "POST",
          `/blood/requests/${id}/close`,
          undefined,
          { outcome: "CANCELLED" },
          withKey(key),
        )
      ).data.request.status,
    ).toBe("FULFILLED");
    expect(
      (await api("POST", `/blood/requests/${id}/close`, undefined, { outcome: "FULFILLED" }))
        .status,
    ).toBe(404);
  });
});

describe("limits against misuse", () => {
  it("refuses a second open request for the same group and hospital", async () => {
    const phone = validPhone();
    const first = await makeRequest({ hospitalName: "Same Hospital", bloodGroup: "AB_NEG" }, phone);
    expect(first.res.status).toBe(201);
    const code = await codeFor(base, phone, "REQUEST");
    const dup = await api(
      "POST",
      "/blood/requests",
      undefined,
      requestBody(phone, code, { hospitalName: "same hospital", bloodGroup: "AB_NEG" }),
    );
    expect(dup.code).toBe("DUPLICATE_REQUEST");
  });

  it("stops one number from making more than three requests a day, before sending another code", async () => {
    const phone = validPhone();
    for (const [i, group] of (["A_POS", "A_NEG", "B_POS"] as const).entries()) {
      expect(
        (await makeRequest({ bloodGroup: group, hospitalName: "Limit Hospital " + i }, phone)).res
          .status,
      ).toBe(201);
    }
    await sentTo(phone, "none"); // flush anything still queued so only new code messages are counted
    const codesTo = () =>
      mockOutbox.filter((m) => m.to === phone && m.template === "otp_verify").length;
    const sentBefore = codesTo();
    const blocked = await api("POST", "/blood/otp", undefined, { phone, purpose: "REQUEST" });
    expect(blocked.status).toBe(429);
    expect(blocked.code).toBe("BLOOD_REQUEST_LIMIT");
    expect(codesTo()).toBe(sentBefore); // no code SMS was spent
  });

  it("does not wake the same donor more than twice a day", async () => {
    const city = "Fatigue" + Math.random().toString(36).slice(2, 6);
    const donor = await createDonor(created, { bloodGroup: "B_NEG", city, lat: null, lng: null });
    const alerted: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await makeRequest({
        bloodGroup: "B_NEG",
        city,
        latitude: null,
        longitude: null,
        hospitalName: "Fatigue Hospital " + i,
      });
      alerted.push(
        (await prisma.bloodRequest.findUniqueOrThrow({ where: { id: r.id } })).alertedDonors,
      );
    }
    expect(alerted).toEqual([1, 1, 0]);
    expect(await prisma.bloodRequestAlert.count({ where: { donorId: donor.donorId } })).toBe(2);
  });

  it("checks every field of a request", async () => {
    const phone = validPhone();
    created.phones.push(phone);
    const code = await codeFor(base, phone, "REQUEST");
    const bad = (over: Record<string, unknown>) =>
      api("POST", "/blood/requests", undefined, requestBody(phone, code, over));
    for (const over of [
      { unitsNeeded: 0 },
      { unitsNeeded: 11 },
      { radiusKm: 4 },
      { radiusKm: 51 },
      { bloodGroup: "Q_POS" },
      { hospitalName: "ab" },
      { latitude: 28.6, longitude: null },
      { note: "x".repeat(201) },
      { requesterName: "" },
      { urgency: "WHENEVER" },
    ]) {
      expect((await bad(over)).status, JSON.stringify(over)).toBe(400);
    }
    // None of those spent the code: the same code still works for a good request.
    expect((await bad({ hospitalName: "Good Hospital" })).status).toBe(201);
  });

  it("validates the code request itself", async () => {
    expect(
      (await api("POST", "/blood/otp", undefined, { phone: "123", purpose: "REQUEST" })).status,
    ).toBe(400);
    expect(
      (await api("POST", "/blood/otp", undefined, { phone: validPhone(), purpose: "SOMETHING" }))
        .status,
    ).toBe(400);
    expect((await api("POST", "/blood/otp", undefined, {})).status).toBe(400);
  });
});

describe("getting back into a request", () => {
  it("gives a new key after a code, and the old key stops working", async () => {
    const r = await makeRequest({ bloodGroup: "A_NEG", hospitalName: "Recovery Hospital" });
    expect((await view(r.id, r.key)).status).toBe(200);

    const code = await codeFor(base, r.phone, "RECOVERY");
    const wrong = await api("POST", "/blood/requests/recover", undefined, {
      phone: r.phone,
      code: code === "000000" ? "111111" : "000000",
    });
    expect(wrong.code).toBe("OTP_INVALID");
    const back = await api("POST", "/blood/requests/recover", undefined, { phone: r.phone, code });
    expect(back.data.items).toHaveLength(1);
    expect(back.data.items[0]).toMatchObject({ id: r.id, hospitalName: "Recovery Hospital" });
    const fresh = back.data.items[0].key as string;
    expect(fresh).not.toBe(r.key);
    expect((await view(r.id, r.key)).code).toBe("REQUEST_NOT_FOUND");
    expect((await view(r.id, fresh)).status).toBe(200);
    // A code made for a request cannot be used to recover one.
    const reqCode = await codeFor(base, r.phone, "REQUEST");
    expect(
      (await api("POST", "/blood/requests/recover", undefined, { phone: r.phone, code: reqCode }))
        .status,
    ).toBe(400);
  });

  it("answers the same for a number with no request, without sending any SMS", async () => {
    const phone = validPhone();
    created.phones.push(phone);
    await prisma.otpCode.deleteMany({ where: { phone } });
    const before = mockOutbox.length;
    const res = await api("POST", "/blood/otp", undefined, { phone, purpose: "RECOVERY" });
    expect(res.status).toBe(200);
    expect(res.data.sent).toBe(true);
    expect(mockOutbox.length).toBe(before); // nothing was sent, so nobody can learn who has asked for blood
    const attempt = await api("POST", "/blood/requests/recover", undefined, {
      phone,
      code: "123456",
    });
    expect(attempt.status).toBe(400);
  });
});

describe("when a request runs out of time or is stopped", () => {
  it("is treated as closed at once, and is marked expired by the job", async () => {
    const donor = await createDonor(created, {
      bloodGroup: "AB_POS",
      city: "Expiry" + Math.random().toString(36).slice(2, 5),
      lat: null,
      lng: null,
    });
    const r = await makeRequest({
      bloodGroup: "AB_POS",
      city: donor
        ? (await prisma.donorProfile.findUniqueOrThrow({ where: { id: donor.donorId } })).city
        : "x",
      latitude: null,
      longitude: null,
    });
    expect(r.res.status).toBe(201);
    await api("POST", `/donor/requests/${r.id}/respond`, donor.token, { response: "CAN_HELP" });
    expect((await view(r.id, r.key)).data.donors[0].phone).toBe(donor.phone);

    await prisma.bloodRequest.update({
      where: { id: r.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const after = await view(r.id, r.key);
    expect(after.data.request.status).toBe("EXPIRED");
    expect(after.data.donors[0].phone).toBeNull();
    expect(
      (await api("POST", `/donor/requests/${r.id}/respond`, donor.token, { response: "CANNOT" }))
        .code,
    ).toBe("REQUEST_CLOSED");
    expect((await api("GET", "/donor/requests", donor.token)).data.items).toEqual([]);

    expect(await expireBloodRequests()).toBeGreaterThanOrEqual(1);
    expect((await prisma.bloodRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      "EXPIRED",
    );
  });

  it("can be stopped by the platform admin, who sees only a masked number", async () => {
    const r = await makeRequest({ bloodGroup: "O_NEG", hospitalName: "Abuse Hospital" });
    const list = await api("GET", "/admin/blood-requests?status=OPEN&limit=100", admin);
    const row = list.data.items.find((i: { id: string }) => i.id === r.id);
    expect(row).toMatchObject({ bloodGroup: "O_NEG", status: "OPEN" });
    expect(row.requesterPhone).toMatch(/\*/);
    expect(list.text).not.toContain(r.phone);

    expect(
      (
        await api("POST", `/admin/blood-requests/${r.id}/cancel`, undefined, {
          reason: "Looks fake",
        })
      ).status,
    ).toBe(401);
    expect(
      (await api("POST", `/admin/blood-requests/${r.id}/cancel`, admin, { reason: "no" })).status,
    ).toBe(400);
    expect(
      (
        await api("POST", `/admin/blood-requests/${r.id}/cancel`, admin, {
          reason: "Looks fake to us",
        })
      ).status,
    ).toBe(200);
    expect((await view(r.id, r.key)).data.request.status).toBe("CANCELLED");
    expect(
      (
        await api("POST", `/admin/blood-requests/${r.id}/cancel`, admin, {
          reason: "Looks fake to us",
        })
      ).code,
    ).toBe("INVALID_STATUS");
    expect(
      await prisma.auditLog.count({
        where: { action: "blood_request.cancelled_by_admin", entityId: r.id },
      }),
    ).toBe(1);
  });
});

describe("a donor erasing their account", () => {
  it("removes the profile and answers, keeps the bank's donation record unlinked, and anonymises their own requests", async () => {
    const bank = await createBank(created, { name: "Erase Bank" });
    const donor = await createDonor(created, {
      bloodGroup: "B_POS",
      city: "Erasetown" + Math.random().toString(36).slice(2, 5),
      lat: null,
      lng: null,
    });
    const city = (await prisma.donorProfile.findUniqueOrThrow({ where: { id: donor.donorId } }))
      .city;

    // They donated once, and answered someone's request.
    await api("POST", "/blood-bank/donations", bank.token, {
      donorId: donor.donorId,
      bloodGroup: "B_POS",
    });
    // Their waiting period would keep them out of the alert: end it for this test, then they are asked.
    await prisma.donorProfile.update({
      where: { id: donor.donorId },
      data: { lastDonationAt: null },
    });
    const asker = await makeRequest({ bloodGroup: "B_POS", city, latitude: null, longitude: null });
    await api("POST", `/donor/requests/${asker.id}/respond`, donor.token, { response: "CAN_HELP" });
    expect((await view(asker.id, asker.key)).data.donors).toHaveLength(1);

    // And they made a request of their own with their own number.
    const own = await makeRequest(
      { bloodGroup: "O_POS", hospitalName: "Own Hospital" },
      donor.phone,
    );
    expect(own.res.status).toBe(201);

    const exported = await api("GET", "/patient/account/export", donor.token);
    expect(exported.data.donor).toMatchObject({ bloodGroup: "B_POS", city });
    expect(exported.data.donor.donations).toHaveLength(1);

    const erased = await api("POST", "/patient/account/erase", donor.token, { confirm: "ERASE" });
    expect(erased.status).toBe(200);

    expect(await prisma.donorProfile.count({ where: { userId: donor.userId } })).toBe(0);
    const record = await prisma.donation.findFirstOrThrow({ where: { bloodBankId: bank.bank.id } });
    expect(record).toMatchObject({ donorId: null, bloodGroup: "B_POS" }); // the bank keeps its record, unlinked
    const gone = await view(asker.id, asker.key);
    expect(gone.data.donors).toEqual([]);
    expect(gone.text).not.toContain(donor.phone);
    const mine = await prisma.bloodRequest.findUniqueOrThrow({ where: { id: own.id } });
    expect(mine).toMatchObject({
      requesterPhone: "[erased]",
      requesterName: "Erased patient",
      status: "CANCELLED",
      note: null,
    });
    const list = await api("GET", "/blood-bank/donations", bank.token);
    expect(list.data.items[0]).toMatchObject({ donorName: "Erased donor", donorPhone: null });
  });
});

describe("keeping requester details only as long as needed", () => {
  it("removes the name, number and note of old closed requests, and leaves recent and open ones alone", async () => {
    const old = await makeRequest({ bloodGroup: "A_POS", hospitalName: "Old Hospital" });
    const recent = await makeRequest({ bloodGroup: "B_POS", hospitalName: "Recent Hospital" });
    const open = await makeRequest({ bloodGroup: "AB_POS", hospitalName: "Open Hospital" });
    await api(
      "POST",
      `/blood/requests/${old.id}/close`,
      undefined,
      { outcome: "FULFILLED" },
      withKey(old.key),
    );
    await api(
      "POST",
      `/blood/requests/${recent.id}/close`,
      undefined,
      { outcome: "CANCELLED" },
      withKey(recent.key),
    );
    await prisma.bloodRequest.update({
      where: { id: old.id },
      data: { closedAt: new Date(Date.now() - 100 * 86_400_000) },
    });
    // An open request is never purged, however old.
    await prisma.bloodRequest.update({
      where: { id: open.id },
      data: { createdAt: new Date(Date.now() - 200 * 86_400_000) },
    });

    const purged = await purgeOldBloodRequests(new Date(), 90);
    expect(purged).toBeGreaterThanOrEqual(1);
    const gone = await prisma.bloodRequest.findUniqueOrThrow({ where: { id: old.id } });
    expect(gone).toMatchObject({
      requesterPhone: "[removed]",
      requesterName: "[removed]",
      note: null,
      createdIp: null,
      bloodGroup: "A_POS",
    });
    expect(await prisma.bloodRequestAlert.count({ where: { requestId: old.id } })).toBe(0);
    expect(
      (await prisma.bloodRequest.findUniqueOrThrow({ where: { id: recent.id } })).requesterPhone,
    ).toBe(recent.phone);
    expect(
      (await prisma.bloodRequest.findUniqueOrThrow({ where: { id: open.id } })).requesterPhone,
    ).toBe(open.phone);
    expect(await purgeOldBloodRequests(new Date(), 90)).toBe(0); // nothing left to do
    await prisma.bloodRequest.deleteMany({ where: { requesterPhone: "[removed]" } });
  });
});
