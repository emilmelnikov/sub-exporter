import { platformForUrl, validateCreator } from "./platforms.js";
import { inspectPage, createTransport } from "./transport.js";
import { collectSubscribers } from "./exporter.js";
import { createCsvDownloader } from "./downloads.js";

const $ = (id) => document.getElementById(id);
let context = null;
let controller = null;
let busy = false;
let result = null;
const csvDownloads = createCsvDownloader({
  onState(owner, state) {
    if (result === owner) {
      $("download-status").textContent = {
        saving: "Saving CSV…",
        complete: "CSV saved to your chosen location.",
        interrupted: "Download cancelled or interrupted. Your table is still ready to download.",
      }[state];
    }
    $("download").disabled = csvDownloads.busy || !result;
  },
});
let tabs = [];
let preferredTab = Number(new URL(location.href).searchParams.get("tab"));

function setStatus(title, detail, kind = "idle") {
  $("status-title").textContent = title;
  $("status-detail").textContent = detail;
  $("status-panel").className = `status-panel ${kind}`;
  $("status-icon").textContent = { idle: "↧", working: "↓", success: "✓", error: "!" }[kind];
}

function updateControls() {
  $("source-tab").disabled = busy;
  $("refresh-tabs").disabled = busy;
  $("connect").disabled = busy || !$("source-tab").value;
  $("export-options").disabled = busy || !context;
  $("export").disabled = busy || !context || !$("creator").value.trim();
  $("scope").options[1].disabled = !context?.observedUrl;
  $("scope-hint").hidden = context?.platform !== "patreon" || Boolean(context.observedUrl);
  $("connection-badge").textContent = context ? "Page linked" : "Not connected";
  $("connection-badge").className = `badge${context ? " connected" : ""}`;
}

function clearResult() {
  result = null;
  $("preview").replaceChildren();
  $("result-area").hidden = true;
  $("download-status").textContent = "";
}

function disconnect() {
  context = null;
  clearResult();
  $("creator").value = "";
  $("scope").value = "all";
  setStatus("Ready when you are", "Connect a creator tab, then prepare your subscriber table.");
  updateControls();
}

async function refreshTabs() {
  const previous = Number($("source-tab").value) || preferredTab;
  tabs = (await chrome.tabs.query({ url: ["https://www.patreon.com/*", "https://patreon.com/*", "https://boosty.to/*"] }))
    .filter((tab) => platformForUrl(tab.url));
  $("source-tab").replaceChildren();
  if (!tabs.length) {
    $("source-tab").add(new Option("Open a Patreon or Boosty tab first", ""));
    disconnect();
  } else {
    for (const tab of tabs) {
      const platform = platformForUrl(tab.url);
      $("source-tab").add(new Option(`${platform === "patreon" ? "Patreon" : "Boosty"} · ${tab.title || new URL(tab.url).pathname}`, String(tab.id)));
    }
    if (tabs.some((tab) => tab.id === previous)) $("source-tab").value = String(previous);
    if (context && Number($("source-tab").value) !== context.tabId) disconnect();
  }
  updateControls();
}

async function connect() {
  clearResult();
  context = null;
  busy = true;
  updateControls();
  setStatus("Connecting to your page", "Reading the creator page in your browser…", "working");
  try {
    const tabId = Number($("source-tab").value);
    const [inspection] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: inspectPage });
    if (!inspection?.result || !inspection.documentId) throw new Error("Could not read this tab. Refresh the creator page and try again.");
    const next = { ...inspection.result, tabId, documentId: inspection.documentId, currency: "" };
    const request = createTransport(next);
    let detectionNote = "";
    if (next.platform === "boosty") {
      const payload = await request("https://api.boosty.to/v1/user/current");
      const user = payload.user ?? payload.data ?? payload;
      next.creator ||= user.blogUrl ?? "";
      next.currency = user.defaultCurrency ?? "";
    } else if (!next.creator) {
      try {
        const payload = await request(new URL("/api/current_user?include=campaign", next.origin));
        const campaign = payload.data?.relationships?.campaign?.data;
        next.creator = campaign?.id ?? "";
        next.currency = payload.included?.find((item) => item.type === "campaign" && item.id === next.creator)?.attributes?.currency ?? "";
      } catch {
        detectionNote = " Open Patreon Audience, refresh and reconnect to detect your campaign, or enter its numeric ID below.";
      }
    }
    context = next;
    $("creator-label").textContent = next.platform === "patreon" ? "Patreon campaign ID" : "Boosty blog name";
    $("creator").placeholder = next.platform === "patreon" ? "e.g. 1234567" : "e.g. your-blog";
    $("creator").value = next.creator;
    $("creator-hint").textContent = next.platform === "patreon"
      ? "This is your numeric campaign ID, not your page’s display name."
      : "Your blog’s URL name, without https://boosty.to/. All subscription statuses are included.";
    $("scope-field").hidden = next.platform !== "patreon";
    $("scope").value = "all";
    setStatus("Your page is linked", next.creator
      ? `Ready to read ${next.platform === "patreon" ? "Patreon campaign" : "Boosty blog"} ${next.creator}. Choose your options and prepare the CSV.`
      : `Enter your creator ID to continue.${detectionNote}`, "success");
  } catch (error) {
    setStatus("Couldn’t connect", error.message, "error");
  } finally {
    busy = false;
    updateControls();
  }
}

async function prepare() {
  clearResult();
  try {
    const creator = validateCreator(context.platform, $("creator").value);
    const scope = $("scope").value;
    if (scope === "current" && creator !== context.creator) throw new Error("Reconnect to this campaign’s Audience page before exporting its current filters.");
    const job = { ...context, creator, scope };
    controller = new AbortController();
    busy = true;
    updateControls();
    $("progress-area").hidden = false;
    $("cancel").disabled = false;
    $("progress").removeAttribute("value");
    $("progress-count").textContent = "0 subscribers";
    $("progress-pages").textContent = "Starting…";
    setStatus("Preparing your table", "Reading subscribers from your creator account. Keep both tabs open.", "working");
    const request = createTransport(job, {
      signal: controller.signal,
      onRetry: (seconds) => setStatus("Giving the platform a moment", `Retrying in ${seconds} seconds…`, "working"),
    });
    const rows = await collectSubscribers(job, {
      request, signal: controller.signal,
      onProgress: ({ count, total, page }) => {
        $("progress-count").textContent = `${count.toLocaleString()}${total != null ? ` / ${total.toLocaleString()}` : ""} subscribers`;
        $("progress-pages").textContent = `Page ${page}`;
        if (total > 0) { $("progress").max = total; $("progress").value = count; }
        setStatus("Preparing your table", "Collecting and checking every page of subscribers…", "working");
      },
    });
    result = { rows, job, options: { delimiter: $("delimiter").value, bom: $("bom").checked } };
    $("result-count").textContent = rows.length.toLocaleString();
    for (const row of rows.slice(0, 5)) {
      const tr = document.createElement("tr");
      for (const value of [row.name, row.tier, row.status]) {
        const td = document.createElement("td");
        td.textContent = value || "—";
        td.title = value || "Unavailable";
        tr.append(td);
      }
      $("preview").append(tr);
    }
    $("result-note").textContent = rows.length
      ? `${rows.filter((row) => row.email).length.toLocaleString()} email addresses available. ${scope === "current" ? "Uses the Patreon Audience filters detected when you connected." : "Includes all membership statuses returned by the platform."}`
      : "This audience returned no subscribers. The CSV will contain column headers only.";
    $("result-area").hidden = false;
    $("download").disabled = csvDownloads.busy;
    setStatus("Your CSV is ready", "Your subscriber table is prepared. Choose where to save it.", "success");
  } catch (error) {
    clearResult();
    setStatus(error.name === "AbortError" ? "Export cancelled" : "Export stopped", error.name === "AbortError"
      ? "No CSV was created. You can start a fresh export whenever you’re ready."
      : error.message, error.name === "AbortError" ? "idle" : "error");
  } finally {
    controller = null;
    busy = false;
    $("progress-area").hidden = true;
    updateControls();
  }
}

$("source-tab").addEventListener("change", disconnect);
$("refresh-tabs").addEventListener("click", () => refreshTabs().catch((error) => setStatus("Couldn’t find tabs", error.message, "error")));
$("connect").addEventListener("click", connect);
$("creator").addEventListener("input", updateControls);
$("export").addEventListener("click", prepare);
$("cancel").addEventListener("click", () => {
  controller?.abort();
  $("cancel").disabled = true;
  setStatus("Cancelling export", "Stopping the current request…", "working");
});
$("download").addEventListener("click", () => csvDownloads.start(result));
$("clear").addEventListener("click", () => { clearResult(); setStatus("Subscriber data cleared", "The table has been removed from this tab’s memory. You can prepare another export."); });
window.addEventListener("beforeunload", (event) => {
  if (busy || csvDownloads.busy) { event.preventDefault(); event.returnValue = ""; }
});
refreshTabs().catch((error) => setStatus("Couldn’t start", error.message, "error"));
