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
  let failAfterFirst = false;
  let nextConfirmation = null;
  on("Page.javascriptDialogOpening", (event, session) => {
    const accept = event.type === "beforeunload" || nextConfirmation === true;
    nextConfirmation = null;
    void send("Page.handleJavaScriptDialog", { accept }, session);
  });
  on("Fetch.requestPaused", async (event, session) => {
    try {
      const url = new URL(event.request.url);
      requests.push({ url: url.href, headers: event.request.headers });
      let body, contentType = "application/json", status = 200;
      if (event.resourceType === "Document") {
        contentType = "text/html";
        body = url.hostname === "boosty.to"
          ? `<!doctype html><title>Test Boosty ${url.pathname.split('/')[1]}</title><h1>Synthetic creator</h1><script>document.cookie="auth="+encodeURIComponent(JSON.stringify({accessToken:"synthetic-session"}))+";path=/;secure";</script>`
          : '<!doctype html><title>Test Patreon</title><h1>Synthetic creator</h1><script>fetch("/api/members?filter%5Bcampaign_id%5D=123&filter%5Bmembership_type%5D=active_patron&fields%5Bmember%5D=email&page%5Boffset%5D=0")</script>';
      } else if (event.request.method === "OPTIONS") body = "";
      else if (url.pathname === "/api/members") body = JSON.stringify(patreonPage(url.searchParams.has("page[cursor]") ? "m-2" : "m-1", { total: 2, next: url.searchParams.has("page[cursor]") ? null : "next-cursor" }));
      else if (url.pathname === "/v1/user/current") body = JSON.stringify({ user: { blogUrl: "studio", defaultCurrency: "RUB" } });
      else if (/^\/v1\/blog\/[^/]+\/subscribers$/.test(url.pathname)) {
        const creator = url.pathname.split('/')[3];
        const offset = Number(url.searchParams.get("offset"));
        const total = creator === "empty" ? 0 : creator === "second" ? 2 : 30;
        status = failAfterFirst && offset > 0 ? 401 : 200;
        const ids = Array.from({length:Math.max(0, Math.min(20,total-offset))}, (_,i)=>offset+i+1);
        const payload = boostyPage(ids, total);
        payload.data.forEach((row) => { row.name = `Reader ${row.id}`; row.email = `reader${row.id}@example.test`; });
        body = JSON.stringify(status === 401 ? { error: "Expired" } : payload);
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
  await send("Page.enable", {}, app);
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
  await click("import"); await waitTitle("Import complete");
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "2");
  assert.deepEqual(await readdir(downloads), [], "import must not download a file");
  assert.equal(await evaluate(app, "document.getElementById('source-count').textContent"), "1");
  assert.equal(await evaluate(app, "document.querySelectorAll('#subscriber-rows tr').length"), 2);
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  await click("download");
  const csvFile = await until(async () => (await readdir(downloads)).find((file) => file.endsWith(".csv")), "CSV download");
  const csv = await readFile(path.join(downloads, csvFile), "utf8");
  assert.ok(csv.startsWith('\uFEFF"source"'));
  assert.ok(csv.includes('"m-1"'));
  assert.ok(csv.includes('"m-2"'));
  assert.ok(csv.includes('"Studio ""Plus"""'));
  await until(() => evaluate(app, "document.getElementById('download-status').textContent === 'Combined CSV saved to your chosen location.'"), "download completed");

  // Reproduce a full resource timing history. Its retained request is stale,
  // but the live observer must capture a new Audience selection anyway.
  await evaluate(patreonSession, "Promise.all(Array.from({length:260}, (_,i)=>fetch('/buffer-fill?n='+i).then(r=>r.text())))");
  await evaluate(patreonSession, "fetch('/api/members?filter[campaign_id]=123&filter[membership_type]=declined_patron').then(r=>r.text())");
  assert.equal(await evaluate(patreonSession, "performance.getEntriesByType('resource').some(e=>e.name.includes('declined_patron'))"), false);
  await click("connect"); await waitTitle("Your page is linked");
  assert.equal(await evaluate(app, "document.getElementById('scope').options[1].disabled"), false);
  await evaluate(app, "document.getElementById('scope').value = 'current'");
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "2", "reconnecting must preserve the collection");
  const beforeFiltered = requests.length;
  await click("import"); await waitTitle("Import complete");
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
  await click("import"); await waitTitle("Import complete");

  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "2", "repeat imports must update instead of duplicate");

  // Hold a download before its ID is returned, then import another source.
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
  await click("import"); await waitTitle("Import complete");
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "32");
  assert.equal(await evaluate(app, "document.getElementById('source-count').textContent"), "2");
  assert.equal(await evaluate(app, "document.getElementById('download').disabled"), true);
  assert.equal(await evaluate(app, "document.getElementById('download-status').textContent"), "");
  await evaluate(app, "window.finishOldDownload()");
  await until(() => evaluate(app, "!document.getElementById('download').disabled"), "old download settled");
  assert.equal(await evaluate(app, "document.getElementById('download-status').textContent"), "");
  await evaluate(app, "window.restoreDownloads();delete window.restoreDownloads;delete window.finishOldDownload");
  const boostyHeaders = requests.filter((r) => r.url.includes("/v1/blog/studio/subscribers")).map((r) => Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v])));
  assert.ok(boostyHeaders.some((headers) => headers.authorization === "Bearer synthetic-session"));
  // Browse every imported row through pagination, filtering, sorting and details.
  assert.equal(await evaluate(app, "document.querySelectorAll('#subscriber-rows tr').length"), 25);
  await click("next-page");
  assert.equal(await evaluate(app, "document.querySelectorAll('#subscriber-rows tr').length"), 7);
  await click("first-page");
  const setField = async (id, value, event = "change") => evaluate(app, `(() => {const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(event)}));})()`);
  await setField("table-search", "reader30@example.test", "input");
  await until(() => evaluate(app, "document.querySelectorAll('#subscriber-rows tr').length === 1"), "search results");
  await evaluate(app, "document.querySelector('#subscriber-rows .row-details').click()");
  assert.equal(await evaluate(app, "document.getElementById('subscriber-dialog').open"), true);
  assert.equal(await evaluate(app, "document.querySelectorAll('#subscriber-details dt').length"), 18);
  assert.ok(await evaluate(app, "document.getElementById('subscriber-details').textContent.includes('Boosty · studio')"));
  await click("close-details");
  await click("reset-filters");
  await setField("browse-source", "Boosty · studio");
  await evaluate(app, "document.querySelector('th[data-sort=name] button').click()");
  assert.equal(await evaluate(app, "document.querySelector('#subscriber-rows tr td:nth-child(2)').textContent"), "Reader 30");
  await setField("page-size", "50");
  assert.equal(await evaluate(app, "document.querySelectorAll('#subscriber-rows tr').length"), 30);
  await setField("browse-source", "Patreon · 123");
  assert.equal(await evaluate(app, "document.querySelectorAll('#subscriber-rows tr').length"), 2);

  // CSV exports the whole collection even when the browsing view is filtered.
  await setField("delimiter", ";");
  await evaluate(app, "document.getElementById('bom').checked=false;document.getElementById('bom').dispatchEvent(new Event('change'))");
  const existingFiles = new Set(await readdir(downloads));
  const requestsBeforeDownload = requests.length;
  await click("download");
  await until(() => evaluate(app, "document.getElementById('download-status').textContent === 'Combined CSV saved to your chosen location.'"), "combined CSV saved");
  assert.equal(requests.length, requestsBeforeDownload, "download must use imported data without fetching a source");
  const combinedName = (await readdir(downloads)).find((file) => file.endsWith(".csv") && !existingFiles.has(file));
  const combinedCsv = await readFile(path.join(downloads, combinedName), "utf8");
  assert.ok(combinedCsv.startsWith('"source";"platform";"creator"'));
  assert.ok(combinedCsv.includes('"Patreon · 123";"patreon";"123"'));
  assert.ok(combinedCsv.includes('"Boosty · studio";"boosty";"studio"'));
  assert.equal(combinedCsv.trimEnd().split("\r\n").length, 33);
  await setField("delimiter", ",");
  await evaluate(app, "document.getElementById('bom').checked=true;document.getElementById('bom').dispatchEvent(new Event('change'))");
  await click("reset-filters");

  // A second creator on the same platform remains a distinct source, even if
  // its subscriber IDs overlap with the first creator's IDs.
  await source("https://boosty.to/second/blog/statistics/subscribers");
  await click("refresh-tabs");
  await until(() => evaluate(app, "document.querySelectorAll('#source-tab option').length === 3"), "third source tab");
  await choose("Boosty · Test Boosty second");
  await click("import"); await waitTitle("Import complete");
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "34");
  assert.equal(await evaluate(app, "document.getElementById('source-count').textContent"), "3");
  await setField("page-size", "25");
  await evaluate(app, "document.querySelector('th[data-sort=source] button').click()");

  const desktop = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, app);
  await writeFile(path.join(output, "desktop.png"), Buffer.from(desktop.data, "base64"));
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, app);
  assert.equal(await evaluate(app, "document.documentElement.scrollWidth <= innerWidth"), true);
  const mobile = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, app);
  await writeFile(path.join(output, "mobile.png"), Buffer.from(mobile.data, "base64"));

  await setField("creator", "failing", "input");
  failAfterFirst = true;
  await click("import"); await waitTitle("Import stopped");
  assert.ok(await evaluate(app, "document.getElementById('status-detail').textContent.includes('expired')"));
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "34");
  assert.equal(await evaluate(app, "document.getElementById('source-count').textContent"), "3");
  failAfterFirst = false;
  await click("import");
  await until(() => evaluate(app, "document.getElementById('progress-pages').textContent === 'Page 1'"), "first import page");
  await click("cancel"); await waitTitle("Import cancelled");
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "34");
  assert.equal(await evaluate(app, "document.getElementById('source-count').textContent"), "3");

  nextConfirmation = false;
  await click("clear");
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "34");
  nextConfirmation = true;
  await click("clear"); await waitTitle("Collection cleared");
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "0");
  assert.equal(await evaluate(app, "document.getElementById('download').disabled"), true);
  assert.equal(await evaluate(app, "document.querySelectorAll('#subscriber-details dd').length"), 0);
  await setField("creator", "empty", "input");
  await click("import"); await waitTitle("Import complete");
  assert.equal(await evaluate(app, "document.getElementById('result-count').textContent"), "0");
  assert.equal(await evaluate(app, "document.getElementById('download').disabled"), false);
  const beforeEmptyFiles = new Set(await readdir(downloads));
  await click("download");
  await until(() => evaluate(app, "document.getElementById('download-status').textContent === 'Combined CSV saved to your chosen location.'"), "empty CSV saved");
  const emptyName = (await readdir(downloads)).find((file) => file.endsWith('.csv') && !beforeEmptyFiles.has(file));
  assert.equal((await readFile(path.join(downloads, emptyName), 'utf8')).split('\r\n').length, 2);
  assert.deepEqual(errors, []);
  console.log("Browser smoke passed: multiple-source imports, safe re-imports, source labels, combined CSV snapshots, search/sort/pagination/details, filter detection, preserved collection on failure/cancel, empty imports and clear confirmation.");
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
