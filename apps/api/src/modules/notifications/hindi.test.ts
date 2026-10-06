import { describe, expect, it, vi } from "vitest";
import { Msg91Provider } from "../../services/sms/index.js";
import { isLanguage, toLanguage } from "../../utils/language.js";
import {
  BODIES,
  TEMPLATE_VARIABLES,
  dltText,
  refundSentence,
  renderBody,
  type MessageTemplate,
} from "./templates.js";

const templates = Object.keys(TEMPLATE_VARIABLES) as MessageTemplate[];
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
const DEVANAGARI = /[ऀ-ॿ]/;

describe("Hindi message texts", () => {
  it("exist for every template, with exactly the placeholders of the English text", () => {
    for (const t of templates) {
      expect(BODIES[t].hi, t).toBeTruthy();
      expect(placeholders(BODIES[t].hi), t).toEqual(placeholders(BODIES[t].en));
      expect(placeholders(BODIES[t].hi), t).toEqual([...TEMPLATE_VARIABLES[t]].sort());
    }
  });

  it("are Hindi, start with the brand, and leave no placeholder unfilled", () => {
    const vars = Object.fromEntries(
      [...new Set(templates.flatMap((t) => TEMPLATE_VARIABLES[t]))].map((k) => [k, `<${k}>`]),
    );
    for (const t of templates) {
      const text = renderBody(t, vars, "hi");
      expect(text, t).toMatch(DEVANAGARI);
      expect(text, t).toMatch(/^MediQ/);
      expect(text, t).not.toMatch(/[{}]/);
    }
  });

  it("render with the patient's own values", () => {
    const text = renderBody(
      "booking_confirmed",
      {
        name: "Sunita",
        doctor: "Dr. Mehta",
        hospital: "City Hospital",
        date: "12 Oct",
        time: "9:30 am",
        token: "7",
      },
      "hi",
    );
    expect(text).toContain("Sunita");
    expect(text).toContain("Dr. Mehta");
    expect(text).toContain("टोकन 7");
  });

  it("give the Hindi text to register with the SMS regulator", () => {
    expect(dltText("waitlist_slot_open", "hi")).toBe(
      "MediQ: ##hospital## में ##doctor## के पास ##date## को ##name## के लिए एक सीट खाली हुई है। सीट पहले बुक करने वाले को मिलेगी, इसलिए अभी MediQ खोलें।",
    );
    expect(dltText("waitlist_slot_open")).toContain("##doctor##");
  });

  it("do not include the English text by accident", () => {
    for (const t of templates) {
      expect(BODIES[t].hi).not.toBe(BODIES[t].en);
    }
  });
});

describe("the refund sentence", () => {
  it("is said in the patient's language, and empty when no money was involved", () => {
    expect(refundSentence(null, "en")).toBe("");
    expect(refundSentence(null, "hi")).toBe("");
    expect(refundSentence({ kind: "ONLINE", amountText: "Rs.500" }, "en")).toBe(
      "Refund of Rs.500 will reach your account in 5-7 days.",
    );
    expect(refundSentence({ kind: "ONLINE", amountText: "Rs.500" }, "hi")).toContain("Rs.500");
    expect(refundSentence({ kind: "ONLINE", amountText: "Rs.500" }, "hi")).toMatch(DEVANAGARI);
    expect(refundSentence({ kind: "CASH", amountText: "Rs.500" }, "en")).toContain("in cash");
    expect(refundSentence({ kind: "CASH", amountText: "Rs.500" }, "hi")).toMatch(DEVANAGARI);
    expect(refundSentence({ kind: "POLICY_NONE" }, "en")).toContain("No refund applies");
    expect(refundSentence({ kind: "POLICY_NONE" }, "hi")).toMatch(DEVANAGARI);
  });
});

describe("language values", () => {
  it("accept only the languages we have text for", () => {
    expect(isLanguage("hi")).toBe(true);
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage("fr")).toBe(false);
    expect(isLanguage(null)).toBe(false);
    expect(toLanguage("hi")).toBe("hi");
    expect(toLanguage("fr")).toBe("en");
    expect(toLanguage(undefined)).toBe("en");
  });
});

describe("MSG91 and Hindi", () => {
  const send = async (language: "en" | "hi" | undefined, hindi: Record<string, string>) => {
    const f = vi.fn(
      async () => new Response(JSON.stringify({ type: "success", message: "ok" }), { status: 200 }),
    );
    await new Msg91Provider(
      "auth",
      { booking_confirmed: "en_tpl" },
      f as unknown as typeof fetch,
      hindi,
    ).send({
      to: "+919876543210",
      template: "booking_confirmed",
      body: "",
      language,
    });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    return JSON.parse(init.body as string).template_id as string;
  };

  it("uses the Hindi template when there is one", async () => {
    expect(await send("hi", { booking_confirmed: "hi_tpl" })).toBe("hi_tpl");
  });

  it("sends English when the Hindi text is not registered yet, or the patient uses English", async () => {
    expect(await send("hi", {})).toBe("en_tpl");
    expect(await send("en", { booking_confirmed: "hi_tpl" })).toBe("en_tpl");
    expect(await send(undefined, { booking_confirmed: "hi_tpl" })).toBe("en_tpl");
  });
});
