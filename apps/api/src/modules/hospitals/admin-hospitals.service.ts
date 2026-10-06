import type { z } from "zod";
import { createDefaultSubscription } from "../subscriptions/subscription.service.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../../middleware/authenticate.js";
import { audit } from "../../utils/audit.js";
import { firstAvailable, slugify } from "../../utils/credentials.js";
import { AppError } from "../../utils/http.js";
import { paginate, toSkipTake } from "../../utils/pagination.js";
import type { RequestMeta } from "../../utils/request.js";
import {
  createStaffAccount,
  loginPrefix,
  resetStaffPassword,
  staffUserSelect,
} from "../staff/staff.service.js";
import {
  toHospitalDto,
  type adminUpdateHospitalSchema,
  type createHospitalSchema,
  type listHospitalsQuery,
} from "./hospitals.schemas.js";

const actorOf = (auth: AuthContext) => ({ userId: auth.userId, role: auth.role });

async function getHospitalOr404(id: string) {
  const hospital = await prisma.hospital.findUnique({ where: { id } });
  if (!hospital) throw AppError.notFound("Hospital not found");
  return hospital;
}

export async function listHospitals(q: z.output<typeof listHospitalsQuery>) {
  const where: Prisma.HospitalWhereInput = {
    status: q.status,
    ...(q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: "insensitive" } },
            { city: { contains: q.search, mode: "insensitive" } },
            { slug: { contains: q.search.toLowerCase() } },
          ],
        }
      : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.hospital.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...toSkipTake(q),
      include: {
        _count: { select: { doctors: true, departments: true } },
        users: {
          where: { role: "HOSPITAL_ADMIN" },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { loginId: true, mustChangePassword: true, lastLoginAt: true },
        },
      },
    }),
    prisma.hospital.count({ where }),
  ]);
  const items = rows.map(({ _count, users, ...h }) => ({
    ...toHospitalDto(h),
    doctorCount: _count.doctors,
    departmentCount: _count.departments,
    adminLogin: users[0] ?? null,
  }));
  return paginate(items, total, q);
}

export async function getHospitalDetail(id: string) {
  const hospital = await getHospitalOr404(id);
  const [staff, counts] = await Promise.all([
    prisma.user.findMany({
      where: { hospitalId: id },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: staffUserSelect,
    }),
    prisma.hospital.findUniqueOrThrow({
      where: { id },
      select: { _count: { select: { doctors: true, departments: true, appointments: true } } },
    }),
  ]);
  return { ...toHospitalDto(hospital), counts: counts._count, staff };
}

/**
 * Creates the hospital and its admin login in one transaction. The temporary
 * password is returned once and never stored in plain text.
 */
export async function createHospital(
  auth: AuthContext,
  input: z.output<typeof createHospitalSchema>,
  meta: RequestMeta,
) {
  return prisma.$transaction(async (tx) => {
    let slug: string;
    if (input.slug) {
      if (await tx.hospital.findUnique({ where: { slug: input.slug }, select: { id: true } })) {
        throw AppError.conflict("That URL slug is already in use", "SLUG_TAKEN");
      }
      slug = input.slug;
    } else {
      slug = await firstAvailable(slugify(input.name), async (s) =>
        Boolean(await tx.hospital.findUnique({ where: { slug: s }, select: { id: true } })),
      );
    }

    const { adminName, loginId, approve, ...fields } = input;
    const now = new Date();
    const hospital = await tx.hospital.create({
      data: {
        ...fields,
        slug,
        status: approve ? "ACTIVE" : "PENDING_APPROVAL",
        approvedAt: approve ? now : null,
        approvedById: approve ? auth.userId : null,
        createdById: auth.userId,
      },
    });

    const { user, credentials } = await createStaffAccount(tx, {
      role: "HOSPITAL_ADMIN",
      hospitalId: hospital.id,
      name: adminName ?? `${hospital.name} Admin`,
      loginId,
      loginIdBase: `${loginPrefix(slug)}.admin`,
      email: hospital.email,
      createdById: auth.userId,
    });

    await createDefaultSubscription(tx, hospital.id, auth.userId);

    await audit(tx, {
      actor: actorOf(auth),
      action: "hospital.created",
      entityType: "Hospital",
      entityId: hospital.id,
      hospitalId: hospital.id,
      after: toHospitalDto(hospital),
      meta,
    });
    await audit(tx, {
      actor: actorOf(auth),
      action: "credentials.issued",
      entityType: "User",
      entityId: user.id,
      hospitalId: hospital.id,
      metadata: { loginId: credentials.loginId, role: "HOSPITAL_ADMIN" },
      meta,
    });

    return { hospital: toHospitalDto(hospital), adminUser: user, credentials };
  });
}

export async function updateHospital(
  auth: AuthContext,
  id: string,
  input: z.output<typeof adminUpdateHospitalSchema>,
  meta: RequestMeta,
) {
  const before = await getHospitalOr404(id);
  const pending = before.status === "PENDING_APPROVAL";

  if (input.slug && input.slug !== before.slug) {
    if (!pending) {
      throw AppError.badRequest(
        "The URL slug can only be changed before approval (printed QR codes use it)",
        "SLUG_LOCKED",
      );
    }
    if (await prisma.hospital.findUnique({ where: { slug: input.slug }, select: { id: true } })) {
      throw AppError.conflict("That URL slug is already in use", "SLUG_TAKEN");
    }
  }
  if (input.currency && input.currency !== before.currency && !pending) {
    throw AppError.badRequest("Currency can only be changed before approval", "CURRENCY_LOCKED");
  }
  const totalBeds = input.totalBeds !== undefined ? input.totalBeds : before.totalBeds;
  const availableBeds =
    input.availableBeds !== undefined ? input.availableBeds : before.availableBeds;
  if (totalBeds != null && availableBeds != null && availableBeds > totalBeds) {
    throw AppError.badRequest("Available beds cannot exceed total beds", "INVALID_BEDS");
  }

  const bedsChanged = input.totalBeds !== undefined || input.availableBeds !== undefined;
  return prisma.$transaction(async (tx) => {
    const after = await tx.hospital.update({
      where: { id },
      data: { ...input, ...(bedsChanged ? { bedsUpdatedAt: new Date() } : {}) },
    });
    await audit(tx, {
      actor: actorOf(auth),
      action: "hospital.updated",
      entityType: "Hospital",
      entityId: id,
      hospitalId: id,
      before: toHospitalDto(before),
      after: toHospitalDto(after),
      meta,
    });
    return toHospitalDto(after);
  });
}

export async function approveHospital(auth: AuthContext, id: string, meta: RequestMeta) {
  const before = await getHospitalOr404(id);
  if (before.status !== "PENDING_APPROVAL") {
    throw AppError.conflict(
      `Hospital is ${before.status.toLowerCase()}, not pending`,
      "INVALID_STATUS",
    );
  }
  return prisma.$transaction(async (tx) => {
    const after = await tx.hospital.update({
      where: { id },
      data: { status: "ACTIVE", approvedAt: new Date(), approvedById: auth.userId },
    });
    await audit(tx, {
      actor: actorOf(auth),
      action: "hospital.approved",
      entityType: "Hospital",
      entityId: id,
      hospitalId: id,
      before: { status: before.status },
      after: { status: after.status },
      meta,
    });
    return toHospitalDto(after);
  });
}

/**
 * Blocking takes effect immediately: `authenticate` rejects every staff
 * request for a blocked hospital and refresh tokens stop working.
 */
export async function blockHospital(
  auth: AuthContext,
  id: string,
  reason: string,
  meta: RequestMeta,
) {
  const before = await getHospitalOr404(id);
  if (before.status === "BLOCKED")
    throw AppError.conflict("Hospital is already blocked", "INVALID_STATUS");
  return prisma.$transaction(async (tx) => {
    const after = await tx.hospital.update({
      where: { id },
      data: { status: "BLOCKED", blockedAt: new Date(), blockedReason: reason },
    });
    await tx.refreshToken.updateMany({
      where: { user: { hospitalId: id }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit(tx, {
      actor: actorOf(auth),
      action: "hospital.blocked",
      entityType: "Hospital",
      entityId: id,
      hospitalId: id,
      before: { status: before.status },
      after: { status: after.status },
      metadata: { reason },
      meta,
    });
    return toHospitalDto(after);
  });
}

export async function unblockHospital(auth: AuthContext, id: string, meta: RequestMeta) {
  const before = await getHospitalOr404(id);
  if (before.status !== "BLOCKED")
    throw AppError.conflict("Hospital is not blocked", "INVALID_STATUS");
  return prisma.$transaction(async (tx) => {
    const after = await tx.hospital.update({
      where: { id },
      data: {
        status: before.approvedAt ? "ACTIVE" : "PENDING_APPROVAL",
        blockedAt: null,
        blockedReason: null,
      },
    });
    await audit(tx, {
      actor: actorOf(auth),
      action: "hospital.unblocked",
      entityType: "Hospital",
      entityId: id,
      hospitalId: id,
      before: { status: before.status },
      after: { status: after.status },
      meta,
    });
    return toHospitalDto(after);
  });
}

/** New temporary password for a hospital admin (forgotten password, handover). */
export async function resetHospitalCredentials(
  auth: AuthContext,
  hospitalId: string,
  userId: string | undefined,
  meta: RequestMeta,
) {
  await getHospitalOr404(hospitalId);
  const target = await prisma.user.findFirst({
    where: { hospitalId, role: "HOSPITAL_ADMIN", ...(userId ? { id: userId } : {}) },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!target) throw AppError.notFound("Hospital admin account not found");

  return prisma.$transaction(async (tx) => {
    const credentials = await resetStaffPassword(tx, target.id);
    await audit(tx, {
      actor: actorOf(auth),
      action: "credentials.reset",
      entityType: "User",
      entityId: target.id,
      hospitalId,
      metadata: { loginId: credentials.loginId, role: "HOSPITAL_ADMIN" },
      meta,
    });
    return credentials;
  });
}
