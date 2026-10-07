// Real MV3 browser smoke test with entirely synthetic, intercepted platform
// responses. Runs in a disposable profile; never accesses your browser session.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm, access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { patreonPage, boostyPage } from "./fixtures.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const candidates = [process.env.CHROME_BIN, "/Applications/Brave Origin.app/Contents/MacOS/Brave Origin", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean);
let binary;
for (const candidate of candidates) { try { await access(candidate); binary = candidate; break; } catch {} }
if (!binary) throw new Error("Set CHROME_BIN to a Chromium browser with --load-extension support.");
const profile = await mkdtemp(path.join(os.tmpdir(), "subtable-browser-"));
const output = path.join(root, "test-results");
await mkdir(output, { recursive: true });
const downloads = path.join(profile, "downloads");
await mkdir(downloads);
const browser = spawn(binary, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--disable-extensions-except=${root}extension`, `--load-extension=${root}extension`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let log = "";
browser.stderr.on("data", (data) => { log += data; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, description, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(80); }
  throw new Error(`Timed out: ${description}`);
}
let ws;
try {
  const portFile = await until(async () => { try { return await readFile(path.join(profile, "DevToolsActivePort"), "utf8"); } catch { return null; } }, "browser startup");
  const [port, socket] = portFile.trim().split("\n");
  ws = new WebSocket(`ws://127.0.0.1:${port}${socket}`);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map(), listeners = new Map(), errors = [];
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const task = pending.get(message.id); pending.delete(message.id);
      if (message.error) task?.reject(new Error(message.error.message)); else task?.resolve(message.result);
    } else for (const fn of listeners.get(message.method) ?? []) fn(message.params, message.sessionId);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(key, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id: key, method, params, sessionId }));
  });
  const on = (method, fn) => listeners.set(method, [...listeners.get(method) ?? [], fn]);
  const evaluate = async (session, expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const attach = async (targetId) => (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  on("Runtime.exceptionThrown", (event) => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  const requests = [];
  let failBoosty = false;
  on("Fetch.requestPaused", async (event, session) => {
    try {
      const url = new URL(event.request.url);
      requests.push({ url: url.href, headers: event.request.headers });
      let body, contentType = "application/json", status = 200;
      if (event.resourceType === "Document") {
        contentType = "text/html";
        body = url.hostname === "boosty.to"
          ? '<!doctype html><title>Test Boosty</title><h1>Synthetic creator</h1><script>document.cookie="auth="+encodeURIComponent(JSON.stringify({accessToken:"synthetic-session"}))+";path=/;secure";</script>'
          : '<!doctype html><title>Test Patreon</title><h1>Synthetic creator</h1><script>fetch("/api/members?filter%5Bcampaign_id%5D=123&filter%5Bmembership_type%5D=active_patron&fields%5Bmember%5D=email&page%5Boffset%5D=0")</script>';
      } else if (event.request.method === "OPTIONS") body = "";
      else if (url.pathname === "/api/members") body = JSON.stringify(patreonPage(url.searchParams.has("page[cursor]") ? "m-2" : "m-1", { total: 2, next: url.searchParams.has("page[cursor]") ? null : "next-cursor" }));
      else if (url.pathname === "/v1/user/current") body = JSON.stringify({ user: { blogUrl: "studio", defaultCurrency: "RUB" } });
      else if (url.pathname === "/v1/blog/studio/subscribers") {
        status = failBoosty ? 401 : 200;
        body = JSON.stringify(failBoosty ? { error: "Expired" } : boostyPage(Number(url.searchParams.get("offset")) === 0 ? [1, 2] : [3], 3));
      } else { status = 404; body = "{}"; }
      await send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: status, responseHeaders: [
        { name: "Content-Type", value: contentType },
        { name: "Access-Control-Allow-Origin", value: "https://boosty.to" },
        { name: "Access-Control-Allow-Credentials", value: "true" },
        { name: "Access-Control-Allow-Headers", value: "authorization,x-currency" },
        { name: "Access-Control-Allow-Methods", value: "GET,OPTIONS" },
      ], body: Buffer.from(body).toString("base64") }, session);
    } catch (error) { errors.push(error.message); }
  });
  const source = async (url) => {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const session = await attach(targetId);
    await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, session);
    await send("Runtime.enable", {}, session);
    await send("Page.navigate", { url }, session);
    await until(() => evaluate(session, "document.readyState === 'complete'"), "source page ready");
    return session;
  };
  const worker = await until(async () => (await send("Target.getTargets")).targetInfos.find((target) => target.type === "service_worker" && target.url.endsWith("/src/background.js")), "extension worker");
  const patreonSession = await source("https://www.patreon.com/members");
  await until(() => evaluate(patreonSession, "performance.getEntriesByType('resource').some(e=>e.name.includes('/api/members'))"), "initial Audience request complete");
  await source("https://boosty.to/studio/blog/statistics/subscribers");
  const extensionOrigin = `chrome-extension://${new URL(worker.url).host}`;
  const { targetId: appTarget } = await send("Target.createTarget", { url: `${extensionOrigin}/export.html` });
  const app = await attach(appTarget);
  await send("Runtime.enable", {}, app);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false }, app);
  await until(() => evaluate(app, "document.querySelectorAll('#source-tab option').length === 2"), "tab discovery");
  const click = (id) => evaluate(app, `document.getElementById(${JSON.stringify(id)}).click()`);
  const waitTitle = (text) => until(() => evaluate(app, `document.getElementById('status-title').textContent === ${JSON.stringify(text)}`), text);
  const choose = async (name) => {
    await evaluate(app, `(() => {const select=document.getElementById('source-tab'); select.value=[...select.options].find(o=>o.textContent.startsWith(${JSON.stringify(name)})).value; select.dispatchEvent(new Event('change'));})()`);
    await click("connect"); await waitTitle("Your page is linked");
  };
  await choose("Patreon");
  assert.equal(await evaluate(app, "document.getElementById('creator').value"), "123");
  await click("export"); await waitTitle("Your CSV is ready");
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "2");
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  await click("download");
  const csvFile = await until(async () => (await readdir(downloads)).find((file) => file.endsWith(".csv")), "CSV download");
  const csv = await readFile(path.join(downloads, csvFile), "utf8");
  assert.ok(csv.startsWith('\uFEFF"platform"'));
  assert.ok(csv.includes('"m-1"'));
  assert.ok(csv.includes('"m-2"'));
  assert.ok(csv.includes('"Studio ""Plus"""'));
  await until(() => evaluate(app, "document.getElementById('download-status').textContent === 'CSV saved to your chosen location.'"), "download completed");

  // Reproduce a full resource timing history. Its retained request is stale,
  // but the live observer must capture a new Audience selection anyway.
  await evaluate(patreonSession, "Promise.all(Array.from({length:260}, (_,i)=>fetch('/buffer-fill?n='+i).then(r=>r.text())))");
  await evaluate(patreonSession, "fetch('/api/members?filter[campaign_id]=123&filter[membership_type]=declined_patron').then(r=>r.text())");
  assert.equal(await evaluate(patreonSession, "performance.getEntriesByType('resource').some(e=>e.name.includes('declined_patron'))"), false);
  await click("connect"); await waitTitle("Your page is linked");
  assert.equal(await evaluate(app, "document.getElementById('scope').options[1].disabled"), false);
  await evaluate(app, "document.getElementById('scope').value = 'current'");
  const beforeFiltered = requests.length;
  await click("export"); await waitTitle("Your CSV is ready");
  const filteredRequests = requests.slice(beforeFiltered).filter((request) => request.url.includes("/api/members"));
  assert.ok(filteredRequests.length >= 2);
  assert.ok(filteredRequests.every((request) => new URL(request.url).searchParams.get("filter[membership_type]") === "declined_patron"));

  // A tab opened before extension installation may lack the observer. Do not
  // fall back to the now-stale resource history or silently enable all filters.
  await evaluate(app, "chrome.scripting.executeScript({target:{tabId:Number(document.getElementById('source-tab').value)},world:'ISOLATED',func:()=>{delete globalThis.__subtablePatreonAudience;}})");
  await click("connect"); await waitTitle("Your page is linked");
  assert.equal(await evaluate(app, "document.getElementById('scope').options[1].disabled"), true);
  assert.equal(await evaluate(app, "document.getElementById('scope-hint').hidden"), false);
  await evaluate(app, "document.getElementById('creator').value='123';document.getElementById('creator').dispatchEvent(new Event('input'))");
  await click("export"); await waitTitle("Your CSV is ready");

  // Hold a download before its ID is returned, then prepare a different table.
  // A late completion must leave that newer table's save status untouched.
  await evaluate(app, `(() => {
    window.restoreDownloads = () => { chrome.downloads.download = originalDownload; chrome.downloads.search = originalSearch; };
    const originalDownload = chrome.downloads.download, originalSearch = chrome.downloads.search;
    chrome.downloads.download = () => new Promise(resolve => { window.finishOldDownload = () => resolve(900001); });
    chrome.downloads.search = async () => [{state:'complete'}];
  })()`);
  await click("download");
  await choose("Boosty");
  assert.equal(await evaluate(app, "document.getElementById('creator').value"), "studio");
  await click("export"); await waitTitle("Your CSV is ready");
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "3");
  assert.equal(await evaluate(app, "document.getElementById('download').disabled"), true);
  assert.equal(await evaluate(app, "document.getElementById('download-status').textContent"), "");
  await evaluate(app, "window.finishOldDownload()");
  await until(() => evaluate(app, "!document.getElementById('download').disabled"), "old download settled");
  assert.equal(await evaluate(app, "document.getElementById('download-status').textContent"), "");
  await evaluate(app, "window.restoreDownloads();delete window.restoreDownloads;delete window.finishOldDownload");
  const boostyHeaders = requests.filter((r) => r.url.includes("/v1/blog/studio/subscribers")).map((r) => Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v])));
  assert.ok(boostyHeaders.some((headers) => headers.authorization === "Bearer synthetic-session"));
  const desktop = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, app);
  await writeFile(path.join(output, "desktop.png"), Buffer.from(desktop.data, "base64"));
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, app);
  assert.equal(await evaluate(app, "document.documentElement.scrollWidth <= innerWidth"), true);
  const mobile = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, app);
  await writeFile(path.join(output, "mobile.png"), Buffer.from(mobile.data, "base64"));
  failBoosty = true;
  await click("export"); await waitTitle("Export stopped");
  assert.ok(await evaluate(app, "document.getElementById('status-detail').textContent.includes('expired')"));
  assert.equal(await evaluate(app, "document.getElementById('result-area').hidden"), true);
  failBoosty = false;
  await click("export");
  await until(() => evaluate(app, "!document.getElementById('progress-area').hidden"), "export running");
  await click("cancel"); await waitTitle("Export cancelled");
  assert.equal(await evaluate(app, "document.getElementById('result-area').hidden"), true);
  assert.deepEqual(errors, []);
  console.log("Browser smoke passed: MV3 loading, both platforms, pagination, CSV download, live filters after timing-buffer overflow, missing-observer guard, download ownership, responsive layout, expired session and cancellation.");
  await send("Browser.close");
} catch (error) {
  console.error(log.slice(-2000));
  throw error;
} finally {
  ws?.close();
  if (browser.exitCode == null) browser.kill("SIGTERM");
  await sleep(500);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
