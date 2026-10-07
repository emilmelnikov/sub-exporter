// Run in this extension's isolated world from document_start. Live observer
// delivery continues after the page's resource timing history fills up. Keep
// only one request URL, without reading responses or changing the site's buffer.
(() => {
  if (globalThis.__subtablePatreonAudience) return;
  let latest = null;
  const capture = (entries) => {
    for (const entry of entries) {
      try {
        const url = new URL(entry.name);
        if (url.origin !== location.origin || url.username || url.password ||
            !/^\/api\/(?:members|campaigns\/\d+\/members)\/?$/.test(url.pathname)) continue;
        // A slower, older request may complete after the current selection.
        if (!latest || entry.startTime >= latest.startTime) latest = { url: url.href, startTime: entry.startTime };
      } catch { /* Ignore unrelated resource names. */ }
    }
  };
  try {
    const observer = new PerformanceObserver((list) => capture(list.getEntries()));
    // Do not import historical entries: they may already be stale or truncated.
    observer.observe({ type: "resource" });
    globalThis.__subtablePatreonAudience = {
      read() {
        // Connecting may happen before the observer's callback is delivered.
        capture(observer.takeRecords());
        return latest?.url ?? "";
      },
    };
  } catch { /* Filtered export stays disabled when observation is unavailable. */ }
})();
