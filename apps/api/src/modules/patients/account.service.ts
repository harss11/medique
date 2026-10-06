import { Prisma } from "../../generated/prisma/client.js";
import { prisma, type TxClient } from "../../lib/prisma.js";
import { audit } from "../../utils/audit.js";
import { AppError } from "../../utils/http.js";
import type { RequestMeta } from "../../utils/request.js";
import { advisoryLock } from "../appointments/booking.service.js";
import { mine } from "./account.export.js";

export { exportAccount } from "./account.export.js";

/**
 * Erasure under the DPDP Act. It removes what identifies the person (name, phone, date of
 * birth, messages, device and IP records) and signs them out everywhere, but keeps what the
 * hospital and the law require: the appointment, its fee and its payment and refund records,
 * without the person's details. See docs/BACKUP-RESTORE.md for how long backups keep copies.
 */

const ACTIVE = ["CONFIRMED", "CHECKED_IN", "IN_PROGRESS"] as const;
const ERASED_NAME = "Erased patient";

/** What stops an erasure right now (empty when it can go ahead). */
async function blockers(tx: TxClient, userId: string): Promise<string[]> {
  const now = new Date();
  const [upcoming, holds, refunds] = await Promise.all([
    tx.appointment.count({
      where: { ...mine(userId), status: { in: [...ACTIVE] }, slotEnd: { gt: now } },
    }),
    tx.appointment.count({
      where: { ...mine(userId), status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } },
    }),
    tx.refund.count({
      where: { status: { in: ["PENDING", "FAILED"] }, payment: { appointment: mine(userId) } },
    }),
  ]);
  const reasons: string[] = [];
  if (upcoming + holds > 0) {
    reasons.push("You have an upcoming appointment or a slot on hold. Cancel it first.");
  }
  if (refunds > 0)
    reasons.push("A refund is still on its way to you. Try again once it has arrived.");
  return reasons;
}

/** Anonymises the patient's account. Throws 409 ERASE_BLOCKED while something is still open. */
export async function eraseAccount(userId: string, meta: RequestMeta): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // The same lock the booking engine takes, so no booking can start while we erase.
      await advisoryLock(tx, `patient:${userId}`);

      const reasons = await blockers(tx, userId);
      if (reasons.length) throw new AppError(409, "ERASE_BLOCKED", reasons.join(" "), { reasons });

      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { phone: true },
      });
      const profiles = await tx.patientProfile.findMany({
        where: { userId },
        select: { id: true },
      });
      const profileIds = profiles.map((p) => p.id);

      if (user.phone) await tx.otpCode.deleteMany({ where: { phone: user.phone } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.waitlistEntry.deleteMany({ where: { userId } });
      // A donor profile goes with its alerts and answers; donation records stay with the blood bank,
      // no longer linked to a person (the link is set to null by the database).
      await tx.donorProfile.deleteMany({ where: { userId } });
      // Blood requests made with this phone number: close any still open and remove who they were.
      if (user.phone) {
        await tx.bloodRequest.updateMany({
          where: { requesterPhone: user.phone, status: "OPEN" },
          data: { status: "CANCELLED", closedAt: new Date() },
        });
        await tx.bloodRequest.updateMany({
          where: { requesterPhone: user.phone },
          data: {
            requesterPhone: "[erased]",
            requesterName: ERASED_NAME,
            note: null,
            createdIp: null,
          },
        });
      }
      await tx.review.deleteMany({ where: { userId } });
      await tx.waitlistEntry.deleteMany({ where: { userId } });

      await tx.patientProfile.updateMany({
        where: { id: { in: profileIds } },
        data: {
          fullName: ERASED_NAME,
          dateOfBirth: null,
          gender: null,
          bloodGroup: null,
          phone: null,
          deletedAt: new Date(),
        },
      });
      await tx.appointment.updateMany({
        where: mine(userId),
        data: { reasonForVisit: null, cancelReason: null },
      });
      // Messages carry the patient's name and number; keep only that they were sent.
      await tx.notificationLog.updateMany({
        where: { OR: [{ userId }, { appointment: mine(userId) }] },
        data: { to: "[erased]", templateVars: Prisma.DbNull, error: null },
      });
      await tx.consentRecord.updateMany({ where: { userId }, data: { ip: null, userAgent: null } });
      await tx.auditLog.updateMany({
        where: { actorId: userId },
        data: { ip: null, userAgent: null },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          name: ERASED_NAME,
          phone: null,
          email: null,
          status: "BLOCKED",
          // Every access token already issued stops working at once.
          tokenVersion: { increment: 1 },
        },
      });

      await audit(tx, {
        actor: { userId, role: "PATIENT" },
        action: "patient.erased",
        entityType: "User",
        entityId: userId,
        metadata: { profiles: profileIds.length },
        meta,
      });
    },
    { timeout: 20_000 },
  );
}
