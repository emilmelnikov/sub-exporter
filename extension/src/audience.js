import { COLUMNS } from "./csv.js";

export function sourceLabel(platform, creator) {
  return `${platform === "patreon" ? "Patreon" : "Boosty"} · ${creator}`;
}

// Imports commit only after collection succeeds. Replace individual row objects
// so a download snapshot stays unchanged while more sources are imported.
export class Audience {
  #rows = new Map();
  #sources = new Map();
  #revision = 0;
  constructor(limit = 1000000) { this.limit = limit; }
  get size() { return this.#rows.size; }
  get revision() { return this.#revision; }
  get hasImports() { return this.#sources.size > 0; }
  rows() { return [...this.#rows.values()]; }
  sources() { return [...this.#sources.values()].map((source) => ({ ...source })); }

  merge({ platform, creator }, rows) {
    if (!["patreon", "boosty"].includes(platform) || !creator) throw new Error("The import source is missing.");
    const source = sourceLabel(platform, creator);
    const sourceKey = JSON.stringify([platform, creator]);
    const staged = new Map();
    let added = 0;
    for (const row of rows) {
      if (row.subscriber_id == null || String(row.subscriber_id) === "") throw new Error("A subscriber has no ID. The existing table has been kept.");
      const key = JSON.stringify([platform, creator, String(row.subscriber_id)]);
      if (!staged.has(key) && !this.#rows.has(key)) added++;
      if (this.#rows.size + added > this.limit) throw new Error(`The combined table is limited to ${this.limit.toLocaleString()} rows. The existing table has been kept.`);
      staged.set(key, Object.freeze({ ...row, platform, creator, subscriber_id: String(row.subscriber_id), source }));
    }
    for (const [key, row] of staged) this.#rows.set(key, row);
    this.#sources.set(sourceKey, { label: source, count: (this.#sources.get(sourceKey)?.count ?? 0) + added });
    this.#revision++;
    return { added, updated: staged.size - added, source };
  }

  clear() {
    this.#rows.clear();
    this.#sources.clear();
    this.#revision++;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const numericColumns = new Set(["amount", "lifetime_amount"]);
export function browseRows(rows, { query = "", source = "", sort = "name", direction = "asc", page = 1, pageSize = 25 } = {}) {
  const term = query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => (!source || row.source === source) &&
    (!term || COLUMNS.some((key) => String(row[key] ?? "").toLocaleLowerCase().includes(term))));
  const key = COLUMNS.includes(sort) ? sort : "name";
  filtered.sort((a, b) => {
    const left = a[key], right = b[key];
    const missingLeft = left == null || left === "", missingRight = right == null || right === "";
    if (missingLeft || missingRight) return Number(missingLeft) - Number(missingRight);
    const compared = numericColumns.has(key) && Number.isFinite(Number(left)) && Number.isFinite(Number(right))
      ? Number(left) - Number(right) : collator.compare(String(left), String(right));
    return direction === "desc" ? -compared : compared;
  });
  const size = [25, 50, 100].includes(Number(pageSize)) ? Number(pageSize) : 25;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(pages, Math.max(1, Math.trunc(Number(page)) || 1));
  const offset = (current - 1) * size;
  return { rows: filtered.slice(offset, offset + size), total: filtered.length, page: current, pages,
    start: filtered.length ? offset + 1 : 0, end: Math.min(offset + size, filtered.length) };
}
