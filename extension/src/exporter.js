import { memberRequest, boostyRequest, normalizePatreon, normalizeBoosty, totalFor, nextPage } from "./platforms.js";
import { delay } from "./transport.js";

export async function collectSubscribers(context, { request, signal, onProgress = () => {}, pause = delay }) {
  const rows = new Map();
  const visited = new Set();
  let url = context.platform === "patreon" ? memberRequest(context) : boostyRequest(context.creator);
  let page = 0;
  let expectedTotal = null;
  while (url) {
    signal?.throwIfAborted();
    if (page >= 10000 || rows.size >= 1000000) throw new Error("Import limit reached. Narrow the audience selection and try again.");
    if (visited.has(url.href)) throw new Error("The platform repeated a pagination link. Import stopped to avoid adding incomplete data.");
    visited.add(url.href);
    const payload = await request(url);
    signal?.throwIfAborted();
    const pageRows = context.platform === "patreon"
      ? normalizePatreon(payload, context.creator, context.currency)
      : normalizeBoosty(payload, context.creator, context.currency);
    const before = rows.size;
    for (const row of pageRows) rows.set(row.subscriber_id, row);
    const total = totalFor(context.platform, payload);
    if (total != null) {
      if (expectedTotal != null && total !== expectedTotal) throw new Error("Your audience changed during import. Please run it again for consistent data.");
      expectedTotal = total;
    }
    page++;
    onProgress({ count: rows.size, total: expectedTotal, page });
    if (pageRows.length && rows.size === before) throw new Error("The platform repeated a page of subscribers. Import stopped; please retry.");
    url = nextPage(context.platform, payload, url, rows.size);
    if (url) await pause(350, signal);
  }
  if (expectedTotal != null && rows.size !== expectedTotal) throw new Error("The imported count does not match the platform total. Please retry; no subscribers were added.");
  signal?.throwIfAborted();
  return [...rows.values()];
}
