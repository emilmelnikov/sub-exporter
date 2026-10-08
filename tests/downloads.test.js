import test from "node:test";
import assert from "node:assert/strict";
import { createCsvDownloader } from "../extension/src/downloads.js";

const owner = (creator) => ({ rows: [{ name: creator }], options: {} });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ start, search = async () => [{ state: "in_progress" }] } = {}) {
  let changed;
  const calls = [], states = [];
  const downloader = createCsvDownloader({
    downloads: {
      onChanged: { addListener(fn) { changed = fn; } },
      download(options) { calls.push(options); return start ? start(options) : Promise.resolve(calls.length); }, search,
    },
    onState: (owner, state) => states.push({ owner, state }),
  });
  return { downloader, calls, states, emit: (id, state) => changed({ id, state: { current: state } }) };
}

test("download owns its original table and blocks duplicates before receiving an ID", async () => {
  const dialog = deferred();
  const f = fixture({ start: () => dialog.promise });
  const first = owner("first"), second = owner("second");
  const pending = f.downloader.start(first);
  assert.equal(f.downloader.busy, true);
  await f.downloader.start(second);
  assert.equal(f.calls.length, 1);
  assert.match(await (await fetch(f.calls[0].url)).text(), /first/);
  dialog.resolve(17);
  await pending;
  f.emit(99, "complete");
  assert.equal(f.downloader.busy, true);
  f.emit(17, "complete");
  assert.equal(f.downloader.busy, false);
  assert.deepEqual(f.states.map((s) => s.state), ["saving", "complete"]);
  assert.ok(f.states.every((s) => s.owner === first));
  await assert.rejects(fetch(f.calls[0].url));
});

test("late completion search from an old job cannot finish a newer download", async () => {
  const lookup = deferred();
  const f = fixture({ search: ({ id }) => id === 1 ? lookup.promise : Promise.resolve([{ state: "in_progress" }]) });
  const first = owner("first"), second = owner("second");
  const pending = f.downloader.start(first);
  await Promise.resolve();
  f.emit(1, "complete");
  await f.downloader.start(second);
  lookup.resolve([{ state: "complete" }]);
  await pending;
  assert.equal(f.downloader.busy, true);
  assert.equal(f.states.filter((s) => s.state === "complete").length, 1);
  assert.match(await (await fetch(f.calls[1].url)).text(), /second/);
  f.emit(2, "complete");
  assert.equal(f.states.at(-1).owner, second);
});

test("search recovers a completion event that arrived before the download ID", async () => {
  const f = fixture({ start: async () => { f.emit(8, "complete"); return 8; }, search: async () => [{ state: "complete" }] });
  const table = owner("quick");
  await f.downloader.start(table);
  assert.equal(f.downloader.busy, false);
  assert.deepEqual(f.states, [{ owner: table, state: "saving" }, { owner: table, state: "complete" }]);
});

test("cancelled Save As releases the blob and allows retry", async () => {
  const f = fixture({ start: async () => { throw new Error("User cancelled"); } });
  await f.downloader.start(owner("first"));
  assert.equal(f.downloader.busy, false);
  assert.equal(f.states.at(-1).state, "interrupted");
  await assert.rejects(fetch(f.calls[0].url));
  await f.downloader.start(owner("retry"));
  assert.equal(f.calls.length, 2);
});

test("a failed lookup does not report an in-progress download as interrupted", async () => {
  const f = fixture({ search: async () => { throw new Error("Lookup unavailable"); } });
  await f.downloader.start(owner("first"));
  assert.equal(f.downloader.busy, true);
  assert.deepEqual(f.states.map((s) => s.state), ["saving"]);
  f.emit(1, "interrupted");
  assert.equal(f.downloader.busy, false);
  assert.equal(f.states.at(-1).state, "interrupted");
});
