import { platformForUrl, validateCreator } from "./platforms.js";
import { inspectPage, createTransport } from "./transport.js";
import { collectSubscribers } from "./exporter.js";
import { createCsvDownloader } from "./downloads.js";
import { Audience, browseRows } from "./audience.js";
import { COLUMNS } from "./csv.js";

const $ = (id) => document.getElementById(id);
const audience = new Audience();
const labels = {
  source: "Source", platform: "Platform", creator: "Creator", subscriber_id: "Subscriber ID", user_id: "User ID",
  name: "Name", email: "Email", status: "Status", tier: "Tier", amount: "Amount", currency: "Currency",
  lifetime_amount: "Lifetime amount", joined_at: "Joined", last_payment_at: "Last payment",
  last_payment_status: "Last payment status", next_payment_at: "Next payment", ended_at: "Ended", profile_url: "Profile URL",
};
let context = null;
let controller = null;
let busy = false;
let rows = [];
let downloadSnapshot = null;
let savedRevision = -1;
let searchTimer;
const browsing = { query: "", source: "", sort: "name", direction: "asc", page: 1, pageSize: 25 };
const preferredTab = Number(new URL(location.href).searchParams.get("tab"));
const csvDownloads = createCsvDownloader({
  onState(owner, state) {
    if (downloadSnapshot === owner) {
      $("download-status").textContent = {
        saving: "Saving the combined CSV…",
        complete: "Combined CSV saved to your chosen location.",
        interrupted: "Download cancelled or interrupted. Your imported table is still available.",
      }[state];
      if (state === "complete") savedRevision = owner.revision;
    }
    updateControls();
  },
});

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
  $("import-options").disabled = busy || !context;
  $("import").disabled = busy || !context || !$("creator").value.trim();
  $("scope").options[1].disabled = !context?.observedUrl;
  $("scope-hint").hidden = context?.platform !== "patreon" || Boolean(context.observedUrl);
  $("connection-badge").textContent = context ? "Page linked" : "Not connected";
  $("connection-badge").className = `badge${context ? " connected" : ""}`;
  $("download").disabled = busy || csvDownloads.busy || !audience.hasImports;
  $("csv-options").disabled = csvDownloads.busy;
  $("clear").disabled = busy || !audience.hasImports;
}

function invalidateDownloadStatus() {
  downloadSnapshot = null;
  $("download-status").textContent = "";
}

function renderCollection() {
  rows = audience.rows();
  const sources = audience.sources();
  $("result-count").textContent = audience.size.toLocaleString();
  $("source-count").textContent = sources.length.toLocaleString();
  $("column-count").textContent = String(COLUMNS.length);
  $("download-note").textContent = audience.hasImports
    ? `Downloads all ${audience.size.toLocaleString()} imported subscribers from ${sources.length} ${sources.length === 1 ? "source" : "sources"}. Table filters only affect browsing.`
    : "Import a source to start your combined CSV.";
  $("source-summary").replaceChildren();
  $("browse-source").replaceChildren(new Option("All sources", ""));
  for (const source of sources) {
    const chip = document.createElement("span");
    chip.textContent = `${source.label} · ${source.count.toLocaleString()}`;
    $("source-summary").append(chip);
    $("browse-source").add(new Option(`${source.label} (${source.count.toLocaleString()})`, source.label));
  }
  if (!sources.some((source) => source.label === browsing.source)) browsing.source = "";
  $("browse-source").value = browsing.source;
  renderTable();
  updateControls();
}

function showDetails(row) {
  $("details-title").textContent = row.name || "Subscriber details";
  $("subscriber-details").replaceChildren();
  for (const key of COLUMNS) {
    const term = document.createElement("dt");
    term.textContent = labels[key];
    const value = document.createElement("dd");
    value.textContent = row[key] === "" || row[key] == null ? "—" : String(row[key]);
    $("subscriber-details").append(term, value);
  }
  $("subscriber-dialog").showModal();
}

function renderTable() {
  const view = browseRows(rows, browsing);
  browsing.page = view.page;
  $("subscriber-rows").replaceChildren();
  for (const row of view.rows) {
    const tr = document.createElement("tr");
    for (const key of ["source", "name", "email", "tier", "status", "amount", "joined_at"]) {
      const td = document.createElement("td");
      const value = row[key];
      td.textContent = value === "" || value == null ? "—" : key === "amount" ? `${value} ${row.currency || ""}`.trim() : String(value);
      td.title = td.textContent;
      if (key === "source") td.className = `source-cell ${row.platform}`;
      tr.append(td);
    }
    const td = document.createElement("td");
    const button = document.createElement("button");
    button.className = "row-details";
    button.textContent = "Details";
    button.setAttribute("aria-label", `View details for ${row.name || row.subscriber_id} from ${row.source}`);
    button.addEventListener("click", () => showDetails(row));
    td.append(button);
    tr.append(td);
    $("subscriber-rows").append(tr);
  }
  $("table-wrap").hidden = !view.total;
  $("table-empty").hidden = Boolean(view.total);
  $("table-empty").textContent = !audience.hasImports ? "Your imported subscribers will appear here." : audience.size
    ? "No subscribers match these filters." : "The imported sources returned no subscribers.";
  $("table-summary").textContent = `${view.start.toLocaleString()}–${view.end.toLocaleString()} of ${view.total.toLocaleString()} matching · ${audience.size.toLocaleString()} imported`;
  $("page-label").textContent = `Page ${view.page.toLocaleString()} of ${view.pages.toLocaleString()}`;
  $("first-page").disabled = $("previous-page").disabled = view.page <= 1;
  $("last-page").disabled = $("next-page").disabled = view.page >= view.pages;
  $("reset-filters").hidden = !browsing.query && !browsing.source;
  for (const th of document.querySelectorAll("th[data-sort]")) {
    th.setAttribute("aria-sort", th.dataset.sort === browsing.sort ? browsing.direction === "asc" ? "ascending" : "descending" : "none");
  }
}

function disconnect() {
  context = null;
  $("creator").value = "";
  $("scope").value = "all";
  setStatus("Choose a source to import", "Connect a creator tab to add its subscribers to your collection.");
  updateControls();
}

async function refreshTabs() {
  const previous = Number($("source-tab").value) || preferredTab;
  const tabs = (await chrome.tabs.query({ url: ["https://www.patreon.com/*", "https://patreon.com/*", "https://boosty.to/*"] }))
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
        next.creator = payload.data?.relationships?.campaign?.data?.id ?? "";
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
      ? `Ready to import ${next.platform === "patreon" ? "Patreon campaign" : "Boosty blog"} ${next.creator}. Your existing collection will be kept.`
      : `Enter your creator ID to continue.${detectionNote}`, "success");
  } catch (error) {
    setStatus("Couldn’t connect", error.message, "error");
  } finally {
    busy = false;
    updateControls();
  }
}

async function importSubscribers() {
  if (busy || !context) return;
  try {
    const creator = validateCreator(context.platform, $("creator").value);
    const scope = $("scope").value;
    if (scope === "current" && creator !== context.creator) throw new Error("Reconnect to this campaign’s Audience page before importing its current filters.");
    const job = { ...context, creator, scope };
    controller = new AbortController();
    busy = true;
    updateControls();
    $("progress-area").hidden = false;
    $("cancel").disabled = false;
    $("progress").removeAttribute("value");
    $("progress-count").textContent = "0 subscribers";
    $("progress-pages").textContent = "Starting…";
    setStatus("Importing subscribers", "Reading this source. Your existing collection will be kept.", "working");
    const request = createTransport(job, {
      signal: controller.signal,
      onRetry: (seconds) => setStatus("Giving the platform a moment", `Retrying in ${seconds} seconds…`, "working"),
    });
    const imported = await collectSubscribers(job, {
      request, signal: controller.signal,
      onProgress: ({ count, total, page }) => {
        $("progress-count").textContent = `${count.toLocaleString()}${total != null ? ` / ${total.toLocaleString()}` : ""} subscribers`;
        $("progress-pages").textContent = `Page ${page}`;
        if (total > 0) { $("progress").max = total; $("progress").value = count; }
        setStatus("Importing subscribers", "Collecting and checking every page before adding this source…", "working");
      },
    });
    controller.signal.throwIfAborted();
    const merged = audience.merge(job, imported);
    invalidateDownloadStatus();
    browsing.page = 1;
    renderCollection();
    setStatus("Import complete", `${merged.source}: ${merged.added.toLocaleString()} added, ${merged.updated.toLocaleString()} updated. Import another source or download your combined CSV.`, "success");
  } catch (error) {
    setStatus(error.name === "AbortError" ? "Import cancelled" : "Import stopped", error.name === "AbortError"
      ? "No subscribers were added. Your existing collection is unchanged."
      : `${error.message} Your existing collection is unchanged.`, error.name === "AbortError" ? "idle" : "error");
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
$("import").addEventListener("click", importSubscribers);
$("cancel").addEventListener("click", () => {
  controller?.abort();
  $("cancel").disabled = true;
  setStatus("Cancelling import", "Stopping the current request…", "working");
});
$("download").addEventListener("click", () => {
  if (busy || csvDownloads.busy || !audience.hasImports) return;
  downloadSnapshot = { rows: audience.rows(), revision: audience.revision, options: { delimiter: $("delimiter").value, bom: $("bom").checked } };
  void csvDownloads.start(downloadSnapshot);
});
for (const id of ["delimiter", "bom"]) $(id).addEventListener("change", invalidateDownloadStatus);
$("clear").addEventListener("click", () => {
  if (busy || !audience.hasImports || !confirm("Clear all imported subscribers from this tab? Download a CSV first if you want to keep them.")) return;
  audience.clear();
  invalidateDownloadStatus();
  $("subscriber-dialog").close();
  $("subscriber-details").replaceChildren();
  $("details-title").textContent = "Subscriber details";
  resetFilters();
  renderCollection();
  setStatus("Collection cleared", "All imported subscriber data has been removed from this tab.");
});
function resetFilters() {
  clearTimeout(searchTimer);
  browsing.query = browsing.source = "";
  browsing.page = 1;
  $("table-search").value = $("browse-source").value = "";
  renderTable();
}
$("reset-filters").addEventListener("click", resetFilters);
$("table-search").addEventListener("input", () => {
  browsing.query = $("table-search").value;
  browsing.page = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderTable, 150);
});
$("browse-source").addEventListener("change", () => { browsing.source = $("browse-source").value; browsing.page = 1; renderTable(); });
$("page-size").addEventListener("change", () => { browsing.pageSize = Number($("page-size").value); browsing.page = 1; renderTable(); });
for (const th of document.querySelectorAll("th[data-sort]")) {
  th.querySelector("button").addEventListener("click", () => {
    browsing.direction = browsing.sort === th.dataset.sort && browsing.direction === "asc" ? "desc" : "asc";
    browsing.sort = th.dataset.sort;
    browsing.page = 1;
    renderTable();
  });
}
$("first-page").addEventListener("click", () => { browsing.page = 1; renderTable(); });
$("previous-page").addEventListener("click", () => { browsing.page--; renderTable(); });
$("next-page").addEventListener("click", () => { browsing.page++; renderTable(); });
$("last-page").addEventListener("click", () => { browsing.page = Number.MAX_SAFE_INTEGER; renderTable(); });
$("close-details").addEventListener("click", () => $("subscriber-dialog").close());
window.addEventListener("beforeunload", (event) => {
  if (busy || csvDownloads.busy || (audience.size && savedRevision !== audience.revision)) { event.preventDefault(); event.returnValue = ""; }
});
renderCollection();
refreshTabs().catch((error) => setStatus("Couldn’t start", error.message, "error"));
