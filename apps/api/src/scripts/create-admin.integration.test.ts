import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { createPlatformAdmin } from "./create-admin-lib.js";

let server: Server;
let base: string;
const made: string[] = [];

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/v1";
});
afterAll(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 300));
  await prisma.auditLog.deleteMany({ where: { entityId: { in: made } } });
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

const login = (loginId: string, password: string) =>
  fetch(base + "/auth/staff/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, password }),
  });

describe("creating the first platform admin", () => {
  const loginId = "first.admin." + Date.now();

  it("makes an admin with a random temporary password that must be changed", async () => {
    const admin = await createPlatformAdmin({ loginId, name: "First Admin" });
    made.push(admin.id);
    expect(admin.temporaryPassword).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
      omit: { passwordHash: false },
    });
    expect(row).toMatchObject({
      role: "ADMIN",
      loginId,
      mustChangePassword: true,
      hospitalId: null,
    });
    expect(row.passwordHash).not.toContain(admin.temporaryPassword); // stored hashed, never as typed

    const res = await login(loginId, admin.temporaryPassword);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { user: { role: string; mustChangePassword: boolean }; accessToken: string };
    };
    expect(body.data.user).toMatchObject({ role: "ADMIN", mustChangePassword: true });

    // Until the password is changed, nothing else works.
    const stats = await fetch(base + "/admin/stats", {
      headers: { Authorization: "Bearer " + body.data.accessToken },
    });
    expect(stats.status).toBe(403);
    expect(((await stats.json()) as { error: { code: string } }).error.code).toBe(
      "PASSWORD_CHANGE_REQUIRED",
    );

    expect(
      await prisma.auditLog.count({
        where: { action: "admin.created_by_command_line", entityId: admin.id },
      }),
    ).toBe(1);
  });

  it("does not overwrite an existing login, and validates its input", async () => {
    await expect(createPlatformAdmin({ loginId, name: "Someone Else" })).rejects.toThrow(
      /already in use/,
    );
    await expect(createPlatformAdmin({ loginId: "x", name: "Too Short Id" })).rejects.toThrow(
      /3-64/,
    );
    await expect(createPlatformAdmin({ loginId: "valid.id.2", name: " " })).rejects.toThrow(
      /full name/,
    );
  });
});
