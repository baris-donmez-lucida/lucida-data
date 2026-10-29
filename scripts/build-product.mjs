// Seal the Product Engagement v2 data (index.html).
//
//   node scripts/build-product.mjs <raw-dir> [<history-dir>] [--check <baseline.json>] [--plain <out.plain.json>]
//
// <raw-dir> holds one raw tool result per query in product/queries.json (<id>.json, exactly as
// query_amplitude_data returned it) plus _meta.json. <history-dir> holds the two history documents
// (base.json, abandon_after_1min.json: { updatedAt, points:[...] }) the routine keeps in the
// "Lucida Data" artifact's product-history collection. A missing or failed raw file does not stop the
// build: the metrics that need it are left out and listed in payload.missing ("veri yok" on the page).
// Writes product.enc.json: the payload under a fresh AES-256-GCM key, wrapped with keys.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "./product-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const checkPath = flag("--check"), plainPath = flag("--plain");
const [dir, histDir] = args;
if (!dir) { console.error("usage: node scripts/build-product.mjs <raw-dir> [<history-dir>] [--check <baseline.json>] [--plain <out.plain.json>]"); process.exit(2); }

const Q = JSON.parse(readFileSync(join(root, "product", "queries.json"), "utf8"));
const M = JSON.parse(readFileSync(join(root, "product", "metrics.json"), "utf8"));
const CH = JSON.parse(readFileSync(join(root, "product", "changes.json"), "utf8"));
const COUNTRIES = Q.countries;
const SUBS = ["paid", "store", "web"];
const queryById = Object.fromEntries(Q.queries.map((q) => [q.id, q]));
const segLabels = (id) => { const q = queryById[id]; const c = q.chart || q.definition; return (c.segments || c.params?.segments || []).map((s) => s.label ?? s.name); };

const missing = [];
const raw = {};
const load = (id) => {
  if (!(id in raw)) { raw[id] = L.loadRaw(dir, id); if (!raw[id]) missing.push(id); }
  return raw[id];
};
const meta = existsSync(join(dir, "_meta.json")) ? JSON.parse(readFileSync(join(dir, "_meta.json"), "utf8")) : null;

// ---------- day axis (from the first segmentation query that loads) ----------
let days = null;
for (const id of ["act", "flow_start", "flow_done", "tiers", "speech"]) { const s = L.segSeries(load(id)); if (s) { days = s.days; break; } }
if (!days) { console.error("no segmentation query could be read: nothing to build"); process.exit(1); }
const N = days.length, dataDate = meta?.dataDate || days[N - 1];
const zeros = () => new Array(N).fill(0);
const align = (src, vals) => { if (src.join() === days.join()) return vals; const at = new Map(src.map((d, i) => [d, i])); return days.map((d) => (at.has(d) ? vals[at.get(d)] : 0)); };

// m[key][sub][slice] = values per day (counts; speech in minutes)
const m = {};
const put = (key, sub, slice, vals) => { ((m[key] ??= {})[sub] ??= {})[slice] = vals; };

// ---------- sliced segmentation queries ----------
const SLICED_SEGS = { sub: (seg) => [SUBS[seg], null], tiers: (seg) => [SUBS[Math.floor(seg / 2)], seg % 2 ? "northstar" : "regular"] };
const slicedCache = {};
const slicedOf = (id) => (id in slicedCache ? slicedCache[id] : (slicedCache[id] = load(id) ? L.sliced(raw[id], { countries: COUNTRIES }) : null));

const nsQuery = M.northstar_def.default;
for (const met of M.metrics) {
  const src = met.source;
  if (!src?.query || src.base == null || met.kind === "mix") continue;
  let qid = src.query;
  if (qid === "tiers" && ["regular", "northstar", "regular_ge1"].includes(met.id)) qid = nsQuery;
  const s = slicedOf(qid);
  if (!s) continue;
  const tier = String(src.segments || "").startsWith("tiers:") ? src.segments.split(":")[1] : null;
  s.out[src.base]?.forEach((bySlice, seg) => {
    const [sub, t] = (tier ? SLICED_SEGS.tiers : SLICED_SEGS.sub)(seg);
    if (tier && t !== tier) return;
    for (const [k, vals] of Object.entries(bySlice || {})) put(met.id, sub, k, align(s.days, vals));
  });
}
// the narrow North Star's regular tier (Tanımlar comparison and the baseline check)
{
  const s = slicedOf("tiers_strict");
  s?.out[0]?.forEach((bySlice, seg) => { const [sub, t] = SLICED_SEGS.tiers(seg); if (t === "regular") for (const [k, v] of Object.entries(bySlice || {})) put("regular_strict", sub, k, align(s.days, v)); });
}

// Regular = exactly one: (≥1) − (≥2), so Regular and North Star do not overlap
if (m.regular_ge1 && m.northstar) {
  m.regular = {};
  for (const [sub, bySlice] of Object.entries(m.regular_ge1)) for (const [k, v] of Object.entries(bySlice)) {
    const ns = m.northstar[sub]?.[k];
    m.regular[sub] ??= {};
    m.regular[sub][k] = v.map((x, i) => Math.max(0, x - (ns?.[i] || 0)));
  }
}

// ---------- speech (property sum, seconds → minutes) ----------
const toMin = (v) => Math.round(v / 6) / 10;
{
  const s = L.segSeries(load("speech"));
  if (s) {
    const sums = {}; // sub → slice → seconds
    for (const [key, vals] of s.series) {
      const [seg, ev, gb] = key.split("|");
      const sub = SUBS[Number(seg)], e = Number(ev);
      if (!sub || !gb || gb === "(none)") continue;
      const v = align(s.days, vals);
      if (e === 0) {
        put(`speech_min[${gb}]`, sub, "all", v.map(toMin));
        const a = ((sums[sub] ??= {}).all ??= zeros());
        v.forEach((x, i) => { a[i] += x; });
      } else {
        if (e === 1 && gb !== "iOS" && gb !== "Android") continue;
        if (e === 2 && !COUNTRIES.includes(gb)) continue;
        put("speech_min", sub, L.SLICE_PREFIX[e] + gb, v.map(toMin));
      }
    }
    for (const sub of Object.keys(sums)) put("speech_min", sub, "all", sums[sub].all.map(toMin));
  }
}

// ---------- non-sliced paid-only series (quality, speech health) ----------
for (const id of ["quality", "speech_health"]) {
  const b = L.byEvent(load(id));
  if (!b) continue;
  queryById[id].series.forEach((name, e) => { const v = b.out[e]?.[""]; if (v) put(`${id}.${name}`, "paid", "all", align(b.days, v)); });
}

// ---------- history (snapshot base, abandon after 1 min) ----------
const readHist = (id) => {
  if (!histDir) return null;
  const p = join(histDir, id + ".json");
  if (!existsSync(p)) return null;
  const o = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(o.points) ? o.points.filter((p) => p && p.d).sort((a, b) => (a.d < b.d ? -1 : 1)) : null;
};
const hist = { base: readHist("base") || [], aband: readHist("abandon_after_1min") || [], stick: readHist("stickiness_est") || [] };
// yesterday's aband_day result wins over a history point for the same day
{ const p = L.abandDay(load("aband_day")); if (p) { hist.aband = hist.aband.filter((x) => x.d !== dataDate); hist.aband.push({ d: dataDate, ...p }); } }
{ const p = L.stickDay(load("stick_est"), ["paid_all", ...SUBS]); if (p && p.d === dataDate) { hist.stick = hist.stick.filter((x) => x.d !== dataDate); hist.stick.push(p); } }
if (!hist.base.length) missing.push("history:base");
if (!hist.stick.length) missing.push("history:stickiness_est");
const byDay = (pts, f) => { const at = new Map(pts.map((p) => [p.d, p])); return days.map((d) => (at.has(d) ? f(at.get(d)) : null)); };
if (hist.base.length) put("base", "paid", "all", byDay(hist.base, (p) => p.v));
if (hist.aband.length) for (const f of ["opened", "abandoned", "over60"]) put(`aband_day.${f}`, "paid", "all", byDay(hist.aband, (p) => p[f]));
// online stickiness (history points, one per day): paid_all = everyone; paid / store / web = activation finished before the 7-day window
if (hist.stick.length) for (const sub of SUBS) {
  put("online_est", sub, "all", byDay(hist.stick, (p) => p[sub]?.dau ?? null));
  put("wau_online_est", sub, "all", byDay(hist.stick, (p) => p[sub]?.wau ?? null));
}
if (hist.stick.length) {
  put("online_all_h", "paid", "all", byDay(hist.stick, (p) => p.paid_all?.dau ?? null));
  put("wau_online", "paid", "all", byDay(hist.stick, (p) => p.paid_all?.wau ?? null));
}

// ---------- funnel rates and durations (paid; platform and country segments) ----------
const r = {};
const FUNNEL = { abandon_rate: ["aband", "Entire Funnel", 1], node_done_rate: ["node_done", "Entire Funnel", 1], lesson_duration: ["dur_lesson", null, 60000], screen_duration: ["dur_screen", null, 60000] };
for (const [id, [qid, row, div]] of Object.entries(FUNNEL)) {
  const f = L.funnelDaily(load(qid), days, { countries: COUNTRIES, blockLabels: segLabels(qid), row });
  if (!f) continue;
  r[id] = Object.fromEntries(Object.entries(f).map(([k, vals]) => [k, vals.map((v) => (v == null ? null : Math.round((v / div) * 1e4) / 1e4))]));
}

// ---------- mixes (100% stacked) ----------
const mix = {};
{
  const b = L.byEvent(load("mix"));
  if (b) {
    const cats = (o) => Object.fromEntries(Object.entries(o || {}).map(([c, v]) => [c, align(b.days, v)]));
    mix.completion_reasons = { paid: cats(b.out[0]) };
    mix.entry_type_mix = { paid: cats(b.out[1]) };
  }
  const rd = L.byEvent(load("rating_dist"));
  if (rd) mix.rating_dist = { paid: Object.fromEntries(Object.entries(rd.out[0] || {}).filter(([c]) => /^[1-5]$/.test(c)).map(([c, v]) => [c, align(rd.days, v)])) };
}
// versions seen among active subscribers, busiest first over the last 14 days
const versions = Object.keys(m.active?.paid || {}).filter((k) => k.startsWith("v:")).map((k) => k.slice(2))
  .map((v) => [v, m.active.paid["v:" + v].slice(-14).reduce((s, x) => s + x, 0)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([v]) => v);
if (m.active) {
  mix.version_mix = {};
  for (const sub of SUBS) {
    const o = {};
    for (const v of versions) if (m.active[sub]?.["v:" + v]) o[v] = m.active[sub]["v:" + v];
    mix.version_mix[sub] = o;
  }
}

// ---------- retention ----------
// ret: paid (all / iOS / Android) + subscriber type ("s:store", "s:web"); ret_country: one segment per country
const retKey = (l, c) => (l === "store" || l === "web" ? "s:" + l : L.labelKey(l, c));
// ret / ret_country: Return On (N-day); retu / retu_country: Return On or After (unbounded). Both strict calendar dates.
const retLoad = (main, byCountry) => {
  const a = L.retention(load(main), dataDate, { countries: COUNTRIES, blockLabels: segLabels(main), keyOf: retKey });
  const b = L.retention(load(byCountry), dataDate, { countries: COUNTRIES, blockLabels: segLabels(byCountry), keyOf: retKey });
  const all = a || b ? { ...(b || {}), ...(a || {}) } : null;
  return all ? Object.fromEntries(Object.entries(all).map(([k, rows]) => [k, rows.filter((x) => x.d >= days[0])])) : null;
};
const ret = retLoad("ret", "ret_country"), retu = retLoad("retu", "retu_country");
// nret / nret_country: new-user cohorts (day 0 = first-ever dashboard_page_viewed), Return On, calendar days
const nret = retLoad("nret", "nret_country"), nretu = retLoad("nretu", "nretu_country");

// ---------- new subscribers (raw funnels, entry-day cohorts) ----------
const ep =(s) => new Date(s * 1000).toISOString().slice(0, 10);
const coStart = meta?.WSTART ? ep(meta.WSTART) : null;
const CO = { act: "new_act", a1: "new_a1", done3: "new_done3", done5: "new_done5", done7: "new_done7", start7: "new_start7" };
const co = { sets: {} };
{
  // the cohort axis spans <WSTART>..dataDate; without _meta it is inferred from the rows
  const from = coStart || "2000-01-01", to = dataDate;
  let axis = null;
  for (const [name, pre] of Object.entries(CO)) {
    for (const kind of ["sub", "web"]) {
      const id = `${pre}_${kind}`;
      const f = L.rawFunnel(load(id), from, to, { countries: COUNTRIES, blockLabels: segLabels(id) });
      if (!f) continue;
      const set = ((co.sets[name] ??= {})[kind] = {});
      for (const [k, o] of Object.entries(f)) {
        if (!axis) {
          const first = coStart || o.days[0];
          axis = []; for (let d = first; d <= to; d = new Date(Date.parse(d + "T00:00:00Z") + 864e5).toISOString().slice(0, 10)) axis.push(d);
        }
        const at = new Map(o.days.map((d, i) => [d, i]));
        set[k] = {
          steps: o.steps.map((st) => axis.map((d) => (at.has(d) ? st[at.get(d)] : 0))),
          complete: axis.map((d) => (at.has(d) ? o.complete[at.get(d)] : false)),
        };
      }
    }
  }
  co.days = axis || [];
}

// ---------- lesson table (weekly uniques by lesson_id) ----------
let les = null;
{
  const b = L.byEvent(load("by_lesson"));
  if (b) {
    const weeks = b.days, ids = new Set([...Object.keys(b.out[0] || {}), ...Object.keys(b.out[1] || {})]);
    const rows = [];
    for (const id of ids) {
      if (!id || id === "(none)") continue;
      const lv = L.lessonLevel(id);
      rows.push({ id, lang: lv?.lang ?? null, lvl: lv?.lvl ?? null, no: lv?.no ?? null, s: b.out[0]?.[id] || weeks.map(() => 0), c: b.out[1]?.[id] || weeks.map(() => 0), S: b.overall[0]?.[id] || 0, C: b.overall[1]?.[id] || 0 });
    }
    // a week is complete when all 7 days are inside the query range
    const partial = weeks.map((w) => w < days[0] || Date.parse(w + "T00:00:00Z") + 6 * 864e5 > Date.parse(dataDate + "T00:00:00Z"));
    les = { weeks, partial, rows };
  }
}

// ---------- catalog: metrics.json with num / den normalised to keys of m ----------
const qSeries = (qid, e) => `${qid}.${queryById[qid].series[e]}`;
const catalog = M.metrics.map((x) => {
  const c = { id: x.id, label: x.label, tabs: x.tabs, kind: x.kind, unit: x.unit, period: x.period, chart: x.chart, timeline: x.timeline, note: x.note || "", alert: x.alert || null, breakdowns: x.breakdowns };
  if (x.source?.num != null && x.source?.query) { c.num = qSeries(x.source.query, x.source.num); c.den = qSeries(x.source.query, x.source.den); }
  else if (x.num) { c.num = x.num; c.den = x.den; }
  if (x.id === "ratings") c.series = qSeries("quality", 2);
  if (x.id === "abandon_after_1min") { c.num = "aband_day.over60"; c.den = "aband_day.opened"; }
  if (x.id in FUNNEL) c.rate = x.id;
  return c;
});
// a ratio's breakdowns = the breakdowns both sides support
const bdOf = (key) => {
  const base = key.replace(/\[.*\]$/, "").split(/[+-]/)[0];
  const mm = catalog.find((c) => c.id === base);
  if (!mm) return [];
  return Array.isArray(mm.breakdowns) ? mm.breakdowns : bdOf(mm.num).filter((b) => bdOf(mm.den).includes(b));
};
for (const c of catalog) if (!Array.isArray(c.breakdowns)) c.breakdowns = c.num ? bdOf(c.num).filter((b) => bdOf(c.den).includes(b)) : [];

const payload = {
  v: 1, page: "product", generatedAt: new Date().toISOString(), dataDate, days, countries: COUNTRIES, versions,
  tabs: M.tabs, northstar: M.northstar_def, catalog, m, r, mix, ret, retu, nret, nretu, co, les, hist,
  changes: CH.changes, meta, missing: [...new Set(missing)],
};

// ---------- --check ----------
let failures = 0;
if (checkPath) {
  const B = JSON.parse(readFileSync(checkPath, "utf8"));
  const tol = B.tolerance;
  const idx = (d) => days.indexOf(d);
  const win = (w) => { const a = idx(w[0]), b = idx(w[1]); return a < 0 || b < 0 ? null : [a, b]; };
  const ser = (key, sub = "paid", slice = "all") => m[key]?.[sub]?.[slice];
  const sumW = (v, [a, b]) => v.slice(a, b + 1).reduce((s, x) => s + (x || 0), 0);
  const report = (c, label, got, exp, kind) => {
    let ok;
    if (got == null) ok = false;
    else if (kind === "ratio") ok = Math.abs(got - exp) * 100 <= tol.ratio_pp;
    else if (kind === "duration") ok = Math.abs(got - exp) <= (Math.abs(exp) * tol.duration_pct) / 100;
    else ok = Math.abs(got - exp) <= Math.max(1, (Math.abs(exp) * tol.count_pct) / 100);
    if (!ok) failures++;
    const g = got == null ? "—" : Number.isInteger(got) ? got : Number(got.toFixed(4));
    console.log(`${ok ? "ok  " : "FAIL"} ${c.metric} ${c.window.join("…")} ${label}: got ${g}, expected ${exp}`);
  };
  const coSum = (name, kind, w) => {
    const set = co.sets[name]?.[kind]?.all;
    if (!set) return null;
    const a = co.days.indexOf(w[0]), b = co.days.indexOf(w[1]);
    if (a < 0 || b < 0) return null;
    return set.steps.map((st) => st.slice(a, b + 1).reduce((s, x) => s + x, 0));
  };
  for (const c of B.checks) {
    const w = win(c.window);
    const kind = c.kind;
    if (c.stat === "sum_daily_rows") {
      const [, name, k] = /^new_(\w+?)_(sub|web)$/.exec(c.query) || [];
      const sums = coSum({ act: "act", a1: "a1" }[name] || name, k, c.window);
      const keys = Object.keys(c.expect);
      const stepOf = (key, i) => (key === "entered" ? 0 : /^a1_(\d+)$/.test(key) ? Number(key.slice(3)) : i);
      keys.forEach((key, i) => report(c, key, sums ? sums[stepOf(key, i)] : null, c.expect[key], "count"));
      continue;
    }
    if (c.stat === "cohort_row") {
      for (const [d, e] of Object.entries(c.expect)) {
        const row = ret?.all?.find((x) => x.d === d);
        report(c, `${d} users`, row?.users ?? null, e.users, "count");
        for (const k of Object.keys(e).filter((k) => /^D\d+$/.test(k))) report(c, `${d} ${k}`, row?.cells[Number(k.slice(1))] ?? null, e[k], "count");
      }
      continue;
    }
    if (c.stat === "day_point") {
      const p = hist.aband.find((x) => x.d === c.window[0]);
      for (const k of Object.keys(c.expect)) report(c, k, p ? p[k] : null, c.expect[k], "count");
      continue;
    }
    if (!w) { failures++; console.log(`FAIL ${c.metric}: window ${c.window.join("…")} outside the data (${days[0]}…${days[N - 1]})`); continue; }
    // the baseline was measured with the page-based tiers; when North Star uses another query, check the kept "_pages" series
    const metricKey = c.query === "tiers_strict" ? (c.metric.startsWith("regular") ? "regular_strict" : "northstar_strict")
      : c.query === "tiers" && nsQuery !== "tiers" ? c.metric + "_pages" : c.metric;
    switch (c.stat) {
      case "daily_mean": { const v = ser(metricKey); report(c, "daily_mean", v ? sumW(v, w) / (w[1] - w[0] + 1) : null, c.expect, kind); break; }
      case "value": { const v = ser(metricKey); report(c, "value", v ? v[w[1]] : null, c.expect, kind); break; }
      case "daily": {
        const v = c.query === "aband" ? r.abandon_rate?.all : ser(metricKey);
        c.expect.forEach((e, i) => report(c, days[w[0] + i], v ? v[w[0] + i] : null, e, kind));
        break;
      }
      case "daily_ms": { const v = r.lesson_duration?.all; c.expect.forEach((e, i) => report(c, days[w[0] + i], v && v[w[0] + i] != null ? v[w[0] + i] * 60000 : null, e, "duration")); break; }
      case "sum": {
        if (typeof c.expect === "object") for (const [k, e] of Object.entries(c.expect)) { const v = ser(`${c.query}.${k}`); report(c, k, v ? sumW(v, w) : null, e, kind); }
        else { const v = ser(metricKey); report(c, "sum", v ? sumW(v, w) : null, c.expect, kind); }
        break;
      }
      case "sum_by_conversation_type_sec": for (const [ct, e] of Object.entries(c.expect)) { const v = ser(`speech_min[${ct}]`); report(c, ct, v ? sumW(v, w) * 60 : null, e, kind); } break;
      case "sum_sec": { const v = ser("speech_min"); report(c, "seconds", v ? sumW(v, w) * 60 : null, c.expect, kind); break; }
      case "sum_by_value": for (const [cat, e] of Object.entries(c.expect)) { const v = mix.rating_dist?.paid?.[cat]; report(c, cat + "★", v ? sumW(v, w) : null, e, kind); } break;
      default: failures++; console.log(`FAIL ${c.metric}: unknown stat ${c.stat}`);
    }
  }
  console.log(failures ? `check: ${failures} deviation(s)` : "check: all within tolerance");
}

// ---------- seal ----------
const { subtle } = globalThis.crypto;
const keys = JSON.parse(readFileSync(join(root, "keys.json"), "utf8"));
const pub = await subtle.importKey("jwk", keys.publicKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]);
const dek = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await subtle.encrypt({ name: "AES-GCM", iv }, dek, new TextEncoder().encode(JSON.stringify(payload)));
const wrappedKey = await subtle.wrapKey("raw", dek, pub, { name: "RSA-OAEP" });
const b64 = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString("base64");
writeFileSync(join(root, "product.enc.json"), JSON.stringify({ v: 1, sealedAt: new Date().toISOString(), wrappedKey: b64(wrappedKey), iv: b64(iv), ct: b64(ct) }) + "\n");
if (plainPath) writeFileSync(plainPath, JSON.stringify(payload));
const act = m.active?.paid?.all;
console.log(`product.enc.json written: ${days[0]}…${days[N - 1]}, aktif abone ${act ? act[N - 1] : "—"}, versions ${versions.join(" ")}${payload.missing.length ? ", missing: " + payload.missing.join(" ") : ""}`);
if (failures) process.exit(1);
