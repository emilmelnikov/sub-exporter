export const COLUMNS = [
  "platform", "creator", "subscriber_id", "user_id", "name", "email",
  "status", "tier", "amount", "currency", "lifetime_amount", "joined_at",
  "last_payment_at", "last_payment_status", "next_payment_at", "ended_at", "profile_url",
];

export function csvCell(value) {
  let text = value == null ? "" : String(value);
  // Quoting alone does not prevent spreadsheet formula execution. Also catch
  // leading whitespace/control characters and full-width formula markers.
  if (/^[\s\u0000-\u001f]*[=+\-@＝＋－＠]/u.test(text) || /^[\t\r\n]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(rows, { delimiter = ",", bom = true } = {}) {
  if (![",", ";"].includes(delimiter)) throw new Error("Unsupported CSV separator.");
  return (bom ? "\uFEFF" : "") + [
    COLUMNS.map(csvCell).join(delimiter),
    ...rows.map((row) => COLUMNS.map((key) => csvCell(row[key])).join(delimiter)),
  ].join("\r\n") + "\r\n";
}

export function csvFilename(platform, creator, date = new Date()) {
  const safe = String(creator).normalize("NFKC").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64) || "creator";
  return `${platform}-${safe}-subscribers-${date.toISOString().replace(/[:.]/g, "-")}.csv`;
}
