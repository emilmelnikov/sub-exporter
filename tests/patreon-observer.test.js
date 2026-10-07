import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/src/patreon-observer.js", import.meta.url), "utf8");
const memberUrl = (filter) => `https://www.patreon.com/api/members?filter[campaign_id]=123&filter[membership_type]=${filter}`;
function fixture() {
  let callback, options, queued = [];
  const context = vm.createContext({ URL, location: new URL("https://www.patreon.com/members"),
    PerformanceObserver: class {
      constructor(fn) { callback = fn; }
      observe(value) { options = value; }
      takeRecords() { const batch = queued; queued = []; return batch; }
    },
  });
  vm.runInContext(source, context);
  return {
    context, read: () => context.__subtablePatreonAudience.read(),
    emit: (entries) => callback({ getEntries: () => entries }),
    queue: (entries) => { queued = entries; }, get options() { return options; },
  };
}

test("observes fresh requests without importing possibly truncated history", () => {
  const f = fixture();
  assert.equal(f.options.type, "resource");
  assert.equal(f.options.buffered, undefined);
  assert.equal(f.read(), "");
  f.emit([{ name: memberUrl("active_patron"), startTime: 10 }]);
  f.emit([{ name: memberUrl("declined_patron"), startTime: 20 }]);
  assert.equal(f.read(), memberUrl("declined_patron"));
});

test("ignores unrelated requests and an older request that finishes later", () => {
  const f = fixture();
  f.emit([{ name: memberUrl("declined_patron"), startTime: 20 }]);
  f.emit([
    { name: memberUrl("active_patron"), startTime: 10 },
    { name: "https://evil.test/api/members", startTime: 30 },
    { name: "https://www.patreon.com/api/posts", startTime: 40 },
    { name: "https://secret@www.patreon.com/api/members", startTime: 50 },
  ]);
  assert.equal(f.read(), memberUrl("declined_patron"));
});

test("connecting drains pending observer records before reading filters", () => {
  const f = fixture();
  f.emit([{ name: memberUrl("active_patron"), startTime: 10 }]);
  f.queue([{ name: "https://www.patreon.com/api/campaigns/456/members?query=new", startTime: 20 }]);
  assert.equal(f.read(), "https://www.patreon.com/api/campaigns/456/members?query=new");
  vm.runInContext(source, f.context);
  assert.equal(f.read(), "https://www.patreon.com/api/campaigns/456/members?query=new");
});
