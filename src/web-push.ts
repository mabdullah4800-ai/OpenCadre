import { createECDH, createPrivateKey, randomBytes, sign, createCipheriv, hkdfSync } from "node:crypto";

/** Web Push without a dependency: message encryption (RFC 8291, aes128gcm) and VAPID sender
 * identification (RFC 8292), on node:crypto only. The push service (Google, Mozilla, Apple, Microsoft)
 * sees only ciphertext; the browser that subscribed holds the only key that opens it. */

export const b64url = (buf: Buffer) => buf.toString("base64url");
export const fromB64url = (s: string) => Buffer.from(s, "base64url");

const RECORD_SIZE = 4096;

export interface ReceiverKeys {
  /** The subscription's P-256 public key, uncompressed (65 bytes), base64url. */
  p256dh: string;
  /** The subscription's 16-byte auth secret, base64url. */
  auth: string;
}

/** Encrypts one push message body. `salt` and `senderPrivateKey` exist for the RFC 8291 test vector;
 * real sends leave them out so each message gets a fresh salt and ephemeral key. */
export function encryptPushPayload(
  plaintext: Buffer,
  keys: ReceiverKeys,
  fixed: { salt?: Buffer; senderPrivateKey?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh must be an uncompressed P-256 public key");
  if (authSecret.length !== 16) throw new Error("auth must be 16 bytes");
  // Content encryption appends one delimiter byte and a 16-byte tag, and everything goes in a single record.
  if (plaintext.length + 1 + 16 + 86 > RECORD_SIZE) throw new Error("push payload too large");

  const sender = createECDH("prime256v1");
  if (fixed.senderPrivateKey) sender.setPrivateKey(fixed.senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const salt = fixed.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (what the browser's applicationServerKey takes). */
  publicKey: string;
  /** The 32-byte private scalar, base64url. */
  privateKey: string;
  /** A contact for push services, e.g. mailto:ops@example.com. */
  subject: string;
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/** The Authorization header value for one push service origin (RFC 8292): a 12-hour ES256 JWT plus the public key. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const pub = fromB64url(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("VAPID public key must be an uncompressed P-256 key");
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) },
    format: "jwk",
  });
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: keys.subject })));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

export function vapidKeysFromEnv(env = process.env): VapidKeys | null {
  const publicKey = env.OPENCADRE_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.OPENCADRE_VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: env.OPENCADRE_VAPID_SUBJECT?.trim() || "mailto:admin@opencadre.example" };
}
