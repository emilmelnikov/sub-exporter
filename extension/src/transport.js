// These functions are serialized by chrome.scripting. Keep them self-contained
// and run in the ISOLATED world: site scripts must not see session credentials.
export function inspectPage() {
  const origin = location.origin;
  const platform = ["www.patreon.com", "patreon.com"].includes(location.hostname) ? "patreon"
    : location.hostname === "boosty.to" ? "boosty" : null;
  if (location.protocol !== "https:" || !platform) throw new Error("Open a Patreon or Boosty creator page first.");
  let observedUrl = "";
  if (platform === "patreon") {
    try {
      const url = new URL(globalThis.__subtablePatreonAudience?.read());
      if (url.origin === origin && !url.username && !url.password && /^\/api\/(?:members|campaigns\/\d+\/members)\/?$/.test(url.pathname)) observedUrl = url.href;
    } catch { /* Refresh the page to start observing before its Audience loads. */ }
  }
  let creator = "";
  if (observedUrl) {
    const url = new URL(observedUrl);
    creator = url.searchParams.get("filter[campaign_id]") || url.pathname.match(/campaigns\/(\d+)/)?.[1] || "";
  } else if (platform === "boosty") {
    const slug = location.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!new Set(["app", "settings", "feed", "search", "login", "catalog"]).has(slug)) creator = slug;
  }
  return { platform, origin, creator, observedUrl };
}

export async function pageRequest({ url: value, expectedOrigin, requestId, currency = "" }) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (location.origin !== expectedOrigin) return fail("NAVIGATED", "The source tab changed. Reconnect to your creator page.");
  let url;
  try { url = new URL(value); } catch { return fail("URL", "Invalid platform request."); }
  const patreon = ["https://www.patreon.com", "https://patreon.com"].includes(expectedOrigin);
  const boosty = expectedOrigin === "https://boosty.to";
  const allowed = url.protocol === "https:" && !url.username && !url.password && (
    (patreon && url.origin === expectedOrigin && /^\/api\/(?:current_user|members|campaigns\/\d+\/members)\/?$/.test(url.pathname)) ||
    (boosty && url.origin === "https://api.boosty.to" && /^\/v1\/(?:user\/current|blog\/[\w.-]+\/subscribers)\/?$/.test(url.pathname))
  );
  if (!allowed) return fail("URL", "This request is outside the subscriber import endpoints.");
  const headers = { Accept: "application/json" };
  if (boosty) {
    // Read only Boosty's named session values; never copy credentials to the
    // extension, logs, storage, downloads, or another host.
    let token = "";
    let cookie = "";
    try { cookie = document.cookie.split("; ").find((part) => part.startsWith("auth="))?.slice(5) ?? ""; } catch { /* Try named local storage below. */ }
    const candidates = [cookie];
    for (const key of ["auth", "token"]) {
      try { candidates.push(localStorage.getItem(key)); } catch { /* Storage may be disabled. */ }
    }
    for (const raw of candidates) {
      if (!raw) continue;
      try {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = JSON.parse(decodeURIComponent(raw)); }
        if (typeof parsed === "string") parsed = JSON.parse(parsed);
        const candidate = parsed?.accessToken ?? parsed?.access_token;
        if (typeof candidate === "string" && candidate.length && !/[\r\n]/.test(candidate)) { token = candidate; break; }
      } catch { /* Ignore malformed or obsolete session entries. */ }
    }
    if (!token) return fail("AUTH", "Sign in to Boosty in this tab, refresh the page, and reconnect.");
    headers.Authorization = `Bearer ${token}`;
    if (/^[A-Z]{3}$/.test(currency)) headers["X-Currency"] = currency;
  }
  const controller = new AbortController();
  // A page-visible bridge is deliberately unnecessary. This map lives only in
  // this extension's isolated execution world and contains no subscriber data.
  const pending = globalThis.__subtablePending ??= new Map();
  pending.set(requestId, controller);
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url.href, {
      method: "GET", credentials: "include", headers, signal: controller.signal,
      cache: "no-store", redirect: "error",
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      let retryAfter = response.headers.get("retry-after");
      if (response.status === 429 && contentType.includes("json")) {
        try {
          const body = await response.json();
          retryAfter ??= body.errors?.[0]?.retry_after_seconds?.toString();
        } catch { /* Header/default backoff remains available. */ }
      }
      return { ok: false, code: "HTTP", status: response.status, retryAfter };
    }
    if (!contentType.includes("json")) return fail("FORMAT", "The platform returned a login or verification page. Open the source tab, complete it, and retry.");
    const text = await response.text();
    if (text.length > 20 * 1024 * 1024) return fail("SIZE", "The platform response is too large to import safely.");
    const data = JSON.parse(text);
    if (data?.errors?.length || data?.error) return fail("API", "The platform rejected the request. Check your creator access and reconnect.");
    return { ok: true, data };
  } catch (error) {
    return fail(error.name === "AbortError" ? "ABORT" : "NETWORK",
      error.name === "AbortError" ? "The request was cancelled or timed out. Please retry."
        : "Could not read the platform response. Check the source tab, your connection, and sign-in, then retry.");
  } finally {
    clearTimeout(timeout);
    pending.delete(requestId);
  }
}

export function cancelPageRequest(requestId) {
  globalThis.__subtablePending?.get(requestId)?.abort();
}

export function abortError() { return new DOMException("Import cancelled. No subscribers were added.", "AbortError"); }

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export function retryDelay(value, attempt, now = Date.now()) {
  if (value != null && value !== "") {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 1000 * 2 ** attempt;
}

export function responseError(response) {
  if (response.message) return new Error(response.message);
  if (response.status === 401) return new Error("Your session has expired. Sign in again in the source tab and reconnect.");
  if (response.status === 403) return new Error("Access denied. Use the creator account that owns this audience and complete any verification in the source tab.");
  if ([400, 404, 422].includes(response.status)) return new Error("The subscriber request was rejected. Open your Audience / Subscribers page, refresh it, and reconnect. The platform may have changed its internal API.");
  if (response.status === 429) return new Error("The platform is rate limiting requests. Wait before trying again.");
  return new Error(`The platform could not complete the request (HTTP ${response.status ?? "unknown"}). Please retry later.`);
}

export function createTransport(context, { signal, onRetry = () => {} } = {}) {
  return async (url) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      const requestId = crypto.randomUUID();
      const target = { tabId: context.tabId, documentIds: [context.documentId] };
      const cancel = () => {
        chrome.scripting.executeScript({ target, world: "ISOLATED", func: cancelPageRequest, args: [requestId] }).catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      let response;
      try {
        const results = await chrome.scripting.executeScript({
          target, world: "ISOLATED", func: pageRequest,
          args: [{ url: String(url), expectedOrigin: context.origin, requestId, currency: context.currency ?? "" }],
        });
        response = results[0]?.result;
      } catch {
        signal?.throwIfAborted();
        throw new Error("The source tab closed, navigated, or lost extension access. Open the creator page and reconnect.");
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      signal?.throwIfAborted();
      if (!response) throw new Error("The source page could not be read. Refresh it and reconnect.");
      if (response.ok) return response.data;
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
        const ms = Math.max(500, retryDelay(response.retryAfter, attempt));
        if (ms > 30000) throw new Error(`The platform asked to wait ${Math.ceil(ms / 1000)} seconds. Retry after that interval.`);
        onRetry(Math.ceil(ms / 1000));
        await delay(ms, signal);
      } else throw responseError(response);
    }
  };
}
