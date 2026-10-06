import type { BloodBank, BloodStock } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { toLocalDate } from "../../utils/time.js";
import { BLOOD_GROUPS, stockIsStale } from "./blood-rules.js";

/** What a blood bank's own staff see (including the verification outcome). */
export function toOwnBankDto(b: BloodBank) {
  return {
    id: b.id,
    name: b.name,
    licenseNumber: b.licenseNumber,
    licenseAuthority: b.licenseAuthority,
    licenseValidUntil: b.licenseValidUntil ? toLocalDate(b.licenseValidUntil) : null,
    status: b.status,
    phone: b.phone,
    email: b.email,
    addressLine1: b.addressLine1,
    city: b.city,
    state: b.state,
    postalCode: b.postalCode,
    latitude: b.latitude,
    longitude: b.longitude,
    is24x7: b.is24x7,
    operatingHours: b.operatingHours,
    verifiedAt: b.verifiedAt,
    rejectedReason: b.rejectedReason,
    blockedReason: b.blockedReason,
    createdAt: b.createdAt,
  };
}

type StockRow = Pick<BloodStock, "bloodGroup" | "units" | "updatedAt">;

/** Stock for all eight groups (zero when never reported), with a freshness flag. */
export function stockSummary(rows: StockRow[], now = new Date()) {
  return BLOOD_GROUPS.map((group) => {
    const row = rows.find((r) => r.bloodGroup === group);
    return {
      bloodGroup: group,
      units: row?.units ?? 0,
      updatedAt: row?.updatedAt ?? null,
      stale: stockIsStale(row?.updatedAt ?? null, now, env.BLOOD_STOCK_STALE_HOURS),
    };
  });
}

/** What the public sees of a listed bank: contact details and stock, never staff or internals. */
export function toPublicBankDto(
  b: BloodBank,
  stock: StockRow[],
  distanceKm: number | null,
  now = new Date(),
) {
  const summary = stockSummary(stock, now);
  const latest = stock.reduce<Date | null>(
    (l, r) => (!l || r.updatedAt > l ? r.updatedAt : l),
    null,
  );
  return {
    id: b.id,
    name: b.name,
    licenseNumber: b.licenseNumber,
    verifiedAt: b.verifiedAt,
    phone: b.phone,
    addressLine1: b.addressLine1,
    city: b.city,
    state: b.state,
    latitude: b.latitude,
    longitude: b.longitude,
    is24x7: b.is24x7,
    operatingHours: b.operatingHours,
    distanceKm,
    stock: summary,
    stockUpdatedAt: latest,
    stockStale: summary.every((s) => s.stale),
  };
}
