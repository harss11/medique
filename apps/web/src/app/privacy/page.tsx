import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Privacy Policy" };

// Keep in sync with PRIVACY_POLICY_VERSION in apps/api/.env (users consent to this version).
const VERSION = "2026-10-06";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" version={VERSION}>
      <p>
        MediQ (&quot;we&quot;) helps you book doctor appointments at partner hospitals. This policy
        explains what personal data we process and why, in line with India&apos;s Digital Personal
        Data Protection Act, 2023 (DPDP Act).
      </p>

      <h2>Data we collect</h2>
      <ul>
        <li>Your mobile number, used to sign you in with a one-time code.</li>
        <li>
          Your name, and optionally the date of birth and gender of you and your family members.
        </li>
        <li>
          Appointment details: hospital, doctor, date, time, token number and reason for visit.
        </li>
        <li>
          Payment references from our payment partner (we never see or store card or UPI details).
        </li>
        <li>
          Technical data such as IP address and device type, for security and fraud prevention.
        </li>
        <li>
          If you are registered at a hospital desk without an account: the name, age, gender, phone
          number and reason for visit the receptionist enters. The hospital collects these to book
          your visit and MediQ stores them on the hospital&apos;s behalf. Ask the hospital if you
          want them corrected or removed.
        </li>
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>To book, manage and remind you about appointments.</li>
        <li>To share the booking with the hospital and doctor you chose.</li>
        <li>To process payments and refunds.</li>
        <li>To keep the service secure and meet legal obligations.</li>
      </ul>
      <p>We do not sell your data or use it for advertising.</p>

      <h2>Who sees your data</h2>
      <ul>
        <li>The hospital and doctor you book with, and their reception staff, see your booking.</li>
        <li>Our payment partner (Razorpay) processes your payment.</li>
        <li>Our SMS and WhatsApp providers deliver your booking messages.</li>
        <li>
          Our hosting, file storage and error-monitoring providers process technical data on our
          behalf. Error reports are stripped of names, phone numbers, request contents and addresses
          before they leave our servers.
        </li>
      </ul>

      <h2>Blood donors, blood requests and blood banks</h2>
      <p>
        MediQ helps people who need blood find donors and blood banks nearby. MediQ only connects
        people. We do not collect, store, test or sell blood, and we are not a blood bank.
      </p>
      <ul>
        <li>
          <strong>Donors</strong> who choose to register give their blood group, gender, date of
          birth, city and, if they allow it, their location (saved only to about 1 km). We use these
          to find requests near them, to keep them out of requests while they must wait between
          donations, and to show a blood bank whether they may donate. A blood bank records each
          donation (date, the blood group it confirmed and the amount). A donation is only a record:
          nothing is issued to the donor.
        </li>
        <li>
          A donor agrees, when registering, to be alerted by SMS about requests near them. A
          donor&apos;s phone number is shown to the person who asked for blood <strong>only</strong>{" "}
          if the donor taps &quot;I can help&quot;, and only while that request is open. Donors can
          pause alerts or stop being a donor at any time.
        </li>
        <li>
          <strong>People asking for blood</strong> give their name, phone number (checked with a
          code), the hospital, city and an optional note. The donors and blood banks we alert see
          the hospital, city, number of units, the note and the first name, never the phone number.
          A request closes by itself after a day. Its name, phone number and note are removed 90
          days after it closed.
        </li>
        <li>
          <strong>Blood banks</strong> register with their licence number, address and phone number,
          which we check before listing them. The licence number, name, address, phone and the stock
          they report are shown publicly.
        </li>
        <li>
          We keep records of who recorded or changed what (for example a donation or a stock update)
          in an audit log.
        </li>
      </ul>

      <h2>Consent and your rights</h2>
      <p>
        We process your data on the basis of the consent you give when you create an account. You
        may withdraw consent, and you have the right to access, correct and erase your personal data
        and to nominate another person to exercise these rights. Withdrawing consent does not affect
        processing already carried out, and some records (for example payment records) must be kept
        for the period required by law.
      </p>
      <p>
        You can do this yourself in the app under <strong>Privacy and data</strong>: download a copy
        of your data, or erase your account. Erasing removes your name, phone number, date of birth,
        messages and device records and signs you out everywhere. We keep the appointment, its fee
        and the payment and refund records, without your personal details, because the hospital and
        the law require them. You cannot erase your account while you have an upcoming appointment
        or a refund on its way.
      </p>

      <h2>Backups</h2>
      <p>
        We keep encrypted backups of the database so your records survive a failure. Erased data
        disappears from backups as they expire, within 60 days.
      </p>

      <h2>Retention</h2>
      <p>
        We keep your data only as long as needed for the purposes above or as required by law, and
        then delete or anonymise it.
      </p>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit, access is limited by role, and every change to bookings and
        accounts is recorded in an audit log.
      </p>

      <h2>Grievance officer</h2>
      <p>
        For questions, requests or complaints, contact our Grievance Officer at
        privacy@mediq.example (placeholder). You may also approach the Data Protection Board of
        India.
      </p>
    </LegalPage>
  );
}
