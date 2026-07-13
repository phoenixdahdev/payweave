import { describe, expect, it } from "vitest";
import { verifyStripe } from "../../src/webhooks/stripe";
import { signWebhook } from "../../src/testing/sign-webhook";

const SECRET = "whsec_test_signing_secret";
const payload = {
  id: "evt_1AbCdEf",
  type: "payment_intent.succeeded",
  data: { object: { id: "pi_1", status: "succeeded" } },
};
const T = 1_752_300_000; // fixed Unix seconds
const at = (sec: number) => ({ now: () => sec });

/** `t=` and `v1=` parts of a signed header, for recombination tests. */
function parts(header: string): { tPart: string; v1Part: string; sig: string } {
  const [tPart, v1Part] = header.split(",") as [string, string];
  return { tPart, v1Part, sig: v1Part.slice("v1=".length) };
}

describe("verifyStripe (HMAC-SHA256 hex over `${t}.${body}`)", () => {
  const signed = signWebhook("stripe", payload, SECRET, { timestamp: T });

  it("accepts a valid vector (injected clock at t)", () => {
    expect(verifyStripe(signed.body, signed.header, SECRET, at(T))).toBe(true);
  });

  it("accepts a fresh vector with the real default clock", () => {
    const live = signWebhook("stripe", payload, SECRET);
    expect(verifyStripe(live.body, live.header, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyStripe(signed.body + " ", signed.header, SECRET, at(T))).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyStripe(signed.body, signed.header, "whsec_wrong", at(T))).toBe(false);
  });

  it("rejects an empty secret (fails closed)", () => {
    expect(verifyStripe(signed.body, signed.header, "", at(T))).toBe(false);
  });

  it("rejects a missing header (fails closed)", () => {
    expect(verifyStripe(signed.body, undefined, SECRET, at(T))).toBe(false);
    expect(verifyStripe(signed.body, null, SECRET, at(T))).toBe(false);
  });

  it("rejects an empty-string header", () => {
    expect(verifyStripe(signed.body, "", SECRET, at(T))).toBe(false);
  });

  describe("malformed headers (all fail closed)", () => {
    const { tPart, v1Part } = parts(signed.header);

    it("rejects garbage with no key=value items", () => {
      expect(verifyStripe(signed.body, "not-a-signature-header", SECRET, at(T))).toBe(false);
    });

    it("rejects a header with no t", () => {
      expect(verifyStripe(signed.body, v1Part, SECRET, at(T))).toBe(false);
    });

    it("rejects a header with no v1", () => {
      expect(verifyStripe(signed.body, tPart, SECRET, at(T))).toBe(false);
    });

    it("rejects a non-numeric t", () => {
      expect(verifyStripe(signed.body, `t=soon,${v1Part}`, SECRET, at(T))).toBe(false);
    });

    it("rejects an empty t value", () => {
      expect(verifyStripe(signed.body, `t=,${v1Part}`, SECRET, at(T))).toBe(false);
    });

    it("rejects a duplicate t (ambiguous)", () => {
      expect(
        verifyStripe(signed.body, `${tPart},t=${T + 1},${v1Part}`, SECRET, at(T)),
      ).toBe(false);
    });

    it("rejects an item without `=` alongside valid items", () => {
      expect(verifyStripe(signed.body, `${tPart},v1,${v1Part}`, SECRET, at(T))).toBe(false);
    });

    it("rejects a wrong-length v1", () => {
      expect(verifyStripe(signed.body, `${tPart},v1=abc123`, SECRET, at(T))).toBe(false);
    });

    it("rejects a right-length non-hex v1", () => {
      expect(
        verifyStripe(signed.body, `${tPart},v1=${"z".repeat(64)}`, SECRET, at(T)),
      ).toBe(false);
    });
  });

  describe("timestamp tolerance (±300s default)", () => {
    it("rejects a stale timestamp (> 300s past)", () => {
      expect(verifyStripe(signed.body, signed.header, SECRET, at(T + 301))).toBe(false);
    });

    it("rejects a future timestamp (> 300s ahead)", () => {
      expect(verifyStripe(signed.body, signed.header, SECRET, at(T - 301))).toBe(false);
    });

    it("accepts exactly at the tolerance boundary, both directions", () => {
      expect(verifyStripe(signed.body, signed.header, SECRET, at(T + 300))).toBe(true);
      expect(verifyStripe(signed.body, signed.header, SECRET, at(T - 300))).toBe(true);
    });

    it("honors a custom toleranceSec", () => {
      const wide = { toleranceSec: 500, now: () => T + 400 };
      const narrow = { toleranceSec: 100, now: () => T + 150 };
      expect(verifyStripe(signed.body, signed.header, SECRET, wide)).toBe(true);
      expect(verifyStripe(signed.body, signed.header, SECRET, narrow)).toBe(false);
    });
  });

  describe("multiple signatures / schemes", () => {
    const { tPart, v1Part, sig } = parts(signed.header);

    it("accepts when only the SECOND v1 matches (secret-roll window)", () => {
      const header = `${tPart},v1=${"a".repeat(64)},${v1Part}`;
      expect(verifyStripe(signed.body, header, SECRET, at(T))).toBe(true);
    });

    it("rejects when every v1 is invalid", () => {
      const header = `${tPart},v1=${"a".repeat(64)},v1=${"b".repeat(64)}`;
      expect(verifyStripe(signed.body, header, SECRET, at(T))).toBe(false);
    });

    it("rejects a v0-only header even if its value is the correct digest", () => {
      expect(verifyStripe(signed.body, `${tPart},v0=${sig}`, SECRET, at(T))).toBe(false);
    });

    it("ignores v0 alongside a valid v1", () => {
      const header = `${tPart},v0=${"f".repeat(64)},${v1Part}`;
      expect(verifyStripe(signed.body, header, SECRET, at(T))).toBe(true);
    });
  });

  describe("body encodings", () => {
    it("verifies a unicode/multibyte body and rejects multibyte tampering", () => {
      const uni = signWebhook("stripe", { note: "café ✅ — ₦1,000 😄" }, SECRET, {
        timestamp: T,
      });
      expect(verifyStripe(uni.body, uni.header, SECRET, at(T))).toBe(true);
      expect(verifyStripe(uni.body.replace("😄", "😡"), uni.header, SECRET, at(T))).toBe(false);
    });

    it("accepts a Uint8Array raw body (exact bytes)", () => {
      const bytes = new TextEncoder().encode(signed.body);
      expect(verifyStripe(bytes, signed.header, SECRET, at(T))).toBe(true);
    });

    it("rejects tampered Uint8Array bytes", () => {
      const bytes = new TextEncoder().encode(signed.body);
      const tampered = bytes.slice();
      tampered[0] = tampered[0]! ^ 0xff;
      expect(verifyStripe(tampered, signed.header, SECRET, at(T))).toBe(false);
    });
  });

  describe("header whitespace tolerance (proxy `, ` normalization)", () => {
    const { tPart, v1Part } = parts(signed.header);

    it("accepts a valid header with spaces after the comma", () => {
      expect(verifyStripe(signed.body, `${tPart}, ${v1Part}`, SECRET, at(T))).toBe(true);
    });

    it("accepts a valid header with tabs/spaces padding whole items", () => {
      expect(verifyStripe(signed.body, ` ${tPart} ,\t${v1Part} `, SECRET, at(T))).toBe(true);
    });

    it("still rejects whitespace INSIDE an item (scheme mismatch fails closed)", () => {
      const spacedT = tPart.replace("t=", "t ="); // `t =123` → unknown scheme → no timestamp
      expect(verifyStripe(signed.body, `${spacedT}, ${v1Part}`, SECRET, at(T))).toBe(false);
    });
  });

  describe("runtime type guards (never throws for plain-JS callers)", () => {
    const anyVerify = verifyStripe as unknown as (...args: unknown[]) => boolean;

    it("returns false (not throw) for non-string secrets", () => {
      for (const bad of [undefined, null, 42, { whsec: "x" }]) {
        expect(anyVerify(signed.body, signed.header, bad, at(T))).toBe(false);
      }
    });

    it("returns false (not throw) for non-string/Uint8Array bodies", () => {
      for (const bad of [undefined, null, 42, {}, ["x"]]) {
        expect(anyVerify(bad, signed.header, SECRET, at(T))).toBe(false);
      }
    });

    it("returns false (not throw) for a non-string header object", () => {
      expect(anyVerify(signed.body, { toString: () => signed.header }, SECRET, at(T))).toBe(false);
    });

    it("still accepts an EMPTY STRING body (legitimate signable payload, not a falsy reject)", () => {
      const empty = signWebhook("stripe", "", SECRET, { timestamp: T });
      expect(verifyStripe("", empty.header, SECRET, at(T))).toBe(true);
    });
  });
});
