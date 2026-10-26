// Seal the Product Dashboard data (dashboard.html).
//
//   node scripts/build-dashboard.mjs <raw-dir>
//
// <raw-dir> holds one raw tool result per query in dashboard/queries.json (<id>.json, exactly as
// query_amplitude_data returned it: the {content:[{text}]} wrapper or the inner JSON) plus rc.json.
// Every query covers the same 90 complete UTC days, so the whole history is rebuilt on each run.
// The queries carry all / paid / free segments (keeps every response big enough to be saved to a file);
// only the paid segment is published — the page is about subscribers.
// Writes dashboard.enc.json: the payload under a fresh AES-256-GCM key, wrapped with keys.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/build-dashboard.mjs <raw-dir>"); process.exit(2); }
const fail = (msg) => { console.error("invalid data: " + msg); process.exit(1); };
const reg = JSON.parse(readFileSync(join(root, "dashboard", "queries.json"), "utf8"));
const COUNTRIES = reg.countries;
const SEGS = ["all", "paid", "free"];

// Tool results arrive wrapped ({content:[{text}]}) and the text itself wraps {data:{...}}.
const load = (id) => {
  const p = join(dir, id + ".json");
  if (!existsSync(p)) fail(`${p} missing`);
  let o = JSON.parse(readFileSync(p, "utf8"));
  if (Array.isArray(o)) o = { content: o };
  if (o.content) o = JSON.parse(o.content.find((c) => c.type === "text" && c.text.trim().startsWith("{")).text);
  if (o.data) o = o.data;
  if (o.success === false) fail(`${id}: query failed`);
  return o;
};
const day = (s) => String(s).slice(0, 10);

// Segmentation queries list 4 slices per base event: all, platform, country, version.
const SLICE = ["all", "p", "c", "v"];
const segQueries = { dau: ["dau", "openers"], wau: ["wau"], mau: ["mau"], speakers: ["speakers"], speech: ["speech"], nodes: ["nstart", "ndone"] };

let days = null;
const m = {};
const put = (metric, seg, key, arr) => {
  ((m[metric] ??= {})[seg] ??= {})[key] = arr;
};

for (const [id, metrics] of Object.entries(segQueries)) {
  const j = load(id).jsonResponse;
  if (!j) fail(`${id}: no jsonResponse`);
  const x = j.xValuesForTimeSeries.map(day);
  if (!days) days = x;
  else if (x.join() !== days.join()) fail(`${id}: date axis differs from dau`);
  if (j.timeSeries.length !== j.seriesMetadata.length) fail(`${id}: series/metadata length`);
  j.seriesMetadata.forEach((meta, i) => {
    const metric = metrics[Math.floor(meta.eventIndex / 4)];
    const kind = SLICE[meta.eventIndex % 4];
    const seg = SEGS[meta.segmentIndex];
    if (!metric || !seg) fail(`${id}: unexpected series ${JSON.stringify(meta)}`);
    const label = (meta.eventGroupBys || [])[0];
    if (kind !== "all" && !label) fail(`${id}: grouped series without label`);
    if (kind === "c" && !COUNTRIES.includes(label)) return;
    if (kind === "p" && !["iOS", "Android"].includes(label)) return;
    const key = kind === "all" ? "all" : `${kind}:${label}`;
    const vals = j.timeSeries[i].map((p) => Math.round(Number(p.value) || 0));
    if (vals.length !== days.length) fail(`${id}: series length`);
    put(metric, seg, key, vals);
  });
  for (const metric of metrics) for (const seg of SEGS) if (!m[metric]?.[seg]?.all) fail(`${id}: ${metric}/${seg} total missing`);
}

// Sessions (CSV): total session seconds is additive, so slices are sums over the platform × country
// and platform × version breakdowns (≈0.1–1% above Amplitude's ungrouped total: a few sessions span a
// property change).
const csv = (id) => {
  const rows = load(id).csvResponse?.data;
  if (!rows) fail(`${id}: no csvResponse`);
  const h = rows.findIndex((r) => r && r[0] === "Segment");
  const hdr = rows[h];
  const idx = days.map((d) => hdr.findIndex((c) => c && day(c) === d));
  if (idx.some((i) => i < 0)) fail(`${id}: date axis differs from dau`);
  return rows.slice(h + 1).filter((r) => r && r[1] && SEGS.includes(r[0]))
    .map((r) => ({ seg: r[0], parts: String(r[1]).split("; "), vals: idx.map((i) => Number(r[i]) || 0) }));
};
const add = (seg, key, vals) => {
  const cur = ((m.stime ??= {})[seg] ??= {})[key] ??= days.map(() => 0);
  vals.forEach((v, i) => { cur[i] += v; });
};
for (const r of csv("sess_pc")) {
  const [plat, country] = r.parts;
  add(r.seg, "all", r.vals);
  if (plat === "iOS" || plat === "Android") add(r.seg, `p:${plat}`, r.vals);
  if (COUNTRIES.includes(country)) add(r.seg, `c:${country}`, r.vals);
}
for (const r of csv("sess_pv")) add(r.seg, `v:${r.parts[1]}`, r.vals);
for (const seg of SEGS) {
  if (!m.stime?.[seg]?.all) fail(`sess_pc: ${seg} missing`);
  for (const k of Object.keys(m.stime[seg])) m.stime[seg][k] = m.stime[seg][k].map(Math.round);
}

// Versions offered in the filter: the newest ones with real traffic in the last 14 days.
const semver = (v) => v.split(".").map((n) => parseInt(n, 10) || 0);
const cmp = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };
const recent = (arr) => arr.slice(-14).reduce((s, v) => s + v, 0);
const versions = Object.entries(m.dau.paid).filter(([k, v]) => k.startsWith("v:") && recent(v) >= 70)
  .map(([k]) => k.slice(2)).sort(cmp).slice(0, 6);
// Keep only offered versions to keep the payload small.
const paid = {};
for (const [metric, bySeg] of Object.entries(m)) {
  paid[metric] = bySeg.paid;
  for (const k of Object.keys(paid[metric])) if (k.startsWith("v:") && !versions.includes(k.slice(2))) delete paid[metric][k];
}

// RevenueCat: weekly store subscriptions (end-of-week snapshot; last week may be partial).
const rc = JSON.parse(readFileSync(join(dir, "rc.json"), "utf8"));
if (!Array.isArray(rc.weeks) || !rc.weeks.length) fail("rc.weeks");
const last = days[days.length - 1];
const plus6 = (d) => new Date(Date.parse(d + "T00:00:00Z") + 6 * 864e5).toISOString().slice(0, 10);
const rcWeeks = rc.weeks.map((w) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.d) || !Number.isFinite(w.app_store) || !Number.isFinite(w.play_store)) fail("rc week " + JSON.stringify(w));
  const end = plus6(w.d);
  return { d: end < last ? end : last, ios: w.app_store, android: w.play_store };
});

if (days.length < 28) fail("need at least 28 days");
const payload = { v: 2, generatedAt: new Date().toISOString(), days, countries: COUNTRIES, versions, m: paid, rc: rcWeeks };

const { subtle } = globalThis.crypto;
const keys = JSON.parse(readFileSync(join(root, "keys.json"), "utf8"));
const pub = await subtle.importKey("jwk", keys.publicKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
const dek = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await subtle.encrypt({ name: "AES-GCM", iv }, dek, new TextEncoder().encode(JSON.stringify(payload)));
const wrappedKey = await subtle.wrapKey("raw", dek, pub, { name: "RSA-OAEP" });
const b64 = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString("base64");
writeFileSync(join(root, "dashboard.enc.json"), JSON.stringify({ v: 1, sealedAt: new Date().toISOString(), wrappedKey: b64(wrappedKey), iv: b64(iv), ct: b64(ct) }) + "\n");
if (process.env.DASHBOARD_PLAIN) writeFileSync(process.env.DASHBOARD_PLAIN, JSON.stringify(payload));
const dau = paid.dau.all;
console.log(`dashboard.enc.json written: ${days[0]}…${last}, aktif abone (DAU) ${dau[dau.length - 1]}, versions ${versions.join(" ")}`);
