# Pilot launch checklist: 5 to 10 hospitals in one city

Tick each box and write the date and who did it. Do not onboard a hospital until every box in **A** and **B** is
ticked. The technical steps are in `docs/DEPLOYMENT.md`; backups are in `docs/BACKUP-RESTORE.md`.

## A. Before anything goes live (business and legal)

- [ ] **Lawyer has reviewed** the privacy policy and terms (the pages say "draft for development" until you
      remove that banner in `apps/web/src/components/legal-page.tsx`). Set `PRIVACY_POLICY_VERSION` and
      `TERMS_VERSION` to the dates of the final texts, in the API settings and on the pages.
- [ ] A real **Grievance Officer** email replaces `privacy@mediq.example` in the privacy policy, and someone
      reads that inbox.
- [ ] A **hospital agreement** is signed with each hospital: who is responsible for the patient details taken at
      the desk (the hospital), the commission %, the settlement schedule, the cancellation policy, and what
      happens on a dispute.
- [ ] **Razorpay**: KYC complete, live keys issued, settlement bank account confirmed, webhook added.
- [ ] **MSG91 DLT**: entity, sender ID and the five appointment templates approved (and the waitlist one).
- [ ] A **support phone and email** for hospitals and patients, with named people and hours.
- [ ] Each hospital has a **notice at the desk** about how patient details are used (a printed `/privacy` QR
      code is enough), because walk-in patients do not tick a consent box themselves.

- [ ] **Blood module (only if you switch it on for the pilot):** the lawyer has also read the blood sections of the privacy
      policy and terms, and you have decided **who checks each blood bank's licence** and how (against the issuing authority,
      not just a photo). Nobody should be approved by guesswork: an unlicensed bank on MediQ is a patient-safety problem.
- [ ] **SMS budget for blood alerts.** One request can send up to 100 donor SMS plus 10 to blood banks. Decide the monthly limit
      you are willing to pay, and who watches it. The limits are in `.env` (`BLOOD_MAX_DONORS_ALERTED`, 3 requests a day per number).
- [ ] The extra **DLT templates** are registered and their ids set (see the README table): the verification code, the donor alert,
      the blood bank alert, the "someone can help" message and the donation thank-you.

- [ ] **Hindi (only if you switch it on):** a native Hindi speaker has read `apps/web/src/lib/i18n/messages.hi.ts` and the Hindi
      SMS texts in the README, and the Hindi texts are registered as DLT templates with their ids in `MSG91_HINDI_TEMPLATE_IDS`.
      Until then those messages go out in English. Hindi SMS cost more (Unicode): include that in the SMS budget.
- [ ] **Plans:** you decided the plans and prices, which plan each pilot hospital is on (the free **pilot** plan needs no action),
      and **who records offline payments** and how often they check Admin > Subscriptions. A hospital whose plan ends stops taking
      online bookings 7 days later, so agree the reminder routine in the hospital agreement.
- [ ] **Reviews:** someone checks Admin > Reviews for hospital reports at least weekly, with written rules for what is hidden
      (abuse, personal details, advertising, not a real patient; never "a bad review").

## B. Technical go-live gates

- [ ] Deployed to **staging** and the five-minute smoke test (`DEPLOYMENT.md`, section 8) passed.
- [ ] Same on **production** with real keys: one real booking paid and refunded by you.
- [ ] **Webhook proven**: Razorpay _Resend_ does nothing twice; a failed test payment releases the slot.
- [ ] **Backups**: the nightly workflow ran green at least twice, and a **restore drill** was done from the
      off-site bucket into a scratch database. Date: ______ By: ______ Took: ______ minutes.
- [ ] **Monitoring**: uptime monitors on the API and the web app alert a phone; a Sentry test error reached the
      inbox of the on-call person; a Sentry alert rule exists for the API and the web project.
- [ ] `pnpm audit --prod` re-run; only the three known Prisma-tooling findings remain (or fewer).
- [ ] All tests pass on the release commit: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`,
      `pnpm db:diff --check`, `pnpm build`.
- [ ] **CSP**: the browser console showed no `Content-Security-Policy-Report-Only` warnings on sign-in, booking,
      payment, reception, the live queue page, and the emergency map. (Enforce it after a clean pilot week.)
- [ ] **Real devices**: the patient flow on a cheap Android phone on mobile data, and on an iPhone; the install
      prompt appears (Android) or the Share-sheet hint (iPhone).
- [ ] The **first admin** exists, has changed the temporary password, and the password is in a password manager
      with a second person holding a recovery path.
- [ ] `DOCS_ENABLED` is **not** set in production (unless you decided to publish the API reference).
- [ ] The emergency finder lists the pilot hospitals with a correct emergency number each (call every one).

- [ ] **Blood module drill** (if used): with two test donors of one blood group and one verified test blood bank, make a request from
      a test phone. The donors and the bank get the SMS, a donor taps I can help, the requester sees that donor's number, then
      closes the request and the number disappears. A donor of another group and a donor in their waiting period get nothing.
- [ ] At least one **real blood bank was approved by an admin** after the licence was checked, and a **rejected** one was tried
      (reason shown, resubmit works).

## C. Per hospital (repeat for each of the 5 to 10)

1. [ ] Admin creates the hospital and its login; the temporary password is handed over in person or by phone,
       never over chat or email.
2. [ ] Hospital admin changes the password, sets the profile, **emergency number and beds**, and the
       **cancellation policy** agreed in the contract.
3. [ ] Departments, doctors (fee, photo, qualification), **weekly timings and leaves** entered; open slots appear.
4. [ ] Receptionist logins created (one per person: no shared logins) and each receptionist trained for 30 minutes:
       check in by code and by scan, walk-in booking, cash, cancel with refund, print slips, live queue.
5. [ ] **Slips**: the pre-printed paper's size chosen, a template laid out, the **test print aligned on the real
       paper with the real printer** (use the offset boxes and the alignment sheet), printed at 100%. Date: ______
6. [ ] **QR codes** printed from _Hospital panel > QR codes_: the hospital code for the entrance and reception, and
       each doctor's queue code outside their room. Scan each with a phone.
7. [ ] A **test patient** books, pays, is checked in and is seen; the live queue page shows it.
8. [ ] Approved by the platform admin. The hospital page `/h/{slug}` opens and shows the doctors.
9. [ ] The hospital knows **who to call** (support) and has agreed a **paper fallback** for when the internet is
       down: queue patients by paper for that time, then enter them afterwards. Tell them plainly that the system
       issues token numbers itself, so patients entered later get new numbers: the receptionist must tell the
       doctor which printed slips replace the paper list.

## C2. Per blood bank (if the blood module is used)

1. [ ] The blood bank registers itself at `/blood/register-bank` (its own phone, its own login), and the **licence is checked
       by the person named in section A** before approval. Date: ______ Checked with: ______
2. [ ] Every person who will record donations has **their own login** (Staff page): no shared logins.
3. [ ] Staff are shown how to **find a donor by phone**, record the group **from their own test**, and **void** a mistake
       within 48 hours. They know a donor in the waiting period is refused on purpose.
4. [ ] They know to **keep the stock figures current**: after a day the public sees them as "call to confirm".
5. [ ] The blood bank's public phone number is answered at all hours it claims to be open, because emergency requests
       send people to it.
6. [ ] They understand the rules: MediQ never sells or handles blood, and **nobody may be asked to pay through MediQ**.

## D. Launch week

- [ ] Daily, 10 minutes, same person: admin dashboard (bookings, no-show %, cancellations), **refunds still to
      reach patients** (must be 0 by the next day), the Sentry inbox, the Razorpay dashboard (failed payments,
      unmatched payments), and the audit log for anything odd.
- [ ] Day 2 and day 5: phone one receptionist per hospital: what is slow, what do patients ask?
- [ ] Any payment that succeeded at Razorpay but has no booking is resolved the same day (refund or re-create).
- [ ] After a clean week, enforce the CSP and review the open questions below.

## E. How you will know the pilot works (decide the targets before you start)

| Measure                               | Where                  | Target (set yours) |
| ------------------------------------- | ---------------------- | ------------------ |
| Bookings per hospital per week        | `/admin` dashboard     | ______             |
| Share booked online vs walk-in        | `/hospital/analytics`  | ______             |
| No-show rate                          | `/hospital/analytics`  | below ______%      |
| Average wait (check-in to doctor)     | `/hospital/analytics`  | below ______ min   |
| Payments that needed manual fixing    | Razorpay vs `/admin`   | 0                  |
| Support calls per 100 bookings        | your log               | below ______       |
| Hospitals that would continue and pay | a phone call at week 4 | ______ of ______   |

## F. Stop conditions

Pause new bookings (block the hospital in the admin panel, or stop the API) and call the person responsible if:
double bookings appear (should be impossible: treat any as a serious bug and keep the evidence), payments succeed
without bookings repeatedly, refunds stay failed, patient data appears to the wrong person, or the database
cannot be restored. Restore steps are in `docs/BACKUP-RESTORE.md`.

## G. Known limits to tell the hospitals

- Sessions and the live queue assume **one API instance**; an outage of hosting or the database stops bookings.
- Walk-in patients without a phone number get no SMS; their token is on the slip.
- Bed counts on the emergency finder are only as fresh as the hospital's last update (shown as "not updated
  recently" after 24 hours).
- Reviews and the waiting list are not built yet. The blood module is built but optional for the pilot: donors are only
  alerted if enough are registered near the hospital, so do not promise patients a donor. Blood bank stock is as fresh as
  the bank last updated it.
