// Seal the dashboard data for the public site.
//
//   node scripts/build.mjs <docs-dir>
//
// <docs-dir> holds the six documents of the claude.ai artifact's "metrics" collection as JSON files
// (ders-baslatma.json, dau.json, cohorts.json, a1-session-time.json, retention.json, weekly-lessons.json),
// e.g. as written by ArtifactData `list` with `out_dir` (they land in <out_dir>/metrics/).
// Validates them, then writes data.enc.json: the payload under a fresh AES-256-GCM key, that key wrapped
// with the RSA-OAEP public key in keys.json. No password is needed here; only the page can decrypt.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/build.mjs <docs-dir>"); process.exit(2); }

const COUNTRIES = ["Japan", "South Korea", "Poland", "United States", "Czech Republic"];
const num = (v) => typeof v === "number" && Number.isFinite(v);
const fail = (msg) => { console.error("invalid data: " + msg); process.exit(1); };

const read = (id) => {
  const p = join(dir, id + ".json");
  if (!existsSync(p)) fail(`${p} missing`);
  const doc = JSON.parse(readFileSync(p, "utf8"));
  // ArtifactData out_dir files may wrap the fields in { data: ... }
  return doc && doc.data && !doc.updatedAt ? doc.data : doc;
};

const docs = {
  "ders-baslatma": read("ders-baslatma"),
  "dau": read("dau"),
  "cohorts": read("cohorts"),
  "a1-session-time": read("a1-session-time"),
  "retention": read("retention"),
  "weekly-lessons": read("weekly-lessons"),
};

for (const [id, d] of Object.entries(docs)) if (!d.updatedAt || isNaN(Date.parse(d.updatedAt))) fail(`${id}.updatedAt`);
const f = docs["ders-baslatma"];
if (!Array.isArray(f.counts) || f.counts.length !== 2 || !f.counts.every((r) => Array.isArray(r) && r.length === 8 && r.every(num))) fail("ders-baslatma.counts must be 2 × 8 numbers");
const d = docs.dau;
if (!Array.isArray(d.days) || !Array.isArray(d.values) || !d.values.length || d.days.length !== d.values.length || !d.values.every(num) || !num(d.overall)) fail("dau days/values/overall");
const c = docs.cohorts;
for (const id of ["we8ecx07", "mkec0q4p"]) if (!num(c.sizes?.[id]?.size)) fail(`cohorts.sizes.${id}.size`);
const l = docs["a1-session-time"];
if (!Array.isArray(l.items) || l.items.length !== 5 || !l.items.every((it) => it.id && ["started", "completed", "medianMs", "avgMs"].every((k) => num(it[k])))) fail("a1-session-time.items");
const r = docs.retention;
if (!num(r.total)) fail("retention.total");
for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "14", "15", "21", "22"]) if (!num(r.values?.[k])) fail(`retention.values.${k}`);
if (r.byCountry && !Array.isArray(r.byCountry)) fail("retention.byCountry");
const w = docs["weekly-lessons"];
if (!Array.isArray(w.items) || !w.items.length || !w.items.every((it) => COUNTRIES.includes(it.id) && num(it.start) && num(it.done))) fail("weekly-lessons.items");

const { subtle } = globalThis.crypto;
const keys = JSON.parse(readFileSync(join(root, "keys.json"), "utf8"));
const pub = await subtle.importKey("jwk", keys.publicKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
const dek = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await subtle.encrypt({ name: "AES-GCM", iv }, dek, new TextEncoder().encode(JSON.stringify(docs)));
const wrappedKey = await subtle.wrapKey("raw", dek, pub, { name: "RSA-OAEP" });
const b64 = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString("base64");

const latest = Object.values(docs).map((x) => x.updatedAt).sort().pop();
writeFileSync(join(root, "data.enc.json"), JSON.stringify({ v: 1, sealedAt: new Date().toISOString(), wrappedKey: b64(wrappedKey), iv: b64(iv), ct: b64(ct) }) + "\n");
console.log(`data.enc.json written (latest updatedAt ${latest})`);
