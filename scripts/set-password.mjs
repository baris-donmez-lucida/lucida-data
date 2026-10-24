// Create (or re-seal) keys.json with a viewing password.
//
//   LUCIDA_PASSWORD='…' node scripts/set-password.mjs           # new key pair (re-run build.mjs afterwards)
//   LUCIDA_PASSWORD='…' OLD_PASSWORD='…' node scripts/set-password.mjs   # change password, keep key pair
//
// The password itself is never written anywhere; only the RSA private key sealed with it is stored.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { subtle } = globalThis.crypto;
const password = process.env.LUCIDA_PASSWORD;
if (!password || password.length < 8) { console.error("set LUCIDA_PASSWORD (8+ characters)"); process.exit(2); }

const ITERATIONS = 310000;
const b64 = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const kekFor = async (pw, salt, iterations, usage) => {
  const base = await subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, [usage]);
};

let publicKey, privateJwk;
const path = join(root, "keys.json");
if (process.env.OLD_PASSWORD && existsSync(path)) {
  const old = JSON.parse(readFileSync(path, "utf8"));
  const s = old.sealedPrivateKey;
  const kek = await kekFor(process.env.OLD_PASSWORD, unb64(s.salt), s.iterations, "decrypt");
  privateJwk = JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, kek, unb64(s.ct))));
  publicKey = old.publicKey;
} else {
  const pair = await subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]);
  publicKey = await subtle.exportKey("jwk", pair.publicKey);
  privateJwk = await subtle.exportKey("jwk", pair.privateKey);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const kek = await kekFor(password, salt, ITERATIONS, "encrypt");
const ct = await subtle.encrypt({ name: "AES-GCM", iv }, kek, new TextEncoder().encode(JSON.stringify(privateJwk)));
writeFileSync(path, JSON.stringify({ v: 1, publicKey, sealedPrivateKey: { kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) } }, null, 2) + "\n");
console.log("keys.json written");
