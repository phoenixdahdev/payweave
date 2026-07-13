import { describe, expect, it } from "vitest";
import {
  encodeStripeForm,
  STRIPE_FORM_CONTENT_TYPE,
} from "../../src/stripe/form-encoding";
import { PayweaveValidationError } from "../../src/core/errors";

describe("encodeStripeForm — content type", () => {
  it("always returns application/x-www-form-urlencoded", () => {
    expect(encodeStripeForm({}).contentType).toBe("application/x-www-form-urlencoded");
    expect(encodeStripeForm({ a: 1 }).contentType).toBe(STRIPE_FORM_CONTENT_TYPE);
  });

  it("never produces a JSON body", () => {
    const { body } = encodeStripeForm({ amount: 500, metadata: { order_id: "8123" } });
    expect(body.startsWith("{")).toBe(false);
    expect(() => JSON.parse(body) as unknown).toThrow();
  });
});

describe("encodeStripeForm — scalars", () => {
  it("passes strings through and stringifies numbers and booleans", () => {
    expect(
      encodeStripeForm({ currency: "usd", amount: 500, capture: true, livemode: false }).body,
    ).toBe("currency=usd&amount=500&capture=true&livemode=false");
  });

  it("stringifies zero, negatives, and floats exactly like String()", () => {
    expect(encodeStripeForm({ a: 0, b: -7, c: 1.5 }).body).toBe("a=0&b=-7&c=1.5");
  });

  it("omits null and undefined values entirely (unset is an explicit empty string)", () => {
    expect(encodeStripeForm({ a: null, b: undefined, c: "keep" }).body).toBe("c=keep");
    // Stripe's unset convention: the caller sends "" explicitly.
    expect(encodeStripeForm({ description: "" }).body).toBe("description=");
  });
});

describe("encodeStripeForm — nested objects (bracket notation)", () => {
  it("encodes a metadata map exactly as the docs example (metadata[order_id]=6735)", () => {
    // https://docs.stripe.com/api/metadata curl example — verified 2026-07-12.
    expect(encodeStripeForm({ metadata: { order_id: "6735" } }).body).toBe(
      "metadata[order_id]=6735",
    );
  });

  it("encodes objects nested two+ levels deep", () => {
    const { body } = encodeStripeForm({
      payment_intent_data: {
        shipping: {
          name: "Ada",
          address: { line1: "1 Main St", city: "Lagos" },
        },
      },
    });
    expect(body).toBe(
      "payment_intent_data[shipping][name]=Ada" +
        "&payment_intent_data[shipping][address][line1]=1%20Main%20St" +
        "&payment_intent_data[shipping][address][city]=Lagos",
    );
  });

  it("omits null/undefined leaves inside nested objects", () => {
    expect(
      encodeStripeForm({ metadata: { keep: "1", drop: null, gone: undefined } }).body,
    ).toBe("metadata[keep]=1");
  });

  it("contributes nothing for empty objects at any depth", () => {
    expect(encodeStripeForm({ metadata: {}, after: "x" }).body).toBe("after=x");
    expect(encodeStripeForm({}).body).toBe("");
  });
});

describe("encodeStripeForm — arrays (explicit indices)", () => {
  it("encodes arrays of scalars with ascending indices (expand)", () => {
    // Docs' curl shows expand[]=customer (https://docs.stripe.com/api/expanding_objects,
    // verified 2026-07-12); we emit explicit indices — Stripe parses both.
    expect(encodeStripeForm({ expand: ["customer", "payment_intent.customer"] }).body).toBe(
      "expand[0]=customer&expand[1]=payment_intent.customer",
    );
  });

  it("encodes arrays of objects like the checkout.sessions.create docs example", () => {
    // https://docs.stripe.com/api/checkout/sessions/create — verified 2026-07-12:
    // -d "line_items[0][price]=..." -d "line_items[0][quantity]=2"
    const { body } = encodeStripeForm({
      mode: "payment",
      line_items: [
        { price: "price_1", quantity: 2 },
        { price: "price_2", quantity: 1 },
      ],
    });
    expect(body).toBe(
      "mode=payment" +
        "&line_items[0][price]=price_1&line_items[0][quantity]=2" +
        "&line_items[1][price]=price_2&line_items[1][quantity]=1",
    );
  });

  it("supports arrays nested inside objects inside arrays", () => {
    const { body } = encodeStripeForm({
      line_items: [{ price_data: { product_data: { images: ["a.png", "b.png"] } } }],
    });
    expect(body).toBe(
      "line_items[0][price_data][product_data][images][0]=a.png" +
        "&line_items[0][price_data][product_data][images][1]=b.png",
    );
  });

  it("keeps positional indices when an element is omitted as null/undefined", () => {
    expect(encodeStripeForm({ arr: ["a", null, "b", undefined] }).body).toBe(
      "arr[0]=a&arr[2]=b",
    );
  });

  it("contributes nothing for empty arrays", () => {
    expect(encodeStripeForm({ expand: [], after: "x" }).body).toBe("after=x");
  });
});

describe("encodeStripeForm — percent-encoding", () => {
  it("encodes reserved characters in values: & = + space %", () => {
    expect(encodeStripeForm({ v: "a&b=c+d e%f" }).body).toBe("v=a%26b%3Dc%2Bd%20e%25f");
  });

  it("encodes reserved characters in keys and nested keys", () => {
    expect(encodeStripeForm({ "a&b": "1" }).body).toBe("a%26b=1");
    expect(encodeStripeForm({ metadata: { "k =v": "1" } }).body).toBe("metadata[k%20%3Dv]=1");
  });

  it("percent-encodes unicode as UTF-8", () => {
    expect(encodeStripeForm({ metadata: { name: "Böhm 木" } }).body).toBe(
      "metadata[name]=B%C3%B6hm%20%E6%9C%A8",
    );
  });

  it("keeps structural brackets literal (matches the docs' wire format)", () => {
    const { body } = encodeStripeForm({ metadata: { order_id: "8123" } });
    expect(body).toContain("metadata[order_id]");
    expect(body).not.toContain("%5B");
  });
});

describe("encodeStripeForm — determinism (insertion order)", () => {
  it("emits keys in insertion order, never sorted", () => {
    expect(encodeStripeForm({ b: "1", a: "2" }).body).toBe("b=1&a=2");
    expect(encodeStripeForm({ a: "2", b: "1" }).body).toBe("a=2&b=1");
  });

  it("encodes the same input to identical bytes every time", () => {
    const body = {
      mode: "payment",
      line_items: [{ price: "price_1", quantity: 2 }],
      metadata: { pwv_reference: "ref_1", note: "Böhm & Co" },
      expand: ["payment_intent"],
    };
    const first = encodeStripeForm(body);
    const second = encodeStripeForm(body);
    const third = encodeStripeForm(structuredClone(body));
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});

describe("encodeStripeForm — rejects what it cannot represent", () => {
  it("throws PayweaveValidationError for non-object top-level bodies", () => {
    for (const bad of ["str", 42, true, null, undefined, ["a"], new Date()]) {
      expect(() => encodeStripeForm(bad)).toThrow(PayweaveValidationError);
    }
  });

  it("throws for non-finite numbers, naming the key path", () => {
    expect(() => encodeStripeForm({ amount: Number.NaN })).toThrow(PayweaveValidationError);
    expect(() => encodeStripeForm({ tier: { up_to: Infinity } })).toThrow(/tier\[up_to\]/);
  });

  it("throws for Dates, functions, and class instances, naming the key path", () => {
    expect(() => encodeStripeForm({ created: new Date() })).toThrow(/Unix timestamp/);
    expect(() => encodeStripeForm({ cb: () => 1 })).toThrow(PayweaveValidationError);
    expect(() => encodeStripeForm({ nested: { map: new Map() } })).toThrow(/nested\[map\]/);
  });
});
