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
const LES_FILES = ["les_seg", "les_ver"];
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
  const lesSeg = funnel("les_seg"), lesVer = funnel("les_ver");
  if (lesSeg.length !== SEG_KEYS.length) fail(`les_seg: ${lesSeg.length} segments, expected ${SEG_KEYS.length}`);
  const complete = days.map((_, i) => lesSeg[0].at(i)?.at(-1) === true);
  const lastDone = complete.lastIndexOf(true);
  if (lastDone < 28 || complete.slice(0, lastDone + 1).includes(false)) fail("les_seg: complete-cohort flags look wrong");
  const steps = (g) => ({ n: col(g, 3), s: [6, 9, 12, 15, 18].map((k) => col(g, k)) });
  const lseg = {};
  SEG_KEYS.forEach((k, j) => { lseg[k] = steps(lesSeg[j]); });
  const sumTo = (a) => a.slice(0, lastDone + 1).reduce((s, v) => s + v, 0);
  // Start versions with enough completed cohorts to compare (newest first). queries.json versionGroups merges
  // releases that shipped days apart into one label (e.g. "2.8.7–2.8.8"); their counts add up.
  const groupOf = {};
  for (const [label, members] of Object.entries(reg.versionGroups || {})) for (const v of members) groupOf[v] = label;
  const verKey = (v) => groupOf[v] || v;
  const newest = (label) => label.split("–").at(-1);
  const addTo = (a, b) => b.forEach((v, i) => { a[i] += v; });
  const lver = {};
  let verTotal = 0;
  for (const g of lesVer) {
    if (!/^\d+\.\d+\.\d+$/.test(g.label)) continue;
    verTotal += sumTo(col(g, 3));
    const st = steps(g), key = verKey(g.label);
    if (!lver[key]) lver[key] = st;
    else { addTo(lver[key].n, st.n); st.s.forEach((a, k) => addTo(lver[key].s[k], a)); }
  }
  // Every entrant has a start version, so the versions must add up to the all-users total.
  if (Math.abs(verTotal - sumTo(lseg.all.n)) > 0.01 * sumTo(lseg.all.n)) fail(`les_ver: versions add up to ${verTotal}, les_seg has ${sumTo(lseg.all.n)}`);
  for (const v of Object.keys(lver)) if (sumTo(lver[v].n) < 150) delete lver[v];
  const lesVersions = Object.keys(lver).sort((a, b) => cmp(newest(a), newest(b))).slice(0, 8);
  for (const v of Object.keys(lver)) if (!lesVersions.includes(v)) delete lver[v];
  return { complete, seg: lseg, ver: lver, versions: lesVersions };
})();

// New paid activation (Aktivasyon tab): weekly cohorts by first payment. A user enters on their first-ever
// rc_subscription_event (store) or first-ever rc_non_subscription_purchase_event (web promo; users with a subscription
// before 28 Sep are left out, i.e. the bulk move of existing web subscribers). Each pa_* query runs once per entry
// event, 13 segments (all, iOS, Android, 10 countries), daily cohorts over 17 weeks; store + web are added up.
//   pa_s_*: started a lesson via the lesson start buttons within 7 days
//   pa_c_*: 1st…10th anm_c_lesson_completed within 7 days      pa_f_*: 1st…3rd within 24 hours
const PA_FILES = ["pa_s_sub", "pa_s_web", "pa_c_sub", "pa_c_web", "pa_f_sub", "pa_f_web"];
const paMissing = PA_FILES.filter((id) => !existsSync(join(dir, id + ".json")));
let pa = null;
if (paMissing.length) console.warn(`aktivasyon atlandı (eksik: ${paMissing.join(", ")})`);
else pa = (() => {
  const mon = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
  const read = (id) => {
    const rows = load(id).csvResponse?.data;
    if (!rows) fail(`${id}: no csvResponse`);
    const h = rows.findIndex((r) => r && r[1] === "Date");
    if (h < 0) fail(`${id}: no header`);
    const segs = [];
    for (const r of rows.slice(h + 1)) {
      if (!r || r.length < 4) continue;
      if (r[1] === "Total") segs.push([]);
      else if (segs.length) segs.at(-1).push(r);
    }
    if (segs.length !== 13) fail(`${id}: ${segs.length} segments, expected 13`);
    return segs;
  };
  const raw = Object.fromEntries(PA_FILES.map((id) => [id, read(id)]));
  // Day axis: the queries end yesterday like the rest of the page; rows carry "Jun 29"-style dates without a year.
  const nDays = raw.pa_c_sub[0].length, last = Date.parse(days.at(-1) + "T00:00:00Z");
  const pdays = Array.from({ length: nDays }, (_, i) => new Date(last - (nDays - 1 - i) * 864e5).toISOString().slice(0, 10));
  for (const id of PA_FILES) for (const seg of raw[id]) {
    if (seg.length !== nDays || seg.some((r, i) => r[1] !== mon(pdays[i]))) fail(`${id}: day axis differs`);
  }
  // Monday weeks that are fully inside the range; "closed" = every payment day's window (7 d / 24 h) ended by yesterday.
  const weekOf = (d) => { const t = Date.parse(d + "T00:00:00Z"); return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); };
  const weeks = [...new Set(pdays.map(weekOf))].filter((w) => pdays.filter((d) => weekOf(d) === w).length === 7);
  const idx = weeks.map((w) => pdays.map((d, i) => (weekOf(d) === w ? i : -1)).filter((i) => i >= 0));
  const isDone = (win) => weeks.map((_, k) => idx[k].every((i) => i + win <= nDays - 1));
  const KEYS = ["all", "p:iOS", "p:Android", ...COUNTRIES.map((c) => "c:" + c)];
  const counts = (id, j, col) => weeks.map((_, k) => idx[k].reduce((t, i) => t + (Number(raw[id][j][i][col]) || 0), 0));
  const both = (kind, j, col) => { const a = counts(`pa_${kind}_sub`, j, col), b = counts(`pa_${kind}_web`, j, col); return a.map((v, k) => v + b[k]); };
  const slices = {};
  KEYS.forEach((key, j) => {
    const n = both("c", j, 3);
    if (both("s", j, 3).join() !== n.join() || both("f", j, 3).join() !== n.join()) fail(`aktivasyon ${key}: entrants differ between queries`);
    const c = [6, 9, 12, 15, 18, 21, 24, 27, 30, 33].map((col) => both("c", j, col));
    const f = [6, 9, 12].map((col) => both("f", j, col));
    for (const steps of [c, f]) steps.forEach((a, k) => { if (k && a.some((v, w) => v > steps[k - 1][w])) fail(`aktivasyon ${key}: step counts not decreasing`); });
    slices[key] = { n, s: both("s", j, 6), c: c[0], d3: c[2], d5: c[4], d10: c[9], f1: f[0], f2: f[1], f3: f[2] };
  });
  return { weeks, closed: isDone(7), closed1: isDone(1), slices };
})();

if (days.length < 28) fail("need at least 28 days");
const payload = { v: 2, generatedAt: new Date().toISOString(), days, countries: COUNTRIES, versions, m: paid, rc: rcWeeks, ...(les ? { les } : {}), ...(pa ? { pa } : {}) };

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
  console.log(`dersler: son kapanan kohort ${days[i]}, 7 günde ${w7(a.n)} yeni abone, ilk hafta 5 ders %${(100 * w7(a.s[4]) / w7(a.n)).toFixed(1)}`);
}
if (pa) {
  const k = pa.closed.lastIndexOf(true), a = pa.slices.all, pct = (x) => (100 * x[k] / a.n[k]).toFixed(1);
  console.log(`aktivasyon: ${pa.weeks[0]}…${pa.weeks.at(-1)} (${pa.weeks.length} hafta), son kapanan hafta ${pa.weeks[k]}: ${a.n[k]} yeni paid, başlatma %${pct(a.s)}, tamamlama %${pct(a.c)}, 7 günde 3+ %${pct(a.d3)}`);
}
