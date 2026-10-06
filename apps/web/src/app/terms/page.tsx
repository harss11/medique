import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Terms of Service" };

// Keep in sync with TERMS_VERSION in apps/api/.env.
const VERSION = "2026-10-01";

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" version={VERSION}>
      <p>By creating an account or booking an appointment on MediQ you agree to these terms.</p>

      <h2>What MediQ is</h2>
      <p>
        MediQ is a booking platform. Medical care is provided solely by the hospitals and doctors
        you choose; MediQ does not provide medical advice. In an emergency, call 112 or go to the
        nearest hospital immediately.
      </p>

      <h2>Bookings and payments</h2>
      <ul>
        <li>
          A booking is confirmed only after payment succeeds; you then receive a token number.
        </li>
        <li>Token numbers and times are estimates; actual consultation times may vary.</li>
        <li>Cancellation, rescheduling and refund rules are shown before you pay.</li>
      </ul>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Give accurate details for yourself and any family member you book for.</li>
        <li>Do not share your one-time codes with anyone.</li>
        <li>Do not misuse the platform or attempt to access other people&apos;s data.</li>
      </ul>

      <h2>Blood donors, requests and blood banks</h2>
      <ul>
        <li>
          MediQ only connects people who need blood with donors and blood banks. We do not provide,
          test, store, sell or guarantee blood, and we give no medical advice.
        </li>
        <li>
          Whether blood is available, and whether it is safe, is the responsibility of the blood
          bank and the hospital that uses it. A blood bank is responsible for keeping its licence
          valid, for screening donors and for the stock figures it reports.
        </li>
        <li>
          Blood must never be paid for through MediQ, and you must not ask anyone to pay you for it.
          Do not make a request unless a patient really needs blood.
        </li>
        <li>
          A donor chooses whether to help and may stop at any time. Donating is the donor&apos;s own
          decision, made after the blood bank has screened them.
        </li>
        <li>
          We may stop a request, block a blood bank or remove a donor who misuses the service.
        </li>
      </ul>

      <h2>Changes</h2>
      <p>We may update these terms. We will ask you to accept material changes.</p>
    </LegalPage>
  );
}
