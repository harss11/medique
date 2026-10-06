import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { BloodGroup, BloodBankStatus, Gender } from "../src/generated/prisma/client.js";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { signAccessToken } from "../src/modules/auth/tokens.js";
import { dispatchNotifications } from "../src/modules/notifications/notifications.service.js";
import { mockOutbox } from "../src/services/sms/index.js";
import { randomToken } from "../src/utils/crypto.js";
import { normalizeMobile } from "../src/utils/phone.js";

/** Test helpers for the blood bank module: a server, valid phones, OTP codes, builders and cleanup. */

export interface Created {
  userIds: string[];
  bankIds: string[];
  phones: string[];
}
export const newCreated = (): Created => ({ userIds: [], bankIds: [], phones: [] });

export async function startServer() {
  const server: Server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/v1";
  return {
    base,
    close: async () => {
      server.close();
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

export interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: the shape depends on the endpoint
  data: any;
  code?: string;
  message?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
  details?: any;
  text: string;
}

export async function call(
  base: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: {
    data?: unknown;
    error?: { code: string; message: string; details?: unknown };
  } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return {
    status: res.status,
    data: json?.data,
    code: json?.error?.code,
    message: json?.error?.message,
    details: json?.error?.details,
    text,
  };
}

let phoneSeq = Math.floor(Math.random() * 90_000);

/** A random Indian mobile number that passes the same validation the API applies. */
export function validPhone(): string {
  for (;;) {
    phoneSeq = (phoneSeq + 7919) % 100_000;
    const phone = normalizeMobile(
      "98" +
        String(phoneSeq).padStart(5, "0") +
        String(Math.floor(Math.random() * 1000)).padStart(3, "0"),
    );
    if (phone) return phone;
  }
}

export const tokenFor = (userId: string, role: "PATIENT" | "ADMIN" | "BLOOD_BANK_STAFF") =>
  signAccessToken({ id: userId, role, hospitalId: null, tokenVersion: 0 }).token;

/** The six-digit code most recently sent to a phone (the mock provider keeps what it was asked to send). */
export function lastOtp(phone: string): string {
  const sent = mockOutbox.filter(
    (m) => m.to === phone && (m.template === "otp_login" || m.template === "otp_verify"),
  );
  const code = sent[sent.length - 1]?.variables?.otp;
  if (!code) throw new Error("No code was sent to " + phone);
  return code;
}

/** Asks for a code through the API (clearing the per-number cooldown first so tests can repeat) and returns it. */
export async function codeFor(
  base: string,
  phone: string,
  purpose: "REQUEST" | "BANK_REGISTRATION" | "RECOVERY",
): Promise<string> {
  await prisma.otpCode.deleteMany({ where: { phone } });
  const res = await call(base, "POST", "/blood/otp", undefined, { phone, purpose });
  if (res.status !== 200) throw new Error("OTP request failed: " + res.text);
  return lastOtp(phone);
}

/** Sends every queued message now and returns what was sent to a phone, by template. */
export async function sentTo(phone: string, template: string) {
  await dispatchNotifications(500);
  return mockOutbox.filter((m) => m.to === phone && m.template === template);
}

export async function createAdmin(c: Created): Promise<string> {
  const user = await prisma.user.create({
    data: {
      role: "ADMIN",
      name: "Blood Admin",
      loginId:
        "blood-admin-" +
        randomToken(4)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "x"),
    },
  });
  c.userIds.push(user.id);
  return tokenFor(user.id, "ADMIN");
}

export async function createBank(
  c: Created,
  o: {
    status?: BloodBankStatus;
    city?: string;
    lat?: number | null;
    lng?: number | null;
    name?: string;
  } = {},
) {
  const tag = randomToken(4)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "x");
  const phone = validPhone();
  const bank = await prisma.bloodBank.create({
    data: {
      name: o.name ?? "Test Blood Bank " + tag,
      licenseNumber: "LIC-" + tag.toUpperCase(),
      status: o.status ?? "ACTIVE",
      phone,
      addressLine1: "1 Test Road",
      city: o.city ?? "Testville",
      latitude: o.lat === undefined ? 28.62 : o.lat,
      longitude: o.lng === undefined ? 77.21 : o.lng,
      verifiedAt: (o.status ?? "ACTIVE") === "ACTIVE" ? new Date() : null,
    },
  });
  const staff = await prisma.user.create({
    data: {
      role: "BLOOD_BANK_STAFF",
      name: "Staff " + tag,
      loginId: "bank-" + tag,
      bloodBankId: bank.id,
    },
  });
  c.bankIds.push(bank.id);
  c.userIds.push(staff.id);
  c.phones.push(phone);
  return { bank, staff, token: tokenFor(staff.id, "BLOOD_BANK_STAFF"), phone };
}

export async function createDonor(
  c: Created,
  o: {
    bloodGroup?: BloodGroup;
    gender?: Gender;
    dateOfBirth?: string;
    city?: string;
    lat?: number | null;
    lng?: number | null;
    isAvailable?: boolean;
    lastDonationAt?: Date | null;
    name?: string;
  } = {},
) {
  const phone = validPhone();
  const user = await prisma.user.create({
    data: {
      role: "PATIENT",
      name:
        o.name ??
        "Donor " +
          randomToken(3)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "x"),
      phone,
      donorProfile: {
        create: {
          bloodGroup: o.bloodGroup ?? "O_POS",
          gender: o.gender ?? "MALE",
          dateOfBirth: new Date((o.dateOfBirth ?? "1990-01-01") + "T00:00:00Z"),
          city: o.city ?? "Testville",
          latitude: o.lat === undefined ? 28.62 : o.lat,
          longitude: o.lng === undefined ? 77.21 : o.lng,
          isAvailable: o.isAvailable ?? true,
          lastDonationAt: o.lastDonationAt ?? null,
          alertsConsentAt: new Date(),
          alertsConsentVersion: "test",
        },
      },
    },
    include: { donorProfile: true },
  });
  c.userIds.push(user.id);
  c.phones.push(phone);
  return {
    userId: user.id,
    donorId: user.donorProfile!.id,
    phone,
    token: tokenFor(user.id, "PATIENT"),
    name: user.name,
  };
}

/** Removes everything a test created, in an order the foreign keys allow. */
export async function cleanupBlood(c: Created): Promise<void> {
  const requests = await prisma.bloodRequest.findMany({
    where: { requesterPhone: { in: c.phones } },
    select: { id: true },
  });
  const requestIds = requests.map((r) => r.id);
  const donations = await prisma.donation.findMany({
    where: { bloodBankId: { in: c.bankIds } },
    select: { id: true },
  });
  const entityIds = [...c.bankIds, ...requestIds, ...donations.map((d) => d.id), ...c.userIds];

  await prisma.notificationLog.deleteMany({
    where: {
      OR: [
        { userId: { in: c.userIds } },
        { to: { in: c.phones } },
        {
          groupKey: {
            in: requestIds.flatMap((id) => [
              "blood-request:" + id,
              "blood-request:" + id + ":answered",
            ]),
          },
        },
      ],
    },
  });
  await prisma.bloodRequest.deleteMany({ where: { id: { in: requestIds } } }); // alerts and answers go with them
  await prisma.donation.deleteMany({ where: { bloodBankId: { in: c.bankIds } } });
  await prisma.donorProfile.deleteMany({ where: { userId: { in: c.userIds } } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ actorId: { in: c.userIds } }, { entityId: { in: entityIds } }] },
  });
  await prisma.otpCode.deleteMany({ where: { phone: { in: c.phones } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: c.userIds } } });
  await prisma.bloodStock.deleteMany({ where: { bloodBankId: { in: c.bankIds } } });
  await prisma.user.deleteMany({ where: { id: { in: c.userIds } } });
  await prisma.bloodBank.deleteMany({ where: { id: { in: c.bankIds } } });
}
