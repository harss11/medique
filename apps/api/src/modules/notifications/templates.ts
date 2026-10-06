import { DEFAULT_LANGUAGE, type Language } from "../../utils/language.js";

/**
 * Appointment messages. Each template lists the variables it uses, because
 * DLT-registered SMS (MSG91) are sent as "template id + variable values":
 * register each text below with exactly these ##placeholders##. Every template has an English and
 * a Hindi text with the same placeholders (a test checks it). Hindi SMS are Unicode: 70 characters
 * per segment instead of 160, so they cost more per message.
 */
export type AppointmentTemplate =
  | "booking_confirmed"
  | "appointment_reminder"
  | "appointment_cancelled"
  | "appointment_rescheduled";

/** Messages for the blood bank module. Always SMS, and always a short, plain text. */
export type BloodTemplate =
  | "blood_request_alert"
  | "blood_request_bank_alert"
  | "blood_request_answered"
  | "donation_recorded";

/** Told to a patient waiting for a seat when one opens. */
export type WaitlistTemplate = "waitlist_slot_open";

export type MessageTemplate = AppointmentTemplate | BloodTemplate | WaitlistTemplate;

export type TemplateVars = Record<string, string>;

export const TEMPLATE_VARIABLES: Record<MessageTemplate, readonly string[]> = {
  booking_confirmed: ["name", "doctor", "hospital", "date", "time", "token"],
  appointment_reminder: ["name", "doctor", "hospital", "time", "token"],
  appointment_cancelled: ["doctor", "date", "time", "refund"],
  appointment_rescheduled: ["doctor", "hospital", "date", "time", "token"],
  blood_request_alert: ["units", "group", "place", "city"],
  blood_request_bank_alert: ["units", "group", "place", "city"],
  blood_request_answered: ["group"],
  donation_recorded: ["bank", "date"],
  waitlist_slot_open: ["name", "doctor", "hospital", "date"],
};

export const BODIES: Record<MessageTemplate, Record<Language, string>> = {
  booking_confirmed: {
    en: "MediQ: Booking confirmed. {name} with {doctor} at {hospital} on {date}, {time}. Token {token}. Show your QR code at reception.",
    hi: "MediQ: बुकिंग पक्की हो गई। {name}, {doctor} के साथ {hospital} में {date}, {time} पर। टोकन {token}। रिसेप्शन पर अपना QR कोड दिखाएँ।",
  },
  appointment_reminder: {
    en: "MediQ reminder: {name}'s appointment with {doctor} at {hospital} is today at {time}. Token {token}.",
    hi: "MediQ अनुस्मारक: {name} की {doctor} के साथ {hospital} में अपॉइंटमेंट आज {time} पर है। टोकन {token}।",
  },
  appointment_cancelled: {
    en: "MediQ: Your appointment with {doctor} on {date}, {time} is cancelled. {refund}",
    hi: "MediQ: {doctor} के साथ {date}, {time} की आपकी अपॉइंटमेंट रद्द हो गई है। {refund}",
  },
  appointment_rescheduled: {
    en: "MediQ: Appointment moved to {date}, {time} with {doctor} at {hospital}. Your new token is {token}.",
    hi: "MediQ: अपॉइंटमेंट बदलकर {date}, {time} पर {doctor} के साथ {hospital} में कर दी गई है। आपका नया टोकन {token} है।",
  },
  blood_request_alert: {
    en: "MediQ URGENT: {units} unit(s) of {group} blood needed at {place}, {city}. If you can donate, open MediQ and tap I can help. MediQ only connects people; the blood bank confirms safety.",
    hi: "MediQ ज़रूरी: {place}, {city} में {group} रक्त की {units} यूनिट चाहिए। यदि आप रक्तदान कर सकते हैं तो MediQ खोलकर मदद की पेशकश करें। MediQ केवल लोगों को जोड़ता है; सुरक्षा की पुष्टि ब्लड बैंक करता है।",
  },
  blood_request_bank_alert: {
    en: "MediQ: {units} unit(s) of {group} blood are needed at {place}, {city}. Open your MediQ blood bank page to respond.",
    hi: "MediQ: {place}, {city} में {group} रक्त की {units} यूनिट की ज़रूरत है। जवाब देने के लिए अपना MediQ ब्लड बैंक पेज खोलें।",
  },
  blood_request_answered: {
    en: "MediQ: Someone can help with your {group} blood request. Open your MediQ request page to see who and how to reach them.",
    hi: "MediQ: आपके {group} रक्त अनुरोध में कोई मदद कर सकता है। कौन है और उनसे कैसे संपर्क करें, यह देखने के लिए MediQ अनुरोध पेज खोलें।",
  },
  donation_recorded: {
    en: "MediQ: Thank you for donating blood at {bank}. You can donate again from {date}. If this was not you, tell the blood bank.",
    hi: "MediQ: {bank} में रक्तदान के लिए धन्यवाद। आप {date} से दोबारा रक्तदान कर सकते हैं। यदि यह आप नहीं थे तो ब्लड बैंक को बताएँ।",
  },
  waitlist_slot_open: {
    en: "MediQ: A seat has opened with {doctor} at {hospital} on {date} for {name}. Seats go to whoever books first, so open MediQ now.",
    hi: "MediQ: {hospital} में {doctor} के पास {date} को {name} के लिए एक सीट खाली हुई है। सीट पहले बुक करने वाले को मिलेगी, इसलिए अभी MediQ खोलें।",
  },
};

/** The text for providers that send free text (Twilio, the console mock) and for the README. */
export function renderBody(
  template: MessageTemplate,
  vars: TemplateVars,
  language: Language = DEFAULT_LANGUAGE,
): string {
  return BODIES[template][language].replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

/** Only the variables a template declares (extra values must not reach a DLT provider). */
export function pickVariables(template: MessageTemplate, vars: TemplateVars): TemplateVars {
  return Object.fromEntries(TEMPLATE_VARIABLES[template].map((k) => [k, vars[k] ?? ""]));
}

export function isMessageTemplate(value: string): value is MessageTemplate {
  return value in BODIES;
}

/** DLT registration text for a template: {name} becomes ##name##. */
export function dltText(template: MessageTemplate, language: Language = DEFAULT_LANGUAGE): string {
  return BODIES[template][language].replace(/\{(\w+)\}/g, "##$1##");
}

/** What happened to the money when an appointment was cancelled. */
export type RefundNote =
  | { kind: "POLICY_NONE" }
  | { kind: "ONLINE"; amountText: string }
  | { kind: "CASH"; amountText: string };

/** The sentence that goes in the {refund} slot of the cancellation message, in the patient's language. */
export function refundSentence(note: RefundNote | null, language: Language): string {
  if (!note) return "";
  if (note.kind === "POLICY_NONE") {
    return language === "hi"
      ? "रद्दीकरण नीति के अनुसार कोई रिफंड लागू नहीं है।"
      : "No refund applies under the cancellation policy.";
  }
  if (note.kind === "CASH") {
    return language === "hi"
      ? `${note.amountText} आपको नकद लौटा दिए गए हैं।`
      : `${note.amountText} has been returned to you in cash.`;
  }
  return language === "hi"
    ? `${note.amountText} का रिफंड 5-7 दिनों में आपके खाते में पहुँच जाएगा।`
    : `Refund of ${note.amountText} will reach your account in 5-7 days.`;
}
