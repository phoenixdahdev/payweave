import { describe, expect, it } from "vitest";
import { redact, REDACTED } from "../../src/core/redact";

describe("redact", () => {
  it("masks sensitive key values (case-insensitive)", () => {
    const out = redact({
      Authorization: "Bearer sk_live_abcdef123456",
      secretKey: "sk_live_abcdef123456",
      encryptionKey: "enc-key-value",
      webhookSecret: "hash",
      card_number: "4084084084084081",
      cvv: "123",
      expiryMonth: "09",
      pin: "0000",
      access_token: "tok_abc",
      password: "hunter2",
      email: "ada@example.com",
    }) as Record<string, unknown>;

    expect(out.Authorization).toBe(REDACTED);
    expect(out.secretKey).toBe(REDACTED);
    expect(out.encryptionKey).toBe(REDACTED);
    expect(out.webhookSecret).toBe(REDACTED);
    expect(out.card_number).toBe(REDACTED);
    expect(out.cvv).toBe(REDACTED);
    expect(out.expiryMonth).toBe(REDACTED);
    expect(out.pin).toBe(REDACTED);
    expect(out.access_token).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    // Non-sensitive fields pass through.
    expect(out.email).toBe("ada@example.com");
  });

  it("scrubs secret material from arbitrary string values", () => {
    const out = redact({
      note: "key is sk_test_9f8e7d6c5b and legacy FLWSECK_TEST-deadbeef",
      header: "Authorization: Bearer sk_live_zzz",
    }) as Record<string, string>;
    expect(out.note).not.toContain("sk_test_");
    expect(out.note).not.toContain("FLWSECK");
    // `header` key is not sensitive but its value carries a bearer token.
    expect(out.header).not.toContain("sk_live_");
  });

  it("scrubs mongodb:// / mongodb+srv:// connection strings carrying credentials (PW-709)", () => {
    const out = redact({
      note: "connect via mongodb://dbuser:s3cr3t-P%40ss@cluster0-shard-00-00.abc.mongodb.net:27017/app",
      srv: "mongodb+srv://dbuser:s3cr3t@cluster0.abc.mongodb.net/app?retryWrites=true",
      // No userinfo → no secret → left untouched.
      plain: "mongodb://localhost:27017/app",
    }) as Record<string, string>;
    expect(out.note).not.toContain("s3cr3t-P%40ss");
    expect(out.note).not.toContain("dbuser");
    expect(out.note).toContain(REDACTED);
    expect(out.srv).not.toContain("s3cr3t");
    expect(out.srv).toContain(REDACTED);
    expect(out.plain).toBe("mongodb://localhost:27017/app");
  });

  it("redacts a Headers instance by header name", () => {
    const h = new Headers({ authorization: "Bearer sk_live_x", accept: "application/json" });
    const out = redact(h) as Record<string, unknown>;
    expect(out.authorization).toBe(REDACTED);
    expect(out.accept).toBe("application/json");
  });

  it("handles arrays, Maps, bigint, binary, functions, and cycles", () => {
    const map = new Map<string, unknown>([
      ["secret", "s"],
      ["ok", 1],
    ]);
    expect(redact(map)).toEqual({ secret: REDACTED, ok: 1 });
    expect(redact([1, "sk_live_x"])).toEqual([1, REDACTED]);
    expect(redact(10n)).toBe("10");
    expect(redact(new Uint8Array([1, 2, 3]))).toBe("[binary]");
    expect(redact(() => 0)).toBeUndefined();

    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redact(cyclic) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.self).toBe("[Circular]");
  });

  it("masks a postgres:// connection string wherever it appears (database.md §7/§8, PW-704)", () => {
    const url = "postgres://app_user:s3cr3t-p4ss@db.example.com:5432/payweave?sslmode=require";
    // Bare string value (e.g. surfaced inside an Error message).
    const outStr = redact(`connecting failed: ${url}`) as string;
    expect(outStr).not.toContain("s3cr3t-p4ss");
    expect(outStr).not.toContain(url);
    expect(outStr).toContain(REDACTED);

    // Nested config object under an innocuous key name.
    const outObj = redact({ database: { options: { connectionString: url } } }) as {
      database: { options: { connectionString: string } };
    };
    expect(outObj.database.options.connectionString).toBe(REDACTED);

    // `postgresql://` scheme variant, and a `DATABASE_URL`-named field.
    const outEnv = redact({ DATABASE_URL: url.replace("postgres://", "postgresql://") }) as Record<
      string,
      unknown
    >;
    expect(outEnv.DATABASE_URL).toBe(REDACTED);
  });

  it("snapshot: no secret material survives serialization", () => {
    const serialized = JSON.stringify(
      redact({
        headers: { Authorization: "Bearer sk_live_SUPERSECRET" },
        config: { secretKey: "sk_test_abc", webhookSecret: "FLWSECK_TEST-xyz" },
        card: { card_number: "4084084084084081", cvv: "999" },
      }),
    );
    for (const leak of ["sk_live_", "sk_test_", "FLWSECK", "4084084084084081", "999"]) {
      expect(serialized).not.toContain(leak);
    }
  });
});
