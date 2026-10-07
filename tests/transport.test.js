import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { pageRequest, inspectPage, retryDelay, responseError, delay, createTransport } from "../extension/src/transport.js";

function sandbox({ origin = "https://boosty.to", cookie = "", storage = {}, fetch = async () => Response.json({ data: [] }), resources = [] } = {}) {
  return vm.createContext({ URL, AbortController, setTimeout, clearTimeout,
    location: new URL(origin), document: { cookie }, localStorage: { getItem: (key) => storage[key] },
    performance: { getEntriesByType: () => resources.map((name) => ({ name })) }, fetch,
  });
}
const run = (context, args) => vm.runInContext(`(${pageRequest.toString()})(${JSON.stringify(args)})`, context);
const request = { url: "https://api.boosty.to/v1/blog/studio/subscribers?offset=0", expectedOrigin: "https://boosty.to", requestId: "job" };

test("session credentials stay in source execution context and only reach Boosty's API", async () => {
  let sent;
  const context = sandbox({ cookie: `auth=${encodeURIComponent(JSON.stringify({ accessToken: "synthetic-secret" }))}`,
    fetch: async (url, options) => { sent = { url, options }; return Response.json({ data: [] }); },
  });
  const result = await run(context, { ...request, currency: "RUB" });
  assert.equal(result.ok, true);
  assert.equal(sent.options.headers.Authorization, "Bearer synthetic-secret");
  assert.equal(sent.options.headers["X-Currency"], "RUB");
  assert.equal(sent.options.credentials, "include");
  assert.equal(sent.options.method, "GET");
  assert.equal(sent.options.redirect, "error");
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
  assert.equal(context.__subtablePending.size, 0);
});

test("uses named Boosty local storage fallback and requires a session", async () => {
  assert.equal((await run(sandbox(), request)).code, "AUTH");
  assert.equal((await run(sandbox({ cookie: "auth=bad-json", storage: { token: JSON.stringify({ access_token: "synthetic" }) } }), request)).ok, true);
});

test("Patreon reuses cookies without a bearer token", async () => {
  let headers;
  const context = sandbox({ origin: "https://www.patreon.com/members", fetch: async (_, options) => { headers = options.headers; return Response.json({ data: [] }); } });
  assert.equal((await run(context, { ...request, url: "https://www.patreon.com/api/members", expectedOrigin: "https://www.patreon.com" })).ok, true);
  assert.equal(headers.Authorization, undefined);
});

test("transport rejects arbitrary endpoints and navigation before making a request", async () => {
  let calls = 0;
  const context = sandbox({ fetch: async () => calls++ });
  for (const url of ["https://evil.test/v1/blog/studio/subscribers", "https://api.boosty.to/v1/user/private", "https://api.boosty.to/v1/blog/../subscribers", "https://secret@api.boosty.to/v1/blog/studio/subscribers"]) {
    assert.equal((await run(context, { ...request, url })).code, "URL");
  }
  assert.equal((await run(context, { ...request, expectedOrigin: "https://www.patreon.com" })).code, "NAVIGATED");
  assert.equal(calls, 0);
});

test("HTML challenge, JSON error and rate limit responses produce safe actionable errors", async () => {
  const storage = { auth: JSON.stringify({ accessToken: "fake" }) };
  assert.equal((await run(sandbox({ storage, fetch: async () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }) }), request)).code, "FORMAT");
  assert.equal((await run(sandbox({ storage, fetch: async () => Response.json({ error: "private detail" }) }), request)).code, "API");
  const limit = await run(sandbox({ storage, fetch: async () => Response.json({ errors: [{ retry_after_seconds: 1800 }] }, { status: 429 }) }), request);
  assert.equal(limit.retryAfter, "1800");
  assert.match(responseError({ status: 401 }).message, /expired/);
  assert.match(responseError({ status: 403 }).message, /creator account/);
});

test("uses the live Audience observer instead of potentially stale resource history", () => {
  const url = "https://www.patreon.com/api/members?filter[campaign_id]=123&page[offset]=20";
  const context = sandbox({ origin: "https://www.patreon.com/members", resources: ["https://www.patreon.com/api/members?filter[campaign_id]=999"] });
  context.__subtablePatreonAudience = { read: () => url };
  const result = vm.runInContext(`(${inspectPage.toString()})()`, context);
  assert.equal(result.creator, "123");
  assert.equal(result.observedUrl, url);
});

test("refuses cached filters when observation is missing or has not seen Audience", () => {
  const context = sandbox({ origin: "https://www.patreon.com/members", resources: ["https://www.patreon.com/api/members?filter[campaign_id]=123"] });
  for (const state of [undefined, { read: () => "" }, { read: () => "https://evil.test/api/members" }]) {
    context.__subtablePatreonAudience = state;
    const result = vm.runInContext(`(${inspectPage.toString()})()`, context);
    assert.equal(result.observedUrl, "");
    assert.equal(result.creator, "");
  }
});

test("retry delay respects seconds and HTTP dates, and backoff can be cancelled", async () => {
  assert.equal(retryDelay("30", 0), 30000);
  assert.equal(retryDelay("Wed, 07 Oct 2026 12:00:30 GMT", 0, Date.parse("2026-10-07T12:00:00Z")), 30000);
  assert.equal(retryDelay(null, 2), 4000);
  const controller = new AbortController();
  const waiting = delay(60000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("extension retries rate limits but never retries authentication failures", async () => {
  let calls = 0;
  globalThis.chrome = { scripting: { executeScript: async () => [{ result: ++calls === 1 ? { ok: false, status: 429, retryAfter: "0" } : { ok: true, data: { data: [] } } }] } };
  try {
    const get = createTransport({ tabId: 1, documentId: "document", origin: "https://boosty.to" });
    assert.deepEqual(await get(request.url), { data: [] });
    assert.equal(calls, 2);
    calls = 0;
    chrome.scripting.executeScript = async () => { calls++; return [{ result: { ok: false, status: 401 } }]; };
    await assert.rejects(get(request.url), /expired/);
    assert.equal(calls, 1);
    chrome.scripting.executeScript = async () => [{ result: { ok: false, status: 429, retryAfter: "1800" } }];
    await assert.rejects(get(request.url), /1800 seconds/);
  } finally { delete globalThis.chrome; }
});
