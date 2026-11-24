#!/usr/bin/env node
// Generates the hub's Web Push (VAPID) key pair as .env lines. The private key must never be shown, so this
// refuses to write to a terminal: append it straight into the env file instead, on the VPS:
//
//   sudo sh -c 'node gen-vapid-keys.mjs >> /opt/opencadre/.env'
//
// Only generate once. New keys invalidate every phone that already turned notifications on
// (each has to turn them on again), so rotate only if the private key leaked.
import { createECDH } from "node:crypto";

if (process.stdout.isTTY) {
  console.error("Refusing to print a private key to the terminal. Redirect into the env file: node gen-vapid-keys.mjs >> /opt/opencadre/.env");
  process.exit(2);
}
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
process.stdout.write(
  `OPENCADRE_VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString("base64url")}\n` +
  `OPENCADRE_VAPID_PRIVATE_KEY=${ecdh.getPrivateKey().toString("base64url")}\n` +
  `OPENCADRE_VAPID_SUBJECT=mailto:admin@opencadre.example\n`,
);
