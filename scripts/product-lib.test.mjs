// node --test scripts/*.test.mjs
// Parser tests. Real responses live in fixtures/ (not committed; copied from the Product v2 package);
// tests that need one are skipped when it is absent. Expected values are derived from the fixture itself
// or come from made-up inputs — no real numbers in this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "./product-lib.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const C = ["United States", "South Korea", "Japan", "Poland", "Czech Republic", "Hungary", "United Kingdom", "Philippines", "Brazil", "Turkey"];
const fx = (name) => (existsSync(join(FX, name + ".json")) ? L.loadRaw(FX, name) : null);
const skip = (name) => ({ skip: !existsSync(join(FX, name + ".json")) && `fixtures/${name}.json missing` });

// ---------- made-up inputs ----------
const wrap = (data) => ({ content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] });
const seg = (meta, values, days) => ({
  jsonResponse: {
    timeSeries: values.map((v) => v.map((x) => ({ value: x }))),
    overallSeries: values.map((v) => [{ value: v.reduce((s, x) => s + x, 0) }]),
    seriesMetadata: meta,
    xValuesForTimeSeries: days.map((d) => d + "T00:00:00"),
  },
});

test("unwrap: wrapper, failed query, bare data", () => {
  assert.deepEqual(L.unwrap(wrap({ a: 1 })), { a: 1 });
  assert.equal(L.unwrap({ content: [{ type: "text", text: JSON.stringify({ success: false }) }] }), null);
  assert.deepEqual(L.unwrap({ data: { b: 2 } }), { b: 2 });
});

test("sliced: series matched by key, not by array order", () => {
  const days = ["2030-01-01", "2030-01-02"];
  // segment 1 lists Android before iOS; one country is unknown and must be dropped
  const data = seg(
    [
      { segmentIndex: 1, eventIndex: 5, eventGroupBys: ["Android"] },
      { segmentIndex: 0, eventIndex: 0 },
      { segmentIndex: 1, eventIndex: 4 },
      { segmentIndex: 1, eventIndex: 5, eventGroupBys: ["iOS"] },
      { segmentIndex: 0, eventIndex: 2, eventGroupBys: ["Atlantis"] },
      { segmentIndex: 0, eventIndex: 3, eventGroupBys: ["9.9.9"] },
    ],
    [[1, 2], [3, 4], [5, 6], [7, 8], [9, 9], [10, 11]],
    days,
  );
  const s = L.sliced(data, { countries: C });
  assert.deepEqual(s.days, days);
  assert.deepEqual(s.out[0][0].all, [3, 4]);
  assert.deepEqual(s.out[0][0]["v:9.9.9"], [10, 11]);
  assert.equal(s.out[0][0]["c:Atlantis"], undefined);
  assert.deepEqual(s.out[1][1].all, [5, 6]);
  assert.deepEqual(s.out[1][1]["p:iOS"], [7, 8]);
  assert.deepEqual(s.out[1][1]["p:Android"], [1, 2]);
});

test("parseDay: year inferred from the range, including Dec → Jan", () => {
  assert.equal(L.parseDay("Oct 25, 2031", "2000-01-01", "2999-12-31"), "2031-10-25");
  assert.equal(L.parseDay("Dec 30", "2030-12-01", "2031-01-10"), "2030-12-30");
  assert.equal(L.parseDay("Jan 03", "2030-12-01", "2031-01-10"), "2031-01-03");
  assert.equal(L.parseDay("Total", "2030-12-01", "2031-01-10"), null);
});

test("stickDay: last day's uniques and the window's uniques per subscriber type", () => {
  const days = ["2030-01-01", "2030-01-02", "2030-01-03"];
  const d = seg([{ segmentIndex: 0, eventIndex: 0 }, { segmentIndex: 2, eventIndex: 0 }], [[5, 6, 7], [1, 2, 3]], days);
  d.jsonResponse.overallSeries = [[{ value: 11 }], [{ value: 4 }]];
  assert.deepEqual(L.stickDay(d, ["paid", "store", "web"]), { d: "2030-01-03", paid: { dau: 7, wau: 11 }, web: { dau: 3, wau: 4 } });
});

test("lessonLevel", () => {
  assert.deepEqual(L.lessonLevel("live_lesson_en_a1_3"), { lang: "en", lvl: "A1", no: 3 });
  assert.deepEqual(L.lessonLevel("live_lesson_es_c1_12"), { lang: "es", lvl: "C1", no: 12 });
  assert.deepEqual(L.lessonLevel("lesson_b2_7"), { lang: null, lvl: "B2", no: 7 });
  assert.equal(L.lessonLevel("(none)"), null);
});

test("csv: header found below the preamble; unknown segment labels fall back to block order", () => {
  const data = { csvResponse: { data: [["Chart"], [], ["Conversion Over Time"], ["Segment", "Steps", "2030-01-01", "2030-01-02", "Is complete"],
    ["None", "Entire Funnel", 0.5, 0.25], ["paid · iOS", "Entire Funnel", 0.1, 0.2]] } };
  const f = L.funnelDaily(data, ["2030-01-01", "2030-01-02", "2030-01-03"], { countries: C, blockLabels: ["paid", "paid · iOS"], row: "Entire Funnel" });
  assert.deepEqual(f.all, [0.5, 0.25, null]);
  assert.deepEqual(f["p:iOS"], [0.1, 0.2, null]);
});

// ---------- real response shapes ----------
test("segmentation fixture (tiers): every series is keyed and has one value per day", skip("tiers"), () => {
  const d = fx("tiers");
  const s = L.sliced(d, { countries: C });
  const n = d.jsonResponse.xValuesForTimeSeries.length;
  assert.equal(s.days.length, n);
  // 6 segments (paid/store/web × regular/northstar), slice "all" present in each
  for (let g = 0; g < 6; g++) assert.equal(s.out[0][g].all.length, n);
  // the paid·regular "all" series equals the raw series with segmentIndex 0, eventIndex 0
  const i = d.jsonResponse.seriesMetadata.findIndex((m) => m.segmentIndex === 0 && m.eventIndex === 0);
  assert.deepEqual(s.out[0][0].all, d.jsonResponse.timeSeries[i].map((p) => p.value));
  // a platform slice never exceeds the total on the same day
  const ios = s.out[0][0]["p:iOS"];
  if (ios) ios.forEach((v, k) => assert.ok(v <= s.out[0][0].all[k]));
});

test("conversion_over_time fixture (aband): Entire Funnel rows per segment, 0–1", skip("aband_3seg_19-25eki"), () => {
  const d = fx("aband_3seg_19-25eki");
  const c = L.csv(d);
  const days = c.header.filter((h) => /^\d{4}-/.test(h));
  const f = L.funnelDaily(d, days, { countries: C, row: "Entire Funnel" });
  assert.deepEqual(Object.keys(f).sort(), ["all", "p:Android", "p:iOS"]);
  const row = c.rows.find((r) => r[0] === "paid" && r[1] === "Entire Funnel");
  assert.deepEqual(f.all, row.slice(2, 2 + days.length).map((v) => (v === 0 ? null : v)));
  for (const v of f.all) assert.ok(v == null || (v > 0 && v < 1));
});

test("time_to_convert_over_time fixture (dur_lesson): daily median in ms", skip("dur_lesson_3seg_19-25eki"), () => {
  const d = fx("dur_lesson_3seg_19-25eki");
  const c = L.csv(d);
  const days = c.header.slice(1);
  const f = L.funnelDaily(d, days, { countries: C });
  const row = c.rows.find((r) => r[0] === "paid");
  assert.deepEqual(f.all, row.slice(1).map((v) => (v === 0 ? null : v)));
});

test("retention fixture: Overall rows skipped, cells after the last day are null", skip("ret_3seg_19-25eki"), () => {
  const d = fx("ret_3seg_19-25eki");
  const c = L.csv(d);
  const cohorts = c.rows.filter((r) => r[0] === "paid" && r[1] !== "Overall");
  const last = L.parseDay(cohorts[0][1], "1970-01-01", "2999-12-31"); // newest cohort day
  const r = L.retention(d, last, { countries: C });
  assert.equal(r.all.length, cohorts.length);
  assert.equal(r.all[0].d, last);
  assert.equal(r.all[0].users, cohorts[0][2]);
  // the newest cohort's D1 falls after `last` → incomplete
  assert.equal(r.all[0].cells[1], null);
  // an older cohort keeps the CSV value for a complete cell
  const old = r.all.at(-1), oldRow = cohorts.at(-1);
  assert.equal(old.cells[1], oldRow[4]);
});

test("raw funnel fixture (new_act_sub): step k at column 3 + 3k; daily rows add up to Total", skip("new_act_sub_3seg_5-25eki"), () => {
  const d = fx("new_act_sub_3seg_5-25eki");
  const f = L.rawFunnel(d, "2000-01-01", "2999-12-31", { countries: C });
  assert.deepEqual(Object.keys(f).sort(), ["all", "p:Android", "p:iOS"]);
  const a = f.all;
  assert.equal(a.steps.length, 4);
  assert.equal(a.days.length, a.complete.length);
  a.steps.forEach((st, k) => assert.equal(st.reduce((s, x) => s + x, 0), a.total[k], `step ${k}`));
  // steps never increase
  for (let k = 1; k < a.steps.length; k++) a.steps[k].forEach((v, i) => assert.ok(v <= a.steps[k - 1][i]));
});

test("aband_day fixture: over60 = bins starting at ≥ 60 s, never above the abandoned count", skip("aband_day"), () => {
  const d = fx("aband_day");
  const p = L.abandDay(d);
  const x = d.jsonResponse.data[0];
  assert.equal(p.opened, x.cumulativeRaw[0]);
  assert.equal(p.abandoned, x.cumulativeRaw[1]);
  const all = x.stepTransTimeDistribution.step_bins[1].bins.reduce((s, b) => s + b.bin_dist.totals, 0);
  assert.ok(p.over60 <= all && p.over60 <= p.abandoned);
});
