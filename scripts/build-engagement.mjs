// Seal the Engagement page's history for the public site.
//
//   node scripts/build-engagement.mjs <docs-dir>
//
// <docs-dir> holds the documents of the claude.ai artifact's "engagement" collection as JSON files, one per metric
// (<metric id>.json, e.g. as written by ArtifactData `list` with `out_dir`: <out_dir>/engagement/). Each document is
// { updatedAt, points: [{ d: "YYYY-MM-DD", v: number, n?: number, of?: number, parts?: { <key>: number } }] } — one point
// per UTC day (parts = the components v is made of, labelled by the metric's `parts` in metrics.json), the whole
// history kept so the page can draw timelines without asking Amplitude/RevenueCat again.
// Metric ids must be listed in engagement/metrics.json. Writes engagement.enc.json, sealed like data.enc.json.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/build-engagement.mjs <docs-dir>"); process.exit(2); }

const num = (v) => typeof v === "number" && Number.isFinite(v);
const fail = (msg) => { console.error("invalid data: " + msg); process.exit(1); };

const registry = JSON.parse(readFileSync(join(root, "engagement", "metrics.json"), "utf8"));
const known = new Set(registry.metrics.map((m) => m.id));

const metrics = {};
for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []) {
  const id = file.slice(0, -5);
  if (!known.has(id)) { console.warn(`skip ${file}: not in engagement/metrics.json`); continue; }
  let doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
  // ArtifactData out_dir files may wrap the fields in { data: ... }
  if (doc && doc.data && !doc.updatedAt) doc = doc.data;
  if (!doc.updatedAt || isNaN(Date.parse(doc.updatedAt))) fail(`${id}.updatedAt`);
  if (!Array.isArray(doc.points)) fail(`${id}.points`);
  let prev = "";
  for (const p of doc.points) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p?.d || "") || !num(p.v)) fail(`${id}.points: ${JSON.stringify(p)}`);
    if (p.d <= prev) fail(`${id}.points must be sorted by day without duplicates (${p.d})`);
    if ((p.n !== undefined && !num(p.n)) || (p.of !== undefined && !num(p.of))) fail(`${id}.points n/of: ${p.d}`);
    if (p.parts !== undefined && (typeof p.parts !== "object" || !Object.values(p.parts).every(num))) fail(`${id}.points parts: ${p.d}`);
    prev = p.d;
  }
  metrics[id] = { updatedAt: doc.updatedAt, points: doc.points.map(({ d, v, n, of, parts }) => ({ d, v, ...(num(n) ? { n } : {}), ...(num(of) ? { of } : {}), ...(parts ? { parts } : {}) })) };
}

const { subtle } = globalThis.crypto;
const keys = JSON.parse(readFileSync(join(root, "keys.json"), "utf8"));
const pub = await subtle.importKey("jwk", keys.publicKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
const dek = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await subtle.encrypt({ name: "AES-GCM", iv }, dek, new TextEncoder().encode(JSON.stringify({ metrics })));
const wrappedKey = await subtle.wrapKey("raw", dek, pub, { name: "RSA-OAEP" });
const b64 = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString("base64");

writeFileSync(join(root, "engagement.enc.json"), JSON.stringify({ v: 1, sealedAt: new Date().toISOString(), wrappedKey: b64(wrappedKey), iv: b64(iv), ct: b64(ct) }) + "\n");
console.log(`engagement.enc.json written (${Object.keys(metrics).length} metrics: ${Object.entries(metrics).map(([id, m]) => `${id} ${m.points.length}d`).join(", ") || "none"})`);
