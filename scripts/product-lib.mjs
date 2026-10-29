// Parsers for the Product Engagement v2 build (build-product.mjs) and its tests.
// Every function takes one raw query_amplitude_data result and returns plain arrays; nothing here
// knows about metrics.json. Shapes are described in the package's RESPONSE_SHAPES.md:
//   segmentation → data.jsonResponse (series matched by segmentIndex, eventIndex, eventGroupBys[0]);
//   funnels / retention → data.csvResponse.data (header row = first row whose first cell is "Segment").
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Tool results arrive wrapped ({content:[{text}]}) and the text wraps {success, data:{...}}.
// Returns the inner data, or null when the file is absent or the query failed.
export function unwrap(o) {
  if (Array.isArray(o)) o = { content: o };
  if (o && o.content) {
    const t = o.content.find((c) => c.type === "text" && String(c.text).trim().startsWith("{"));
    if (!t) return null;
    o = JSON.parse(t.text);
  }
  if (!o || o.success === false) return null;
  return o.data ?? o;
}
export function loadRaw(dir, id) {
  const p = join(dir, id + ".json");
  if (!existsSync(p)) return null;
  try { return unwrap(JSON.parse(readFileSync(p, "utf8"))); } catch (e) { return null; }
}

export const day = (s) => String(s).slice(0, 10);
const num = (v) => { const n = Number(String(v ?? "").replace(/^\t/, "")); return Number.isFinite(n) ? n : null; };
const cell = (v) => (typeof v === "string" ? v.replace(/^\t/, "").trim() : v);

// ---------- segmentation ----------
// Map of "seg|event|groupBy" → values per day. Missing days / series are the caller's zeros.
export function segSeries(data) {
  const j = data?.jsonResponse;
  if (!j || !Array.isArray(j.timeSeries)) return null;
  const days = j.xValuesForTimeSeries.map(day);
  const series = new Map(), overall = new Map();
  j.seriesMetadata.forEach((meta, i) => {
    const gb = (meta.eventGroupBys || (meta.eventGroupBy != null ? [meta.eventGroupBy] : []))[0];
    const key = `${meta.segmentIndex}|${meta.eventIndex}|${gb ?? ""}`;
    series.set(key, j.timeSeries[i].map((p) => Number(p.value) || 0));
    overall.set(key, Number(j.overallSeries?.[i]?.[0]?.value) || 0);
  });
  return { days, series, overall };
}

// Sliced queries: eventIndex = base*4 + slice (0 all, 1 platform, 2 country, 3 version).
// Returns out[base][segmentIndex][sliceKey] = values, sliceKey "all" | "p:iOS" | "c:Japan" | "v:2.9.1".
export const SLICE_PREFIX = ["", "p:", "c:", "v:"];
export function sliced(data, { countries }) {
  const s = segSeries(data);
  if (!s) return null;
  const out = [];
  for (const [key, vals] of s.series) {
    const [seg, ev, gb] = key.split("|");
    const base = Math.floor(Number(ev) / 4), slice = Number(ev) % 4;
    let k;
    if (slice === 0) k = "all";
    else {
      if (!gb || gb === "(none)") continue;
      if (slice === 1 && gb !== "iOS" && gb !== "Android") continue;
      if (slice === 2 && !countries.includes(gb)) continue;
      k = SLICE_PREFIX[slice] + gb;
    }
    ((out[base] ??= [])[Number(seg)] ??= {})[k] = vals;
  }
  return { days: s.days, out };
}

// Non-sliced query: out[eventIndex][groupBy value or ""] = values (segment 0 unless given).
export function byEvent(data, seg = 0) {
  const s = segSeries(data);
  if (!s) return null;
  const out = [], overall = [];
  for (const [key, vals] of s.series) {
    const [sg, ev, gb] = key.split("|");
    if (Number(sg) !== seg) continue;
    (out[Number(ev)] ??= {})[gb] = vals;
    (overall[Number(ev)] ??= {})[gb] = s.overall.get(key);
  }
  return { days: s.days, out, overall };
}

// ---------- CSV (funnels, retention) ----------
export function csv(data) {
  const rows = data?.csvResponse?.data;
  if (!Array.isArray(rows)) return null;
  const clean = rows.map((r) => (Array.isArray(r) ? r.map(cell) : []));
  const h = clean.findIndex((r) => r[0] === "Segment");
  if (h < 0) return null;
  return { header: clean[h], rows: clean.slice(h + 1).filter((r) => r.length && r[0] !== "" && r[0] != null) };
}

// Segment label → slice key. Funnel segments are labelled "paid", "paid · iOS", "paid · Japan";
// raw funnels "all", "iOS", "Japan". Unknown labels (Amplitude sometimes returns "None") fall back
// to the position of the row block in the query's segment list (blockLabels).
export function labelKey(label, countries) {
  const l = String(label).replace(/^paid( · )?/, "");
  if (l === "" || l === "all") return "all";
  if (l === "iOS" || l === "Android") return "p:" + l;
  if (countries.includes(l)) return "c:" + l;
  return null;
}
function blocks(rows, countries, blockLabels, keyOf = labelKey) {
  // rows of one segment are contiguous; number the blocks in order of appearance
  const out = [];
  let prev = null, b = -1;
  for (const r of rows) {
    if (r[0] !== prev) { b++; prev = r[0]; }
    const k = keyOf(r[0], countries) ?? (blockLabels ? keyOf(blockLabels[b], countries) : null);
    if (k) out.push([k, r]);
  }
  return out;
}

// conversion_over_time ("Entire Funnel" row, 0–1) and time_to_convert_over_time (ms):
// out[sliceKey] = value per day of `days` (null when the day is absent or 0 / empty).
export function funnelDaily(data, days, { countries, blockLabels, row = null }) {
  const c = csv(data);
  if (!c) return null;
  const dateCols = c.header.map((h, i) => [day(h), i]).filter(([d]) => /^\d{4}-\d\d-\d\d$/.test(d));
  const col = new Map(dateCols);
  const out = {};
  for (const [k, r] of blocks(c.rows, countries, blockLabels)) {
    if (row && r[1] !== row) continue;
    out[k] = days.map((d) => {
      const i = col.get(d);
      // the label columns are 1 (time to convert) or 2 (with a "Steps" column): header and row align
      const v = i == null ? null : num(r[i]);
      return v == null || v === 0 ? null : v;
    });
  }
  return out;
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
// "Oct 25, 2026" → 2026-10-25; "Oct 05" (no year) → the year that puts it inside [from, to].
export function parseDay(s, from, to) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?$/.exec(String(s).trim());
  if (!m) return null;
  if (m[3]) return ymd(Number(m[3]), MONTHS[m[1]], Number(m[2]));
  for (const y of [Number(to.slice(0, 4)), Number(to.slice(0, 4)) - 1]) {
    const d = ymd(y, MONTHS[m[1]], Number(m[2]));
    if (d >= from && d <= to) return d;
  }
  return null;
}

// Retention CSV → out[sliceKey] = [{ d, users, cells:[D0, D1, …] }], newest first as in the CSV.
// Cells whose day (cohort + N) is after lastDay are incomplete and become null. "Overall" rows skipped.
export function retention(data, lastDay, { countries, blockLabels, keyOf }) {
  const c = csv(data);
  if (!c) return null;
  const n0 = c.header.indexOf("Day 0");
  const out = {};
  for (const [k, r] of blocks(c.rows, countries, blockLabels, keyOf)) {
    if (r[1] === "Overall") continue;
    const d = parseDay(r[1], "1970-01-01", "2999-12-31");
    if (!d) continue;
    const users = num(r[2]);
    const cells = [];
    for (let i = n0; i < c.header.length; i++) {
      const N = i - n0, at = ymd(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)) + N);
      cells.push(at > lastDay || r[i] == null || r[i] === "" ? null : num(r[i]));
    }
    (out[k] ??= []).push({ d, users, cells });
  }
  return out;
}

// Raw funnel CSV (definition queries): step k count is column 3 + 3k; dates "Oct 05" without a year.
// out[sliceKey] = { days:[entry day], steps:[[count per day] per step], complete:[bool], total:[per step] }
export function rawFunnel(data, from, to, { countries, blockLabels }) {
  const c = csv(data);
  if (!c) return null;
  const nSteps = Math.floor((c.header.length - 3 + 2) / 3);
  const hasComplete = c.header[c.header.length - 1] === "Is complete";
  const steps = hasComplete ? Math.floor((c.header.length - 1 - 3 + 2) / 3) : nSteps;
  const out = {};
  for (const [k, r] of blocks(c.rows, countries, blockLabels)) {
    const o = (out[k] ??= { days: [], steps: Array.from({ length: steps }, () => []), complete: [], total: null });
    const vals = Array.from({ length: steps }, (_, s) => num(r[3 + 3 * s]) ?? 0);
    if (r[1] === "Total") { o.total = vals; continue; }
    const d = parseDay(r[1], from, to);
    if (!d) continue;
    o.days.push(d);
    vals.forEach((v, s) => o.steps[s].push(v));
    const last = r[r.length - 1];
    o.complete.push(hasComplete && r.length === c.header.length ? last === true || last === "true" : false);
  }
  return out;
}

// aband_day (funnel time_to_convert JSON): opened / abandoned pairs and how many ended ≥ 60 s.
export function abandDay(data) {
  const x = data?.jsonResponse?.data?.[0];
  if (!x || !Array.isArray(x.cumulativeRaw)) return null;
  const bins = x.stepTransTimeDistribution?.step_bins?.[1]?.bins || [];
  const over60 = bins.filter((b) => Number(b.start) >= 60000).reduce((s, b) => s + (Number(b.bin_dist?.totals) || 0), 0);
  return { opened: Number(x.cumulativeRaw[0]) || 0, abandoned: Number(x.cumulativeRaw[1]) || 0, over60 };
}

// stick_est (one 7-day window ending on its last day; segments paid_all, then paid / store / web without users in activation during the window):
// { d, <sub>: { dau: last day's uniques, wau: uniques of the whole window } }
export function stickDay(data, subs) {
  const s = segSeries(data);
  if (!s || !s.days.length) return null;
  const n = s.days.length, o = { d: s.days[n - 1] };
  subs.forEach((sub, seg) => { const k = `${seg}|0|`; if (s.series.has(k)) o[sub] = { dau: s.series.get(k)[n - 1], wau: s.overall.get(k) }; });
  return o;
}

// lesson_id → { lang: "en", lvl: "A1", no: 3 } ("live_lesson_en_a1_3": target language, level, number);
// null for ids without a level.
export function lessonLevel(id) {
  const m = /(?:_([a-z]{2}))?_(a[0-2]|b[12]|c[12])_(\d+)$/i.exec(String(id));
  return m ? { lang: m[1] ? m[1].toLowerCase() : null, lvl: m[2].toUpperCase(), no: Number(m[3]) } : null;
}

// ---------- user lists ----------
// data_table CSVs keyed on Amplitude ID (events sent before login have no user_id, so user_id cannot be the key).
// ulist_* : one row per Amplitude ID × user_id × day × country × platform × version × subscription status with event
//           counts in column order USER_COLS (last 7 days).
// groups.act: uact_* (Amplitude ID × day dashboard views of Activation Users → d0 = first day with a view);
// groups.est / groups.act1: Amplitude IDs of yesterday's active Activated Users / Activation Users (d1–d8).
// Returns { asOf, cols, rows } with one row per user (USER_FIELDS order); null when no ulist part is present.
export const USER_COLS = ["call", "dash", "done", "page", "nclick", "nstart", "nlets", "chain", "speech"];
export const USER_FIELDS = ["id", "uid", "country", "platform", "version", "status", "d0", "last", "on7", "act7", "done7", "page7", "min7",
  "on_y", "act_y", "done_y", "page_y", "nclick_y", "nstart_y", "chain_y", "min_y", "est_y", "a1_y"];
const DIM = [[/amplitude\] id$/i, "id"], [/user id/i, "uid"], [/country/i, "country"], [/platform/i, "platform"], [/version/i, "version"], [/subscription_status/i, "status"]];
// rows as { id, uid, …, d, vals } — the day cell is found by its shape because Amplitude moves it to the end of the dimensions
function tableRows(data) {
  const raw = data?.csvResponse?.data;
  if (!Array.isArray(raw)) return null;
  const clean = raw.map((r) => (Array.isArray(r) ? r.map(cell) : []));
  const h = clean.findIndex((r) => /\] (user )?id$/i.test(String(r[0] ?? "")));
  if (h < 0) return null;
  const head = clean[h], m0 = head.findIndex((x) => /--/.test(String(x)));
  const nDims = m0 < 0 ? head.length - 1 : m0, names = head.slice(0, nDims).filter((x) => !/^time$/i.test(x)).map((x) => (DIM.find(([re]) => re.test(x)) || [null, x])[1]);
  const out = [];
  for (const r of clean.slice(h + 1)) {
    if (!r[0] || r[0] === "Overall" || r[0] === "(none)") continue;
    const dims = r.slice(0, nDims), ti = dims.findIndex((x) => /^\d{4}-\d\d-\d\d/.test(String(x ?? "")));
    const rest = ti < 0 ? dims : dims.filter((_, i) => i !== ti), o = { d: ti < 0 ? null : day(dims[ti]), vals: r.slice(nDims).map((x) => num(x) || 0) };
    names.forEach((n, i) => { o[n] = rest[i] == null || rest[i] === "(none)" ? null : rest[i]; });
    out.push(o);
  }
  return out;
}
export function userTable(parts, groups, lastDay) {
  const users = new Map();
  const get = (id) => users.get(id) ?? (users.set(id, { id, uid: null, days: new Map(), prof: null, profDay: "" }), users.get(id));
  let any = false;
  for (const data of parts) {
    const rs = tableRows(data);
    if (!rs) continue;
    any = true;
    for (const r of rs) {
      if (!r.id || !r.d) continue;
      const u = get(r.id), t = u.days.get(r.d) ?? USER_COLS.map(() => 0);
      r.vals.forEach((x, i) => { t[i] += x; });
      u.days.set(r.d, t);
      if (r.uid) u.uid = r.uid;
      // profile from the latest day with activity (country, platform, version, subscription status)
      if (r.vals.some((x) => x > 0) && r.d >= u.profDay) { u.prof = [r.country, r.platform, r.version, r.status]; u.profDay = r.d; }
    }
  }
  if (!any) return null;
  const d0 = new Map();
  for (const data of groups.act || []) for (const r of tableRows(data) || []) {
    if (!r.id || !r.d || !(r.vals[r.vals.length - 1] > 0)) continue;
    if (!d0.has(r.id) || r.d < d0.get(r.id)) d0.set(r.id, r.d);
  }
  const ids = (data) => new Set((tableRows(data) || []).filter((r) => r.id && r.vals[r.vals.length - 1] > 0).map((r) => r.id));
  const est = ids(groups.est), act1 = ids(groups.act1);
  for (const id of [...d0.keys(), ...est, ...act1]) get(id);
  const C = Object.fromEntries(USER_COLS.map((c, i) => [c, i]));
  const rows = [];
  for (const u of users.values()) {
    let on7 = 0, act7 = 0, done7 = 0, page7 = 0, sp7 = 0, last = "";
    for (const [d, t] of u.days) {
      if (t[C.dash] > 0) on7++;
      if (t[C.call] > 0) act7++;
      if ((t[C.dash] > 0 || t[C.call] > 0) && d > last) last = d;
      done7 += t[C.done]; page7 += t[C.page]; sp7 += t[C.speech];
    }
    const y = u.days.get(lastDay) ?? USER_COLS.map(() => 0);
    const p = u.prof ?? [null, null, null, null];
    rows.push([u.id, u.uid, p[0], p[1], p[2], p[3], d0.get(u.id) ?? null, last || null, on7, act7, done7, page7, Math.round(sp7 / 6) / 10,
      y[C.dash], y[C.call], y[C.done], y[C.page], y[C.nclick], y[C.nstart] + y[C.nlets] > 0 ? 1 : 0, y[C.chain], Math.round(y[C.speech] / 6) / 10,
      est.has(u.id) ? 1 : 0, act1.has(u.id) ? 1 : 0]);
  }
  return { asOf: lastDay, cols: USER_FIELDS, rows };
}
