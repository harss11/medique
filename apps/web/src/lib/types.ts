// Shapes returned by the MediQ API. Keep in sync with apps/api.

export type Role =
  "ADMIN" | "HOSPITAL_ADMIN" | "RECEPTIONIST" | "DOCTOR" | "PATIENT" | "BLOOD_BANK_STAFF";
export type HospitalStatus = "PENDING_APPROVAL" | "ACTIVE" | "BLOCKED";
export type BloodBankStatus = "PENDING_VERIFICATION" | "ACTIVE" | "REJECTED" | "BLOCKED";

export interface User {
  id: string;
  role: Role;
  name: string;
  loginId: string | null;
  phone: string | null;
  email: string | null;
  hospitalId: string | null;
  hospital: { id: string; name: string; slug: string; status: HospitalStatus } | null;
  bloodBankId: string | null;
  bloodBank: { id: string; name: string; status: BloodBankStatus } | null;
  mustChangePassword: boolean;
  language?: "en" | "hi";
}

export interface Session {
  accessToken: string;
  accessTokenExpiresAt: string;
  user: User;
}

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  ip: string | null;
  actor: { id: string; name: string; role: Role; loginId: string | null } | null;
  hospital: { id: string; name: string } | null;
  metadata: Record<string, unknown> | null;
}

/** Shown exactly once after creating or resetting a staff login. */
export interface Credentials {
  loginId: string;
  temporaryPassword: string;
}

export interface Hospital {
  id: string;
  name: string;
  slug: string;
  status: HospitalStatus;
  description: string | null;
  logoUrl: string | null;
  phone: string | null;
  email: string | null;
  emergencyPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  currency: string;
  commissionPercent: number;
  refundFullHours: number;
  refundPartialPercent: number;
  totalBeds: number | null;
  availableBeds: number | null;
  bedsUpdatedAt: string | null;
  approvedAt: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffUser {
  id: string;
  role: Role;
  status: "ACTIVE" | "BLOCKED";
  name: string;
  loginId: string | null;
  contactPhone: string | null;
  email: string | null;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
}

export interface HospitalListItem extends Hospital {
  doctorCount: number;
  departmentCount: number;
  adminLogin: {
    loginId: string | null;
    mustChangePassword: boolean;
    lastLoginAt: string | null;
  } | null;
}

export interface HospitalDetail extends Hospital {
  counts: { doctors: number; departments: number; appointments: number };
  staff: StaffUser[];
}

export interface Department {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  doctorCount: number;
}

export type Gender = "MALE" | "FEMALE" | "OTHER" | "UNDISCLOSED";

export interface Doctor {
  id: string;
  departmentId: string;
  department?: { id: string; name: string };
  name: string;
  qualification: string | null;
  specialization: string | null;
  registrationNumber: string | null;
  experienceYears: number | null;
  gender: Gender | null;
  languages: string[];
  bio: string | null;
  photoUrl: string | null;
  /** minor units (paise) */
  consultationFee: number;
  avgConsultMinutes: number;
  qrToken: string;
  isActive: boolean;
  login: { id: string; loginId: string | null; status: string; mustChangePassword: boolean } | null;
}

export interface ScheduleSession {
  id?: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  capacityPerSlot: number;
}

export interface DoctorDetail extends Doctor {
  schedules: ScheduleSession[];
}

export interface Leave {
  id: string;
  startDate: string;
  endDate: string;
  reason: string | null;
}

export interface Slot {
  id: string;
  date: string;
  startAt: string;
  endAt: string;
  capacity: number;
  bookedCount: number;
  status: "OPEN" | "BLOCKED";
}

export interface SlotSyncSummary {
  created: number;
  updated: number;
  removed: number;
  conflicts: Array<{ slotId: string; startAt: string; bookedCount: number }>;
}

// ----- reviews (Phase 8) -----

export interface Rating {
  average: number | null;
  count: number;
}

export interface ReviewSummary extends Rating {
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

export interface PublicReview {
  rating: number;
  comment: string | null;
  /** First name and the initial of the last name. */
  reviewer: string;
  doctor: string;
  createdAt: string;
}

export interface PublicReviewList extends Paginated<PublicReview> {
  summary: ReviewSummary;
}

/** The patient's own review of a visit. */
export interface MyReview {
  rating: number;
  comment: string | null;
  createdAt: string;
  hidden: boolean;
  canEdit: boolean;
}

export interface HospitalReviewRow {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  isPublished: boolean;
  reportedAt: string | null;
  reportReason: string | null;
  hiddenReason: string | null;
  reviewer: string;
  doctor: string;
}

export interface AdminReviewRow extends Omit<HospitalReviewRow, "hiddenReason"> {
  hiddenAt: string | null;
  hiddenReason: string | null;
  hospital: string;
}

// ----- public browsing and booking (Phase 3) -----

export interface PublicHospital {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  phone: string | null;
  emergencyPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  currency: string;
  refundFullHours: number;
  refundPartialPercent: number;
}

export interface PublicHospitalListItem extends PublicHospital {
  doctorCount: number;
  rating?: Rating;
  /** False while the hospital's subscription is not in good standing. */
  acceptingBookings?: boolean;
}

export interface PublicDepartment {
  id: string;
  name: string;
  description: string | null;
  doctorCount: number;
}

export interface PublicDoctor {
  id: string;
  name: string;
  photoUrl: string | null;
  qualification: string | null;
  specialization: string | null;
  experienceYears: number | null;
  gender: Gender | null;
  languages: string[];
  bio: string | null;
  consultationFee: number;
  avgConsultMinutes: number;
  department: { id: string; name: string };
  /** Average of published reviews; missing where a doctor is shown without ratings. */
  rating?: Rating;
}

export interface PublicDoctorDetail extends PublicDoctor {
  hospital: PublicHospital;
  acceptingBookings?: boolean;
}

export interface Availability {
  timezone: string;
  today: string;
  dates: Array<{ date: string; openSlots: number }>;
  /** Days that have slots, all taken: the waitlist can be joined for these. */
  fullDates: string[];
  acceptingBookings?: boolean;
}

// ----- subscriptions (Phase 8) -----

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** Minor units per month. */
  priceMonthly: number;
  currency: string;
  /** Null means unlimited. */
  maxDoctors: number | null;
  maxStaff: number | null;
  maxMonthlyBookings: number | null;
  analytics: boolean;
  slipPrinting: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface AdminPlan extends Plan {
  hospitals: number;
}

export type SubscriptionState =
  "TRIALING" | "ACTIVE" | "GRACE" | "EXPIRED" | "SUSPENDED" | "CANCELLED";
export type SubscriptionNotice =
  "none" | "ending_soon" | "grace" | "expired" | "suspended" | "cancelled";
export type SubscriptionPaymentMethod = "BANK_TRANSFER" | "UPI" | "CASH" | "CHEQUE" | "OTHER";

export interface SubscriptionPaymentRow {
  id: string;
  amount: number;
  currency: string;
  method: SubscriptionPaymentMethod;
  reference: string | null;
  paidAt: string;
  periodStart: string;
  periodEnd: string;
  note: string | null;
  recordedBy: string;
}

export interface SubscriptionView {
  /** Null for a hospital with no subscription: no limits. */
  plan: Plan | null;
  status: "TRIALING" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | null;
  state: SubscriptionState | null;
  notice: SubscriptionNotice;
  acceptingBookings: boolean;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  daysLeft: number | null;
  notes: string | null;
  usage: { doctors: number; staff: number; monthlyBookings: number };
  payments: SubscriptionPaymentRow[];
}

export interface SubscriptionListRow {
  hospitalId: string;
  hospital: string;
  hospitalStatus: string;
  plan: { code: string; name: string; priceMonthly: number; currency: string };
  status: string;
  state: SubscriptionState;
  notice: SubscriptionNotice;
  endsAt: string | null;
  daysLeft: number | null;
}

// ----- patient history (Phase 8) -----

export interface HistoryVisit {
  id: string;
  status: AppointmentStatus;
  source: "ONLINE" | "WALK_IN";
  date: string;
  slotStart: string;
  reasonForVisit: string | null;
  feeAmount: number;
  /** Paid and kept after refunds. */
  paidAmount: number;
  currency: string;
  doctor: { id: string; name: string; specialization: string | null; photoUrl: string | null };
  hospital: { name: string; slug: string; timezone: string };
  department: string;
  patient: { id: string; fullName: string };
  review: { rating: number; hidden: boolean } | null;
  canReview: boolean;
}

export interface HistoryResponse extends Paginated<HistoryVisit> {
  summary: {
    visits: number;
    doctors: number;
    hospitals: number;
    spent: Array<{ currency: string; amount: number }>;
  };
}

// ----- search (Phase 8) -----

export interface Facet {
  value: string;
  count: number;
}

export interface DoctorSearchResult {
  id: string;
  name: string;
  photoUrl: string | null;
  qualification: string | null;
  specialization: string | null;
  experienceYears: number | null;
  gender: Gender | null;
  languages: string[];
  consultationFee: number;
  avgConsultMinutes: number;
  department: { id: string; name: string };
  rating: Rating;
  hospital: {
    id: string;
    name: string;
    slug: string;
    city: string | null;
    state: string | null;
    currency: string;
    acceptingBookings?: boolean;
  };
  /** The first free seat, or null when there is none in the booking window. */
  nextAvailable: { startAt: string; date: string } | null;
}

export interface DoctorSearchResponse extends Paginated<DoctorSearchResult> {
  facets: { specializations: Facet[]; cities: Facet[]; languages: Facet[] };
  /** More than 1000 doctors matched the words: ask the patient to narrow the search. */
  capped: boolean;
}

// ----- waitlist (Phase 8) -----

export type WaitlistStatus = "WAITING" | "NOTIFIED" | "BOOKED" | "EXPIRED" | "CANCELLED";

export interface WaitlistEntry {
  id: string;
  /** local calendar day, YYYY-MM-DD */
  date: string;
  status: WaitlistStatus;
  /** Place in the line while waiting. */
  position: number | null;
  seatsOpen: boolean;
  notifiedAt: string | null;
  noticeEndsAt: string | null;
  joinedAt: string;
  doctor: { id: string; name: string; photoUrl: string | null; specialization: string | null };
  hospital: { name: string; slug: string; timezone: string };
  patient: { fullName: string };
}

export interface PublicSlot {
  id: string;
  startAt: string;
  endAt: string;
  remaining: number;
  available: boolean;
}

export interface SlotDetail {
  slot: PublicSlot & { date: string };
  doctor: PublicDoctorDetail;
}

export type Relation = "SELF" | "SPOUSE" | "CHILD" | "PARENT" | "SIBLING" | "OTHER";

export interface PatientProfile {
  id: string;
  relation: Relation;
  fullName: string;
  dateOfBirth: string | null;
  gender: Gender | null;
  phone: string | null;
}

export type AppointmentStatus =
  | "PENDING_PAYMENT"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "EXPIRED";

export interface Appointment {
  id: string;
  status: AppointmentStatus;
  source: "ONLINE" | "WALK_IN";
  /** local calendar day of the visit, YYYY-MM-DD */
  appointmentDate: string;
  slotStart: string;
  slotEnd: string;
  tokenNumber: number | null;
  holdExpiresAt: string | null;
  feeAmount: number;
  currency: string;
  reasonForVisit: string | null;
  checkInCode: string | null;
  /** Opens the doctor live queue (/q/{queueToken}); null unless the ticket is still valid. */
  queueToken: string | null;
  canCancel: boolean;
  canReschedule: boolean;
  /** Completed online visit with no review yet, inside the review window. */
  canReview: boolean;
  review: MyReview | null;
  checkedInAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  rescheduledFromId: string | null;
  rescheduledToId: string | null;
  hospital: Pick<
    PublicHospital,
    | "id"
    | "name"
    | "slug"
    | "phone"
    | "emergencyPhone"
    | "addressLine1"
    | "city"
    | "state"
    | "latitude"
    | "longitude"
    | "timezone"
  >;
  doctor: {
    id: string;
    name: string;
    photoUrl: string | null;
    qualification: string | null;
    specialization: string | null;
  };
  department: { id: string; name: string };
  patient: { id: string; fullName: string; relation: Relation };
  payment: {
    status: "CREATED" | "AUTHORIZED" | "CAPTURED" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED";
    method: string;
    provider: string;
    providerMethod: string | null;
    amount: number;
    refundedAmount: number;
    paidAt: string | null;
    refunds: Array<{
      amount: number;
      status: "PENDING" | "PROCESSED" | "FAILED";
      percent: number | null;
    }>;
  } | null;
  /** The hospital's cancellation policy. */
  refundPolicy: { fullRefundHours: number; partialPercent: number };
  /** What cancelling right now would refund (null when nothing was paid or it can't be cancelled). */
  cancelRefund: { amount: number; percent: number } | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Phase 5: operations (desk, doctor queue, live queue, slips, emergency)
// ---------------------------------------------------------------------------

export interface DeskDoctor {
  id: string;
  name: string;
  specialization: string | null;
  consultationFee: number;
  avgConsultMinutes: number;
  department: { id: string; name: string };
}

export interface StaffAppointment {
  id: string;
  status: AppointmentStatus;
  source: "ONLINE" | "WALK_IN";
  appointmentDate: string;
  slotStart: string;
  slotEnd: string;
  tokenNumber: number | null;
  feeAmount: number;
  currency: string;
  reasonForVisit: string | null;
  checkedInAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  doctor: { id: string; name: string };
  department: { id: string; name: string };
  patient: {
    id: string;
    fullName: string;
    phone: string | null;
    ageYears: number | null;
    gender: Gender | null;
  };
  payment: {
    status: "CREATED" | "AUTHORIZED" | "CAPTURED" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED";
    method: string;
    amount: number;
    refundedAmount: number;
  } | null;
  paid: boolean;
}

export type QueueState = "NO_BOOKINGS" | "NOT_STARTED" | "SERVING" | "BETWEEN" | "DONE";

export interface QueueCounts {
  booked: number;
  waiting: number;
  inProgress: number;
  completed: number;
  noShow: number;
}

export interface QueueSnapshot {
  date: string;
  state: QueueState;
  nowServing: number | null;
  lastServed: number | null;
  lastIssued: number;
  counts: QueueCounts;
  avgConsultMinutes: number;
  generatedAt: string;
}

export interface DayList extends Paginated<StaffAppointment> {
  date: string;
  timezone: string;
  summary: QueueCounts & { cancelled: number };
  queue: QueueSnapshot | null;
}

export interface DeskSlot {
  id: string;
  startAt: string;
  endAt: string;
  remaining: number;
  available: boolean;
}

export interface CancelResult {
  appointment: StaffAppointment;
  refund: { amount: number; percent: number; method: "CASH" | "ONLINE" } | null;
}

export interface CheckInResult {
  appointment: StaffAppointment;
  alreadyCheckedIn: boolean;
}

export interface PublicQueue extends QueueSnapshot {
  doctor: { name: string; department: string };
  hospital: { name: string; slug: string };
  yourToken: {
    token: number;
    status: "WAITING" | "NOW" | "DONE" | "MISSED" | "NOT_FOUND";
    ahead: number;
    minutes: number;
  } | null;
}

export type SlipFieldKey =
  | "patientName"
  | "patientAge"
  | "patientGender"
  | "patientAgeGender"
  | "patientPhone"
  | "doctorName"
  | "doctorQualification"
  | "department"
  | "date"
  | "time"
  | "tokenNumber"
  | "hospitalName"
  | "reasonForVisit"
  | "fee"
  | "checkInCode";

export interface SlipField {
  key: SlipFieldKey;
  xMm: number;
  yMm: number;
  maxWidthMm: number;
  fontSizePt: number;
  bold: boolean;
  align: "left" | "center" | "right";
}

export interface SlipTemplate {
  id: string;
  name: string;
  paperWidthMm: number;
  paperHeightMm: number;
  offsetXMm: number;
  offsetYMm: number;
  fields: SlipField[];
  backgroundImageUrl: string | null;
  isDefault: boolean;
  updatedAt: string;
}

export interface SlipTemplateSummary {
  id: string;
  name: string;
  paperWidthMm: number;
  paperHeightMm: number;
  isDefault: boolean;
}

export interface EmergencyHospital {
  id: string;
  name: string;
  slug: string;
  city: string | null;
  state: string | null;
  addressLine1: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
  callNumber: string | null;
  hasEmergencyLine: boolean;
  totalBeds: number | null;
  availableBeds: number | null;
  bedsUpdatedAt: string | null;
  bedsStale: boolean;
}

// ---------------------------------------------------------------------------
// Phase 6: statistics
// ---------------------------------------------------------------------------

export interface StatsRange {
  from: string;
  to: string;
  days: number;
  timezone: string;
}

export interface MoneySummary {
  currency: string;
  onlineGross: number;
  onlineRefunded: number;
  onlineNet: number;
  commission: number;
  hospitalShare: number;
  cashCollected: number;
  cashRefunded: number;
  cashNet: number;
}

export interface BookingSummary {
  total: number;
  active: number;
  completed: number;
  cancelled: number;
  noShow: number;
  online: number;
  walkIn: number;
  cancellationRate: number | null;
  noShowRate: number | null;
  onlineShare?: number | null;
}

export interface DailyBookings {
  date: string;
  booked: number;
  cancelled: number;
  completed: number;
  noShow: number;
}

export interface OutstandingRefund {
  currency: string;
  status: "PENDING" | "FAILED";
  count: number;
  amount: number;
}

export interface AdminStats {
  range: StatsRange;
  hospitalId: string | null;
  totals: {
    hospitals: { active: number; pending: number; blocked: number };
    activeDoctors: number;
    patients: number;
    newPatients: number;
  };
  bookings: BookingSummary;
  money: MoneySummary[];
  refundsOutstanding: OutstandingRefund[];
  revenueCurrency: string;
  daily: Array<DailyBookings & { onlineGross: number }>;
  topHospitals: Array<{
    id: string;
    name: string;
    bookings: number;
    onlineGross: number;
    commission: number;
  }>;
}

export interface HospitalAnalytics {
  range: StatsRange;
  currency: string;
  bookings: BookingSummary;
  money: MoneySummary;
  refundsOutstanding: OutstandingRefund[];
  service: { avgWaitMinutes: number | null; avgConsultMinutes: number | null };
  daily: DailyBookings[];
  byDoctor: Array<{
    id: string;
    name: string;
    booked: number;
    completed: number;
    noShow: number;
    cancelled: number;
    noShowRate: number | null;
    revenueKept: number;
  }>;
  byDepartment: Array<{ id: string; name: string; booked: number }>;
  byHour: Array<{ hour: number; count: number }>;
}

// ---------------------------------------------------------------------------
// Phase 7: blood bank module (donations are records: nothing is issued or redeemed)
// ---------------------------------------------------------------------------

export type BloodGroup =
  "A_POS" | "A_NEG" | "B_POS" | "B_NEG" | "AB_POS" | "AB_NEG" | "O_POS" | "O_NEG";
export type BloodUrgency = "EMERGENCY" | "URGENT";
export type BloodRequestStatus = "OPEN" | "FULFILLED" | "CANCELLED" | "EXPIRED";

export interface BloodStockRow {
  bloodGroup: BloodGroup;
  units: number;
  updatedAt: string | null;
  stale: boolean;
}

export interface PublicBloodBank {
  id: string;
  name: string;
  licenseNumber: string;
  verifiedAt: string | null;
  phone: string;
  addressLine1: string;
  city: string;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  is24x7: boolean;
  operatingHours: string | null;
  distanceKm: number | null;
  stock: BloodStockRow[];
  stockUpdatedAt: string | null;
  stockStale: boolean;
}

export interface OwnBloodBank {
  id: string;
  name: string;
  licenseNumber: string;
  licenseAuthority: string | null;
  licenseValidUntil: string | null;
  status: BloodBankStatus;
  phone: string;
  email: string | null;
  addressLine1: string;
  city: string;
  state: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  is24x7: boolean;
  operatingHours: string | null;
  verifiedAt: string | null;
  rejectedReason: string | null;
  blockedReason: string | null;
  createdAt: string;
}

export interface DonorProfileView {
  bloodGroup: BloodGroup;
  gender: Gender;
  dateOfBirth: string;
  city: string;
  hasLocation: boolean;
  isAvailable: boolean;
  lastDonationAt: string | null;
  eligible: boolean;
  ineligibleReasons: Array<"TOO_YOUNG" | "TOO_OLD" | "WAITING_PERIOD">;
  nextEligibleAt: string | null;
  canBeAlerted: boolean;
  alertsConsentAt: string;
}

export interface MyDonation {
  id: string;
  donatedAt: string;
  bloodGroup: BloodGroup;
  volumeMl: number;
  bloodBank: string;
  city: string;
}

export interface ResponderRequest {
  id: string;
  bloodGroup: BloodGroup;
  unitsNeeded: number;
  urgency: BloodUrgency;
  hospitalName: string;
  city: string;
  note: string | null;
  status: BloodRequestStatus;
  expiresAt: string;
  createdAt: string;
  requesterFirstName: string;
  distanceKm: number | null;
  myResponse: "CAN_HELP" | "CANNOT" | null;
}

export interface RequesterRequest {
  id: string;
  bloodGroup: BloodGroup;
  unitsNeeded: number;
  urgency: BloodUrgency;
  hospitalName: string;
  city: string;
  radiusKm: number;
  note: string | null;
  status: BloodRequestStatus;
  expiresAt: string;
  createdAt: string;
  alertedDonors: number;
  alertedBanks: number;
}

export interface RequesterView {
  request: RequesterRequest;
  donors: Array<{
    firstName: string;
    bloodGroup: BloodGroup;
    distanceKm: number | null;
    respondedAt: string;
    phone: string | null;
  }>;
  banks: Array<{ name: string; city: string; phone: string | null; respondedAt: string }>;
}

export interface DonorLookup {
  donorId: string;
  name: string;
  bloodGroup: BloodGroup;
  gender: Gender;
  ageYears: number | null;
  lastDonationAt: string | null;
  eligible: boolean;
  ineligibleReasons: Array<"TOO_YOUNG" | "TOO_OLD" | "WAITING_PERIOD">;
  nextEligibleAt: string | null;
}

export interface BankDonation {
  id: string;
  donatedAt: string;
  bloodGroup: BloodGroup;
  volumeMl: number;
  donorName: string;
  donorPhone: string | null;
  recordedBy: string;
  voided: boolean;
  voidReason: string | null;
  canVoid: boolean;
}
