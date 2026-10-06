"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import type { Appointment } from "@/lib/types";
import { Alert, Button, Card, Spinner } from "../ui";

/** What POST /appointments/:id/payment-order returns. */
type PaymentOrder =
  | { mode: "mock" }
  | {
      mode: "razorpay";
      keyId: string;
      orderId: string;
      amount: number;
      currency: string;
      name: string;
      description: string;
      prefill: { name: string; contact: string };
    };

interface RazorpayCheckout {
  open(): void;
  on(
    event: "payment.failed",
    handler: (response: { error: { description?: string } }) => void,
  ): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckout;
  }
}

/** Loads Razorpay's checkout script the first time it is needed. */
function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("Could not load the payment window. Check your connection and try again."));
    document.head.appendChild(script);
  });
}

/** Seconds left until `iso`, ticking every second. */
function useSecondsLeft(iso: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000)) : 0;
}

/**
 * Shown while a slot is held for a patient (5 minutes).
 *
 * This page only STARTS a payment. After the Razorpay window reports success it waits for
 * the server to say the booking is confirmed, which happens only when Razorpay's signed
 * webhook arrives: nothing the browser claims can confirm a booking.
 */
export function PayPanel({
  appointment,
  onChanged,
}: {
  appointment: Appointment;
  /** Called with the new state when it changes, or null when the hold ran out. */
  onChanged: (next: Appointment | null) => void;
}) {
  const left = useSecondsLeft(appointment.holdExpiresAt);
  const [orderState, setOrderState] = useState<PaymentOrder | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"pay" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [slow, setSlow] = useState(false);

  // Ask the server for the payment order as soon as the panel appears (the same order is returned on reload).
  useEffect(() => {
    let cancelled = false;
    api
      .post<PaymentOrder>(`/appointments/${appointment.id}/payment-order`)
      .then((o) => !cancelled && setOrderState(o))
      .catch((err) => !cancelled && setOrderError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [appointment.id]);

  // When the clock runs out, refresh: the API reports the hold as expired. (Not while a
  // payment is being confirmed: a payment made in the last seconds can still succeed.)
  useEffect(() => {
    if (left === 0 && !confirming) onChanged(null);
  }, [left, confirming, onChanged]);

  // After the payment window reports success, poll until the webhook has confirmed the booking.
  useEffect(() => {
    if (!confirming) return;
    let stopped = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > 60_000) setSlow(true);
      try {
        const next = await api.get<Appointment>(`/appointments/${appointment.id}`);
        if (!stopped && next.status !== "PENDING_PAYMENT") onChanged(next);
      } catch {
        // Try again on the next tick.
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [confirming, appointment.id, onChanged]);

  async function payMock() {
    setBusy("pay");
    setError(null);
    try {
      onChanged(await api.post<Appointment>(`/appointments/${appointment.id}/mock-pay`));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  async function payRazorpay(o: Extract<PaymentOrder, { mode: "razorpay" }>) {
    setBusy("pay");
    setError(null);
    try {
      await loadCheckout();
      const checkout = new window.Razorpay!({
        key: o.keyId,
        order_id: o.orderId,
        amount: o.amount,
        currency: o.currency,
        name: o.name,
        description: o.description,
        prefill: o.prefill,
        theme: { color: "#0f766e" },
        // Success here is only a hint. The server confirms the booking when Razorpay's webhook arrives.
        handler: () => {
          setConfirming(true);
          setBusy(null);
        },
        modal: { ondismiss: () => setBusy(null) },
      });
      checkout.on("payment.failed", (r) =>
        setError(`${r.error.description ?? "The payment didn't go through."} You can try again.`),
      );
      checkout.open();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    setError(null);
    try {
      onChanged(await api.post<Appointment>(`/appointments/${appointment.id}/cancel`, {}));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  const price = formatMoney(appointment.feeAmount, appointment.currency);

  if (confirming) {
    return (
      <Card className="space-y-3 border-brand-300 bg-brand-50">
        <div className="flex items-center gap-3 text-brand-900">
          <Spinner className="size-5" />
          <h2 className="font-semibold">Confirming your payment…</h2>
        </div>
        <p className="text-sm text-slate-700">
          Please don&apos;t close this page or pay again. Your token appears here as soon as the
          bank confirms.
        </p>
        {slow && (
          <Alert tone="info">
            This is taking longer than usual. Your payment is safe: you&apos;ll get an SMS when the
            booking is confirmed, and if it can&apos;t be, your money is refunded automatically.
          </Alert>
        )}
      </Card>
    );
  }

  return (
    <Card className="space-y-4 border-amber-300 bg-amber-50">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-slate-900">Complete your booking</h2>
          <p className="text-sm text-slate-700">
            Your slot is held for you. Pay before the timer ends.
          </p>
        </div>
        <div
          role="timer"
          aria-label="Time left to pay"
          className="rounded-xl bg-white px-4 py-2 text-2xl font-bold text-amber-800 tabular-nums"
        >
          {mm}:{ss}
        </div>
      </div>
      {(error || orderError) && <Alert>{error ?? orderError}</Alert>}
      {orderState?.mode === "mock" && (
        <Alert tone="info">Test mode: no real money is charged.</Alert>
      )}
      {orderState?.mode === "razorpay" && (
        <p className="text-xs text-slate-600">
          Secure payment by Razorpay: UPI, cards and net banking.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => (orderState?.mode === "razorpay" ? payRazorpay(orderState) : payMock())}
          loading={busy === "pay" || (!orderState && !orderError)}
          disabled={busy !== null || left === 0 || !orderState}
        >
          Pay {price}
          {orderState?.mode === "mock" ? " (test)" : ""}
        </Button>
        <Button
          variant="secondary"
          onClick={cancel}
          loading={busy === "cancel"}
          disabled={busy !== null}
        >
          Cancel booking
        </Button>
      </div>
    </Card>
  );
}
