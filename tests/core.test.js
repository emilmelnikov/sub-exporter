import { test } from "node:test";
import assert from "node:assert/strict";
import { COLUMNS, toCsv, csvCell, csvFilename } from "../extension/src/csv.js";
import { normalizePatreon, normalizeBoosty, platformForUrl, memberRequest, boostyRequest, nextPage, validateCreator } from "../extension/src/platforms.js";
import { collectSubscribers } from "../extension/src/exporter.js";
import { patreonPage, boostyPage } from "./fixtures.js";

const patreon = { platform: "patreon", origin: "https://www.patreon.com", creator: "123", currency: "EUR" };
const boosty = { platform: "boosty", origin: "https://boosty.to", creator: "studio", currency: "RUB" };
const immediate = async () => {};

test("CSV protects formulas, preserves Unicode and quotes delimiters/newlines", () => {
  for (const value of ["=SUM(A1)", " +CMD", "-1", "@foo", "\tstuff", "\ntext", "\rname", "  ＝formula"]) assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell('Zoë, "世界"\nReader'), '"Zoë, ""世界""\nReader"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell(null), '""');
  const csv = toCsv([{ name: "Анна", amount: 0 }]);
  assert.ok(csv.startsWith('\uFEFF"source"'));
  assert.ok(csv.endsWith("\r\n"));
  assert.equal(csv.split("\r\n")[0].split(",").length, 18);
  assert.ok(toCsv([], { delimiter: ";", bom: false }).includes('"platform";"creator"'));
  assert.throws(() => toCsv([], { delimiter: "|" }));
});

test("combined CSV filename is timestamped and contains no source-controlled text", () => {
  assert.equal(csvFilename(new Date("2026-10-08T12:00:00Z")), "subtable-subscribers-2026-10-08T12-00-00-000Z.csv");
});

test("Patreon joins included user, pledge, tier and preserves absent fields", () => {
  const [row] = normalizePatreon(patreonPage(), "123");
  assert.equal(row.name, "Zoë, Reader");
  assert.equal(row.tier, 'Studio "Plus"');
  assert.equal(row.amount, 12.34);
  assert.equal(row.lifetime_amount, 24.68);
  assert.equal(row.currency, "EUR");
  assert.equal(row.last_payment_at, "");
  assert.deepEqual(Object.keys(row).sort(), COLUMNS.filter((key) => key !== "source").sort());
  const hidden = patreonPage();
  hidden.data[0].attributes.email = null;
  hidden.included = [];
  assert.equal(normalizePatreon(hidden, "123")[0].name, "");
  assert.equal(normalizePatreon(hidden, "123")[0].email, "");
  const masked = patreonPage();
  masked.data[0].attributes.full_name = null;
  assert.equal(normalizePatreon(masked, "123")[0].name, "");
});

test("Boosty prices are major units, timestamps are seconds, inactive stays inactive", () => {
  const payload = boostyPage();
  const [row] = normalizeBoosty(payload, "studio", "RUB");
  assert.equal(row.amount, 250);
  assert.equal(row.lifetime_amount, 1500);
  assert.equal(row.currency, "RUB");
  assert.equal(row.joined_at, "2025-01-01T00:00:00.000Z");
  assert.equal(row.ended_at, "");
  delete payload.data[0].status;
  payload.data[0].subscribed = false;
  payload.data[0].price = 0;
  assert.equal(normalizeBoosty(payload, "studio")[0].status, "inactive");
  assert.equal(normalizeBoosty(payload, "studio")[0].amount, 0);
  assert.equal(normalizeBoosty(payload, "studio")[0].currency, "");
});

test("rejects unexpected response schemas and creator identifiers", () => {
  for (const payload of [{}, { data: {} }, { data: [null] }]) {
    assert.throws(() => normalizePatreon(payload, "1"));
    assert.throws(() => normalizeBoosty(payload, "blog"));
  }
  assert.throws(() => validateCreator("boosty", "../private"));
  assert.throws(() => validateCreator("boosty", ".."));
  assert.throws(() => validateCreator("patreon", "studio"));
  assert.equal(platformForUrl("https://www.patreon.com/members"), "patreon");
  for (const url of ["https://www.patreon.com.evil.test/", "http://boosty.to", "https://evil@boosty.to/"]) assert.equal(platformForUrl(url), null);
});

test("all audience clears filters; current selection preserves them and resets pagination", () => {
  const observedUrl = "https://www.patreon.com/api/members?filter[campaign_id]=123&filter[membership_type]=active_patron&page[cursor]=old&fields[member]=email";
  const all = memberRequest({ ...patreon, observedUrl });
  assert.equal(all.searchParams.get("filter[membership_type]"), null);
  assert.equal(all.searchParams.get("filter[campaign_id]"), "123");
  assert.equal(all.searchParams.get("page[cursor]"), null);
  assert.equal(all.searchParams.get("fields[member]"), "email");
  assert.equal(memberRequest({ ...patreon, observedUrl, scope: "current" }).searchParams.get("filter[membership_type]"), "active_patron");
  assert.throws(() => memberRequest({ ...patreon, observedUrl: "https://evil.test/api/members" }));
  assert.throws(() => memberRequest({ ...patreon, scope: "current" }), /filters could not be verified/);
});

test("exports every cursor page and reports progress", async () => {
  const urls = [], counts = [];
  const rows = await collectSubscribers(patreon, {
    pause: immediate, onProgress: (p) => counts.push(p.count),
    request: async (url) => { urls.push(url.href); return patreonPage(`m-${urls.length}`, { total: 2, next: urls.length === 1 ? "next:opaque" : null }); },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(counts, [1, 2]);
  assert.equal(new URL(urls[1]).searchParams.get("page[cursor]"), "next:opaque");
  assert.equal(new URL(urls[1]).searchParams.has("page[offset]"), false);
});

test("Boosty continues short pages to total using requested offsets", async () => {
  const offsets = [];
  const rows = await collectSubscribers(boosty, { pause: immediate, request: async (url) => {
    const offset = Number(url.searchParams.get("offset")); offsets.push(offset);
    return boostyPage(offset === 0 ? [1, 2] : [3], 3);
  } });
  assert.equal(rows.length, 3);
  assert.deepEqual(offsets, [0, 2]);
});

test("overlapping pages deduplicate without dropping later records", async () => {
  let call = 0;
  const rows = await collectSubscribers(boosty, { pause: immediate, request: async () => boostyPage(++call === 1 ? [1, 2] : [2, 3], 3) });
  assert.deepEqual(rows.map((r) => r.subscriber_id), ["1", "2", "3"]);
});

test("empty audience produces a valid header-only table", async () => {
  const rows = await collectSubscribers(boosty, { request: async () => boostyPage([], 0) });
  assert.deepEqual(rows, []);
  assert.equal(toCsv(rows).split("\r\n").length, 2);
});

test("does not return partial data after an API failure", async () => {
  let count = 0;
  await assert.rejects(collectSubscribers(boosty, { pause: immediate, request: async () => {
    if (++count === 2) throw new Error("Session expired");
    return boostyPage([1], 3);
  } }), /Session expired/);
});

test("detects repeated pages, repeated links, inconsistent totals and missing cursors", async () => {
  await assert.rejects(collectSubscribers(boosty, { pause: immediate, request: async () => boostyPage([1], 3) }), /repeated a page/);
  let call = 0;
  await assert.rejects(collectSubscribers(boosty, { pause: immediate, request: async () => boostyPage([++call], call === 1 ? 3 : 4) }), /changed during import/);
  await assert.rejects(collectSubscribers(patreon, { pause: immediate, request: async () => ({ ...patreonPage("x", { total: 2 }), links: { next: memberRequest(patreon).href } }) }), /repeated a pagination link/);
  call = 0;
  await assert.rejects(collectSubscribers(patreon, { pause: immediate, request: async () => patreonPage(`m-${++call}`, { total: 3, next: call === 1 ? "cursor" : null }) }), /cursor is missing/);
});

test("does not follow pagination URLs to other hosts, resources or campaigns", () => {
  const url = memberRequest(patreon);
  for (const next of ["https://evil.test/api/members", "/api/current_user", "/api/members?filter[campaign_id]=999", "https://secret@www.patreon.com/api/members?filter[campaign_id]=123"]) {
    assert.throws(() => nextPage("patreon", { links: { next } }, url, 1), /unexpected pagination/);
  }
});

test("cancellation before and during an export prevents results and further requests", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(collectSubscribers(boosty, {
    signal: controller.signal, pause: immediate,
    request: async () => { calls++; controller.abort(); return boostyPage([1], 2); },
  }), { name: "AbortError" });
  assert.equal(calls, 1);
  await assert.rejects(collectSubscribers(boosty, { signal: controller.signal, request: async () => calls++ }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("unknown Boosty total paginates until an empty response", async () => {
  let calls = 0;
  const rows = await collectSubscribers(boosty, { pause: immediate, request: async () => {
    calls++; return { data: calls === 1 ? boostyPage([1]).data : [] };
  } });
  assert.equal(rows.length, 1);
  assert.equal(calls, 2);
});

test("unknown Patreon total does not mistake a server-capped short page for completion", async () => {
  const offsets = [];
  const rows = await collectSubscribers(patreon, { pause: immediate, request: async (url) => {
    offsets.push(url.searchParams.get("page[offset]"));
    const page = patreonPage();
    delete page.meta;
    if (offsets.length > 1) page.data = [];
    return page;
  } });
  assert.equal(rows.length, 1);
  assert.deepEqual(offsets, ["0", "1"]);
});
