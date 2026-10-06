/**
 * Refund rules for cancelled appointments. Pure functions, configurable per hospital.
 *
 *  - Patient cancels at least `fullRefundHours` before the slot: 100%.
 *  - Patient cancels later (until online cancellation closes): `partialPercent`.
 *  - The hospital (or the system) cancels: always 100%, whatever the timing.
 *  - The patient doesn't turn up (no-show): 0%.
 *
 * Gateway fees are not returned by Razorpay on refunds; that cost stays with the platform.
 */

export interface RefundPolicy {
  /** Hours before the slot up to which a patient's cancellation is refunded in full. */
  fullRefundHours: number;
  /** Percent refunded for later patient cancellations. */
  partialPercent: number;
}

export type CancelInitiator = "PATIENT" | "HOSPITAL" | "SYSTEM" | "NO_SHOW";

export interface RefundDecision {
  /** Minor units (paise). */
  amount: number;
  /** 0-100 */
  percent: number;
}

const HOUR = 3_600_000;

export function refundDecision(input: {
  paidAmount: number;
  slotStart: Date;
  now: Date;
  policy: RefundPolicy;
  initiator: CancelInitiator;
}): RefundDecision {
  const { paidAmount, slotStart, now, policy, initiator } = input;
  let percent: number;
  if (initiator === "NO_SHOW") percent = 0;
  else if (initiator === "HOSPITAL" || initiator === "SYSTEM") percent = 100;
  else {
    const hoursBefore = (slotStart.getTime() - now.getTime()) / HOUR;
    percent = hoursBefore >= policy.fullRefundHours ? 100 : policy.partialPercent;
  }
  percent = Math.min(100, Math.max(0, Math.round(percent)));
  const amount = Math.min(paidAmount, Math.round((paidAmount * percent) / 100));
  return { amount, percent };
}

/** One-line description for patients: "Full refund until 24 hours before; 50% after that." */
export function describePolicy(policy: RefundPolicy): string {
  const after = policy.partialPercent === 0 ? "no refund" : `${policy.partialPercent}% refund`;
  if (policy.fullRefundHours <= 0)
    return `${after[0]!.toUpperCase()}${after.slice(1)} when you cancel.`;
  return `Full refund if you cancel at least ${policy.fullRefundHours} hours before; ${after} after that.`;
}
