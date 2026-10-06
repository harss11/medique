import { PDFDocument, rgb } from "pdf-lib";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../../middleware/authenticate.js";
import { drawText, loadFonts, textWidth, wrapText } from "../../services/pdf/fonts.js";
import { AppError } from "../../utils/http.js";
import { formatDateShort, formatTimeShort } from "../../utils/time.js";

const TEAL = rgb(0.059, 0.463, 0.431);
const INK = rgb(0.06, 0.09, 0.16);
const GREY = rgb(0.4, 0.45, 0.52);
const LINE = rgb(0.85, 0.87, 0.9);
const RED = rgb(0.75, 0.15, 0.15);

/** "₹1,250.00" for INR (Noto Sans has the glyph), "USD 5.00" otherwise. */
export function formatMoneyPdf(minor: number, currency: string): string {
  if (currency === "INR") {
    return `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

const METHOD_LABEL: Record<string, string> = {
  upi: "UPI",
  card: "Card",
  netbanking: "Net banking",
  wallet: "Wallet",
  emi: "EMI",
};

/** "MQ-202610-3F9A21BC": unique, readable, and not guessable from other receipts. */
export function receiptNumber(paymentId: string, paidAt: Date): string {
  const ym = paidAt.toISOString().slice(0, 7).replace("-", "");
  return `MQ-${ym}-${paymentId.replace(/-/g, "").slice(-8).toUpperCase()}`;
}

/**
 * Receipt for a patient's own paid appointment. Shows refunds if there were any.
 * Never includes the platform commission (that is between MediQ and the hospital).
 */
export async function generateReceipt(auth: AuthContext, appointmentId: string) {
  const appt = await prisma.appointment.findFirst({
    where: { id: appointmentId, bookedById: auth.userId },
    include: {
      hospital: {
        select: {
          name: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          postalCode: true,
          phone: true,
          timezone: true,
        },
      },
      doctor: { select: { name: true, qualification: true } },
      department: { select: { name: true } },
      patientProfile: { select: { fullName: true } },
      payments: {
        where: { status: { in: ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { refunds: { where: { status: "PROCESSED" }, orderBy: { createdAt: "asc" } } },
      },
    },
  });
  const payment = appt?.payments[0];
  if (!appt || !payment || !payment.paidAt)
    throw AppError.notFound("No receipt is available for this appointment");

  const tz = appt.hospital.timezone;
  const number = receiptNumber(payment.id, payment.paidAt);
  const isTest = payment.provider === "MOCK";

  const doc = await PDFDocument.create();
  doc.setTitle(`Receipt ${number}`);
  doc.setAuthor("MediQ");
  doc.setCreationDate(new Date());
  // Only embed the Hindi fonts when something on the receipt actually needs them.
  const fonts = await loadFonts(doc, {
    text: [
      appt.patientProfile.fullName,
      appt.doctor.name,
      appt.doctor.qualification,
      appt.department.name,
      appt.hospital.name,
      appt.hospital.addressLine1,
      appt.hospital.addressLine2,
      appt.hospital.city,
      appt.hospital.state,
    ]
      .filter(Boolean)
      .join(" "),
  });
  const page = doc.addPage([595.28, 841.89]); // A4
  const M = 48;
  const W = page.getWidth();
  const right = W - M;
  let y = page.getHeight() - M;

  // Drawn first so it sits behind the text.
  if (isTest) {
    drawText(page, "TEST RECEIPT - NOT VALID", {
      x: M + 40,
      y: page.getHeight() / 2 - 40,
      size: 46,
      fonts,
      bold: true,
      color: rgb(0.93, 0.85, 0.85),
    });
  }

  const text = (
    s: string,
    x: number,
    size: number,
    opts: { bold?: boolean; color?: ReturnType<typeof rgb>; align?: "left" | "right" } = {},
  ) =>
    drawText(page, s, {
      x,
      y,
      size,
      fonts,
      bold: opts.bold,
      color: opts.color ?? INK,
      align: opts.align,
    });
  const rule = () =>
    page.drawLine({ start: { x: M, y }, end: { x: right, y }, thickness: 0.7, color: LINE });

  // Header
  text("MediQ", M, 22, { bold: true, color: TEAL });
  text("Payment receipt", right, 14, { bold: true, align: "right" });
  y -= 18;
  text("Doctor appointments", M, 9, { color: GREY });
  text(`Receipt no. ${number}`, right, 9, { color: GREY, align: "right" });
  y -= 14;
  text(
    `Date ${formatDateShort(payment.paidAt, tz)} ${payment.paidAt.getFullYear()}, ${formatTimeShort(payment.paidAt, tz)}`,
    right,
    9,
    { color: GREY, align: "right" },
  );
  y -= 18;
  rule();
  y -= 26;

  // Hospital
  text("HOSPITAL", M, 8, { bold: true, color: GREY });
  y -= 15;
  text(appt.hospital.name, M, 13, { bold: true });
  const address = [
    appt.hospital.addressLine1,
    appt.hospital.addressLine2,
    [appt.hospital.city, appt.hospital.state].filter(Boolean).join(", "),
    appt.hospital.postalCode,
  ]
    .filter(Boolean)
    .join(", ");
  for (const line of wrapText(address, W - 2 * M, 10, fonts)) {
    y -= 14;
    text(line, M, 10, { color: GREY });
  }
  if (appt.hospital.phone) {
    y -= 14;
    text(`Phone ${appt.hospital.phone}`, M, 10, { color: GREY });
  }
  y -= 28;

  // Appointment details, two columns
  text("APPOINTMENT", M, 8, { bold: true, color: GREY });
  y -= 18;
  const colB = M + (W - 2 * M) / 2;
  const field = (label: string, value: string, x: number) => {
    text(label, x, 8.5, { color: GREY });
    y -= 13;
    const lines = wrapText(value, (W - 2 * M) / 2 - 12, 11, fonts, true);
    for (const l of lines) {
      text(l, x, 11, { bold: true });
      y -= 14;
    }
    return lines.length * 14 + 13;
  };
  const top = y;
  const h1 = field("Patient", appt.patientProfile.fullName, M);
  y = top;
  field(
    "Date and time",
    `${formatDateShort(appt.slotStart, tz)} ${appt.appointmentDate.getUTCFullYear()}, ${formatTimeShort(appt.slotStart, tz)}`,
    colB,
  );
  y = top - Math.max(h1, 40) - 8;
  const top2 = y;
  const h2 = field(
    "Doctor",
    `${appt.doctor.name}${appt.doctor.qualification ? `, ${appt.doctor.qualification}` : ""}`,
    M,
  );
  y = top2;
  field("Department", appt.department.name, colB);
  y = top2 - Math.max(h2, 40) - 8;
  field("Token number", appt.tokenNumber != null ? String(appt.tokenNumber) : "-", M);
  y -= 6;
  rule();
  y -= 24;

  // Charges
  text("DESCRIPTION", M, 8, { bold: true, color: GREY });
  text("AMOUNT", right, 8, { bold: true, color: GREY, align: "right" });
  y -= 18;
  text(`Consultation fee, ${appt.doctor.name}`, M, 11);
  text(formatMoneyPdf(payment.amount, payment.currency), right, 11, { align: "right" });
  y -= 12;
  rule();
  y -= 18;
  text("Amount paid", M, 11, { bold: true });
  text(formatMoneyPdf(payment.amount, payment.currency), right, 12, { bold: true, align: "right" });

  for (const refund of payment.refunds) {
    y -= 18;
    const when = refund.processedAt ? `${formatDateShort(refund.processedAt, tz)}` : "";
    text(
      `Refunded${refund.percent != null && refund.percent < 100 ? ` (${refund.percent}%)` : ""}${when ? `, ${when}` : ""}`,
      M,
      10.5,
      { color: RED },
    );
    text(`- ${formatMoneyPdf(refund.amount, payment.currency)}`, right, 10.5, {
      color: RED,
      align: "right",
    });
  }
  if (payment.refundedAmount > 0) {
    y -= 8;
    rule();
    y -= 18;
    text("Net amount paid", M, 11, { bold: true });
    text(formatMoneyPdf(payment.amount - payment.refundedAmount, payment.currency), right, 12, {
      bold: true,
      align: "right",
    });
  }
  y -= 34;

  // Payment details
  text("PAYMENT", M, 8, { bold: true, color: GREY });
  y -= 16;
  const method = payment.providerMethod
    ? (METHOD_LABEL[payment.providerMethod] ?? payment.providerMethod)
    : "Online";
  text(isTest ? "Test payment (no real money was charged)" : `Paid online (${method})`, M, 10.5);
  if (payment.razorpayPaymentId) {
    y -= 14;
    text(`Reference ${payment.razorpayPaymentId}`, M, 9.5, { color: GREY });
  }
  y -= 14;
  text(`Appointment ${appt.id}`, M, 8.5, { color: GREY });

  // Footer
  const footer = "This is a computer-generated receipt and does not need a signature.";
  drawText(page, footer, {
    x: W / 2 - textWidth(footer, 8.5, fonts) / 2,
    y: M,
    size: 8.5,
    fonts,
    color: GREY,
  });

  const bytes = await doc.save();
  return { filename: `receipt-${number}.pdf`, bytes };
}
