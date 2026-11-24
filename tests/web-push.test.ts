import { createECDH, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPushPayload, fromB64url, generateVapidKeys, vapidAuthorization, b64url } from "../src/web-push.js";

describe("web push encryption (RFC 8291)", () => {
  it("reproduces the RFC's example message byte for byte", () => {
    // RFC 8291 section 5 and appendix A.
    const body = encryptPushPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
      { salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw"), senderPrivateKey: fromB64url("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
    );
    expect(b64url(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
      "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
      "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("uses a fresh salt and sender key for every real send", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const keys = { p256dh: b64url(ua.getPublicKey()), auth: b64url(Buffer.alloc(16, 7)) };
    const a = encryptPushPayload(Buffer.from("same"), keys);
    const b = encryptPushPayload(Buffer.from("same"), keys);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
  });

  it("refuses malformed subscription keys and oversized payloads", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const good = { p256dh: b64url(ua.getPublicKey()), auth: b64url(Buffer.alloc(16)) };
    expect(() => encryptPushPayload(Buffer.from("x"), { ...good, p256dh: b64url(Buffer.alloc(33)) })).toThrow(/p256dh/);
    expect(() => encryptPushPayload(Buffer.from("x"), { ...good, auth: b64url(Buffer.alloc(8)) })).toThrow(/auth/);
    expect(() => encryptPushPayload(Buffer.alloc(4000), good)).toThrow(/too large/);
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs a JWT for the push service's origin that verifies with the public key", () => {
    const keys = { ...generateVapidKeys(), subject: "mailto:ops@example.com" };
    const now = 1_800_000_000;
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc123", keys, now);
    const match = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
    expect(match).not.toBeNull();
    const [, h, c, s, k] = match;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(fromB64url(h).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(fromB64url(c).toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: now + 43_200, sub: "mailto:ops@example.com" });

    const pub = fromB64url(keys.publicKey);
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, fromB64url(s))).toBe(true);
  });
});
