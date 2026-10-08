import test from "node:test";
import assert from "node:assert/strict";
import { Audience, browseRows } from "../extension/src/audience.js";
import { toCsv } from "../extension/src/csv.js";
import { collectSubscribers } from "../extension/src/exporter.js";
import { boostyPage } from "./fixtures.js";

const patreon = { platform: "patreon", creator: "123" };
const boosty = { platform: "boosty", creator: "studio" };
const row = (id, extra = {}) => ({ subscriber_id: String(id), name: `Reader ${id}`, ...extra });

test("accumulates sources without merging coincident IDs or shared email addresses", () => {
  const audience = new Audience();
  for (const source of [patreon, boosty, { ...boosty, creator: "second" }]) audience.merge(source, [row(1, { email: "same@example.test" })]);
  assert.equal(audience.size, 3);
  assert.deepEqual(audience.rows().map((r) => r.source), ["Patreon · 123", "Boosty · studio", "Boosty · second"]);
  const csv = toCsv(audience.rows());
  assert.ok(csv.startsWith('\uFEFF"source","platform","creator"'));
  assert.ok(csv.includes('"Patreon · 123","patreon","123"'));
  assert.ok(csv.includes('"Boosty · second","boosty","second"'));
});

test("repeat or overlapping filtered imports update matches and retain other rows", () => {
  const audience = new Audience();
  audience.merge(patreon, [row(1), row(2)]);
  audience.merge(boosty, [row(1)]);
  const result = audience.merge(patreon, [row(2, { status: "inactive" }), row(3)]);
  assert.deepEqual(result, { added: 1, updated: 1, source: "Patreon · 123" });
  assert.equal(audience.size, 4);
  assert.equal(audience.rows().find((r) => r.platform === "patreon" && r.subscriber_id === "2").status, "inactive");
  assert.deepEqual(audience.sources().map((s) => s.count), [3, 1]);
  audience.merge(patreon, [row(3), row(3)]);
  assert.equal(audience.size, 4);
});

test("import failures and cancellation retain the whole existing collection", async () => {
  const audience = new Audience();
  audience.merge(patreon, [row(1)]);
  const before = audience.rows(), revision = audience.revision;
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects((async () => {
      const rows = await collectSubscribers(boosty, {
        signal: controller.signal, pause: async () => {}, request: async () => {
          if (++calls === 2) {
            if (cancelled) controller.abort();
            else throw new Error("Session expired");
          }
          return boostyPage([calls], 3);
        },
      });
      audience.merge(boosty, rows);
    })());
    assert.deepEqual(audience.rows(), before);
    assert.equal(audience.revision, revision);
  }
});

test("invalid rows and combined size limits reject the entire pending merge", () => {
  const audience = new Audience(2);
  audience.merge(patreon, [row(1)]);
  const before = audience.rows(), revision = audience.revision;
  assert.throws(() => audience.merge(boosty, [row(2), row(3)]), /limited to 2/);
  assert.throws(() => audience.merge(boosty, [row(2), row("")]), /no ID/);
  assert.deepEqual(audience.rows(), before);
  assert.equal(audience.revision, revision);
  assert.equal(audience.sources().length, 1);
});

test("download snapshots stay unchanged after updates and clear", () => {
  const audience = new Audience();
  const original = row(1);
  audience.merge(patreon, [original]);
  const snapshot = audience.rows();
  original.name = "Changed outside collection";
  audience.merge(patreon, [row(1, { name: "Updated" })]);
  audience.clear();
  assert.equal(snapshot[0].name, "Reader 1");
  assert.equal(audience.size, 0);
  assert.equal(audience.hasImports, false);
  assert.deepEqual(audience.sources(), []);
});

test("empty imports can download headers without clearing earlier sources", () => {
  const audience = new Audience();
  audience.merge(patreon, []);
  assert.equal(audience.hasImports, true);
  assert.equal(audience.size, 0);
  assert.equal(toCsv(audience.rows()).split("\r\n").length, 2);
  audience.merge(boosty, [row(1)]);
  audience.merge(patreon, []);
  assert.equal(audience.size, 1);
});

test("browsing combines search and source filter without changing export rows", () => {
  const audience = new Audience();
  audience.merge(patreon, [row(1, { name: "Zoë Reader", email: "reader@example.test", tier: "Studio" })]);
  audience.merge(boosty, [row(1, { name: "Zoë Reader", email: "other@example.test" })]);
  const rows = audience.rows();
  assert.equal(browseRows(rows, { query: "ZOË", source: "Boosty · studio" }).total, 1);
  assert.equal(browseRows(rows, { query: "STUDIO", source: "Patreon · 123" }).total, 1);
  assert.equal(browseRows(rows, { query: "reader@example.test" }).total, 1);
  assert.equal(browseRows(rows, { query: "not present" }).total, 0);
  assert.equal(rows.length, 2);
  assert.equal(toCsv(rows).split("\r\n").length, 4);
});

test("pagination clamps after filtering and sorting is numeric and reversible", () => {
  const rows = Array.from({ length: 61 }, (_, i) => row(i + 1, { amount: 61 - i }));
  const last = browseRows(rows, { page: 3 });
  assert.equal(last.rows.length, 11);
  assert.equal(last.start, 51);
  assert.equal(last.end, 61);
  assert.equal(browseRows(rows, { page: 99, pageSize: 50 }).page, 2);
  const amounts = browseRows([row(1, { amount: 10 }), row(2, { amount: 2 }), row(3, { amount: 0 }), row(4)], { sort: "amount" });
  assert.deepEqual(amounts.rows.map((r) => r.subscriber_id), ["3", "2", "1", "4"]);
  const descending = browseRows(amounts.rows, { sort: "amount", direction: "desc" });
  assert.deepEqual(descending.rows.map((r) => r.subscriber_id), ["1", "2", "3", "4"]);
  assert.equal(rows[0].name, "Reader 1");
  assert.equal(browseRows(rows, { query: "missing", page: 4 }).page, 1);
});
