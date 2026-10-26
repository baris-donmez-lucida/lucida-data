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

// Lessons (Dersler tab): subscribers' first-ever node → completed lessons within 7 days, one cohort per first-node
// day. TIME_TO_CONVERT CSV rows: label, date ("Jul 28"), conversion, entered, avg s, median s, step 2, avg, median, …,
// last step, isComplete. Segment rows are all labelled "None": a "Total" row opens each segment, in query order.
const LES_FILES = ["les_seg", "les_ver", "t5_seg", "t5_hist"];
const lesMissing = LES_FILES.filter((id) => !existsSync(join(dir, id + ".json")));
let les = null;
if (lesMissing.length) console.warn(`dersler atlandı (eksik: ${lesMissing.join(", ")}); Overview yine yazılıyor`);
else les = (() => {
  const SEG_KEYS = ["all", "p:iOS", "p:Android", ...COUNTRIES.map((c) => "c:" + c)];
  const mon = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
  const funnel = (id) => {
    const rows = load(id).csvResponse?.data;
    if (!rows) fail(`${id}: no csvResponse`);
    const h = rows.findIndex((r) => r && r[1] === "Date");
    if (h < 0) fail(`${id}: no header`);
    const groups = [];
    for (const r of rows.slice(h + 1)) {
      if (!r || r.length < 4) continue;
      if (r[1] === "Total") groups.push({ label: String(r[0]), total: r, byDate: new Map() });
      else if (groups.length) groups.at(-1).byDate.set(r[1], r);
    }
    return groups.map((g) => ({ label: g.label, total: g.total, at: (i) => g.byDate.get(mon(days[i])) }));
  };
  const col = (g, k) => days.map((_, i) => Math.round(Number(g.at(i)?.[k]) || 0));
  const lesSeg = funnel("les_seg"), lesVer = funnel("les_ver"), t5Seg = funnel("t5_seg");
  if (lesSeg.length !== SEG_KEYS.length) fail(`les_seg: ${lesSeg.length} segments, expected ${SEG_KEYS.length}`);
  if (t5Seg.length !== SEG_KEYS.length + 1) fail(`t5_seg: ${t5Seg.length} segments, expected ${SEG_KEYS.length + 1}`);
  const complete = days.map((_, i) => lesSeg[0].at(i)?.at(-1) === true);
  const lastDone = complete.lastIndexOf(true);
  if (lastDone < 28 || complete.slice(0, lastDone + 1).includes(false)) fail("les_seg: complete-cohort flags look wrong");
  const steps = (g) => ({ n: col(g, 3), s: [6, 9, 12, 15, 18].map((k) => col(g, k)) });
  const lseg = {};
  SEG_KEYS.forEach((k, j) => { lseg[k] = steps(lesSeg[j]); });
  // 5th-lesson timing: t5_seg is first node → lifetime 5th lesson (same entrants; ≈ the 6-step funnel's last step).
  const t5 = {};
  [...SEG_KEYS, "core5"].forEach((k, j) => { t5[k] = { n: col(t5Seg[j], 3), avg: col(t5Seg[j], 4), med: col(t5Seg[j], 5), k: col(t5Seg[j], 6) }; });
  const sumTo = (a) => a.slice(0, lastDone + 1).reduce((s, v) => s + v, 0);
  for (const k of SEG_KEYS) {
    if (sumTo(t5[k].n) !== sumTo(lseg[k].n)) fail(`${k}: t5_seg entrants differ from les_seg`);
    const a = sumTo(t5[k].k), b = sumTo(lseg[k].s[4]);
    if (b >= 100 && Math.abs(a - b) / b > 0.05) fail(`${k}: 5th-lesson count ${a} vs funnel ${b}`);
  }
  // Start versions with enough completed cohorts to compare (newest first).
  const lver = {};
  for (const g of lesVer) {
    const st = steps(g);
    if (/^\d+\.\d+\.\d+$/.test(g.label) && sumTo(st.n) >= 150) lver[g.label] = st;
  }
  const lesVersions = Object.keys(lver).sort(cmp).slice(0, 8);
  for (const v of Object.keys(lver)) if (!lesVersions.includes(v)) delete lver[v];
  // Time to 5th lesson, hourly histogram over the 28 newest complete cohort days (all / iOS / Android).
  const hj = load("t5_hist").jsonResponse;
  const hser = hj?.processedData?.highchartsConfig?.series;
  if (!Array.isArray(hser) || hser.length !== 3 || hser.some((s) => s.data.length !== 168)) fail("t5_hist: expected 3 × 168 hourly bins");
  const hist = {};
  ["all", "p:iOS", "p:Android"].forEach((k, j) => {
    const d = hj.data[j];
    hist[k] = { bins: hser[j].data.map((b) => Math.round(Number(b.value) || 0)), n: d.convertedCounts["0"], k: d.convertedCounts["1"], med: Math.round(d.medianTransTimes[0] / 1000), avg: Math.round(d.avgTransTimes[0] / 1000) };
  });
  const hFrom = lastDone - 27;
  const hk = t5.all.k.slice(hFrom, lastDone + 1).reduce((s, v) => s + v, 0);
  if (Math.abs(hist.all.k - hk) / hk > 0.05) fail(`t5_hist: ${hist.all.k} converters vs ${hk} in t5_seg for ${days[hFrom]}…${days[lastDone]}`);
  return { complete, seg: lseg, ver: lver, versions: lesVersions, t5, hist: { from: days[hFrom], to: days[lastDone], ...hist } };
})();

if (days.length < 28) fail("need at least 28 days");
const payload = { v: 2, generatedAt: new Date().toISOString(), days, countries: COUNTRIES, versions, m: paid, rc: rcWeeks, ...(les ? { les } : {}) };

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
if (les) {
  const i = les.complete.lastIndexOf(true), w7 = (a) => a.slice(i - 6, i + 1).reduce((s, v) => s + v, 0), a = les.seg.all;
  console.log(`dersler: son kapanan kohort ${days[i]}, 7 günde ${w7(a.n)} yeni abone, ilk hafta 5 ders %${(100 * w7(a.s[4]) / w7(a.n)).toFixed(1)}, 5. derse medyan ${(les.hist.all.med / 3600).toFixed(1)} sa`);
}
