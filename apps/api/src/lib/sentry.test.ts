import type { ErrorEvent } from "@sentry/node";
import { describe, expect, it } from "vitest";
import { maskPersonalText, scrubEvent } from "./sentry.js";

describe("Sentry scrubbing", () => {
  it("masks phone numbers and emails in text", () => {
    expect(maskPersonalText("OTP failed for +91 98765 43210")).toBe("OTP failed for [number]");
    expect(maskPersonalText("mail rahul.s@example.com now")).toBe("mail [email] now");
    expect(maskPersonalText("token 12 at 9:30")).toBe("token 12 at 9:30");
  });

  it("removes bodies, cookies, headers, query strings and identifying user fields", () => {
    const event = {
      type: undefined,
      request: {
        url: "https://api.example.in/api/v1/desk/appointments?search=Rahul%20Sharma",
        data: { fullName: "Rahul Sharma", phone: "+919876543210" },
        cookies: { refresh: "secret" },
        headers: { authorization: "Bearer abc" },
        query_string: "search=Rahul",
      },
      user: { id: "u1", email: "a@b.co", ip_address: "1.2.3.4", username: "rahul" },
      message: "Failed for 9876543210",
      exception: { values: [{ type: "Error", value: "bad number +91 98765 43210" }] },
      breadcrumbs: [{ message: "call a@b.co", data: { phone: "9876543210" } }],
    } as unknown as ErrorEvent;

    const out = scrubEvent(event);
    expect(out.request).toEqual({ url: "https://api.example.in/api/v1/desk/appointments" });
    expect(out.user).toEqual({ id: "u1" });
    expect(out.message).toBe("Failed for [number]");
    expect(out.exception?.values?.[0]?.value).toBe("bad number [number]");
    expect(out.breadcrumbs?.[0]).toEqual({ message: "call [email]" });
    expect(JSON.stringify(out)).not.toMatch(/Rahul|secret|Bearer|9876543210/);
  });
});
