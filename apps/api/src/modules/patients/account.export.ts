import { prisma } from "../../lib/prisma.js";
import { toLocalDate } from "../../utils/time.js";

const MAX_EXPORT_ROWS = 5000;

/** Appointments a patient booked or that are for one of their profiles. */
export const mine = (userId: string) => ({
  OR: [{ bookedById: userId }, { patientProfile: { userId } }],
});

/** Everything MediQ holds about this patient, as one document they can keep (right of access). */
export async function exportAccount(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { name: true, phone: true, email: true, createdAt: true },
  });
  const [consents, profiles, appointments, donor, reviews] = await Promise.all([
    prisma.consentRecord.findMany({
      where: { userId },
      orderBy: { acceptedAt: "asc" },
      select: { type: true, version: true, acceptedAt: true },
    }),
    prisma.patientProfile.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: {
        relation: true,
        fullName: true,
        dateOfBirth: true,
        gender: true,
        bloodGroup: true,
        phone: true,
        createdAt: true,
        deletedAt: true,
      },
    }),
    prisma.appointment.findMany({
      where: mine(userId),
      orderBy: { createdAt: "asc" },
      take: MAX_EXPORT_ROWS,
      select: {
        status: true,
        source: true,
        appointmentDate: true,
        slotStart: true,
        tokenNumber: true,
        reasonForVisit: true,
        feeAmount: true,
        currency: true,
        createdAt: true,
        cancelledAt: true,
        cancelReason: true,
        hospital: { select: { name: true } },
        doctor: { select: { name: true } },
        department: { select: { name: true } },
        patientProfile: { select: { fullName: true } },
        payments: {
          select: {
            amount: true,
            currency: true,
            status: true,
            method: true,
            paidAt: true,
            refundedAmount: true,
            refunds: { select: { amount: true, status: true, processedAt: true } },
          },
        },
      },
    }),
    prisma.donorProfile.findUnique({
      where: { userId },
      select: {
        bloodGroup: true,
        gender: true,
        dateOfBirth: true,
        city: true,
        isAvailable: true,
        lastDonationAt: true,
        alertsConsentAt: true,
        createdAt: true,
        donations: {
          where: { voidedAt: null },
          orderBy: { donatedAt: "asc" },
          select: {
            donatedAt: true,
            bloodGroup: true,
            volumeMl: true,
            bloodBank: { select: { name: true, city: true } },
          },
        },
      },
    }),
    prisma.review.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: {
        rating: true,
        comment: true,
        createdAt: true,
        isPublished: true,
        hospital: { select: { name: true } },
        doctor: { select: { name: true } },
      },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    account: user,
    consents,
    reviews: reviews.map(({ hospital, doctor, ...r }) => ({
      ...r,
      hospital: hospital.name,
      doctor: doctor.name,
    })),
    donor: donor ? { ...donor, dateOfBirth: toLocalDate(donor.dateOfBirth) } : null,
    profiles: profiles.map((p) => ({
      ...p,
      dateOfBirth: p.dateOfBirth ? toLocalDate(p.dateOfBirth) : null,
    })),
    appointments: appointments.map((a) => ({
      status: a.status,
      source: a.source,
      date: toLocalDate(a.appointmentDate),
      time: a.slotStart,
      token: a.tokenNumber,
      hospital: a.hospital.name,
      doctor: a.doctor.name,
      department: a.department.name,
      patient: a.patientProfile.fullName,
      reasonForVisit: a.reasonForVisit,
      fee: a.feeAmount,
      currency: a.currency,
      bookedAt: a.createdAt,
      cancelledAt: a.cancelledAt,
      cancelReason: a.cancelReason,
      payments: a.payments,
    })),
    note:
      appointments.length >= MAX_EXPORT_ROWS
        ? "Only the first " +
          MAX_EXPORT_ROWS +
          " appointments are included. Contact support for the rest."
        : undefined,
  };
}
