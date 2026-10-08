export const PAGE_SIZE = 100;

export function platformForUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (["www.patreon.com", "patreon.com"].includes(url.hostname)) return "patreon";
    if (url.hostname === "boosty.to") return "boosty";
  } catch { /* Invalid or browser-internal URL. */ }
  return null;
}

export function validateCreator(platform, value) {
  const creator = String(value ?? "").trim();
  const valid = platform === "patreon" ? /^\d+$/.test(creator) : /^[\w.-]+$/.test(creator) && ![".", ".."].includes(creator);
  if (!valid || creator.length > 100) throw new Error(platform === "patreon"
    ? "Enter the numeric Patreon campaign ID, or open Audience and reconnect."
    : "Enter your Boosty blog name (the part after boosty.to/).");
  return creator;
}

export function isMemberUrl(url) {
  return platformForUrl(url.href) === "patreon" &&
    /^\/api\/(?:members|campaigns\/\d+\/members)\/?$/.test(url.pathname);
}

export function memberRequest({ origin, creator, observedUrl, scope = "all" }) {
  validateCreator("patreon", creator);
  if (scope === "current" && !observedUrl) throw new Error("Current Audience filters could not be verified. Refresh the Patreon Audience page, wait for its list to load, and reconnect.");
  const url = observedUrl ? new URL(observedUrl) : new URL("/api/members", origin);
  if (url.origin !== origin || !isMemberUrl(url)) throw new Error("Unexpected Patreon member endpoint. Reopen Audience and reconnect.");
  // Reuse the website's fields/includes when available; do not guess additional
  // fields that could cause a 400 on an internal API version.
  if (!observedUrl) {
    url.searchParams.set("include", "user,currently_entitled_tiers,pledge");
    url.searchParams.set("fields[member]", "email,full_name,patron_status,pledge_amount_cents,pledge_relationship_start,campaign_lifetime_support_cents,last_charge_date,last_charge_status");
    url.searchParams.set("fields[user]", "full_name,url");
    url.searchParams.set("fields[tier]", "title");
    url.searchParams.set("fields[pledge]", "amount_cents,currency");
  }
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("page[") || (scope === "all" && (key.startsWith("filter[") || ["query", "search"].includes(key)))) url.searchParams.delete(key);
  }
  if (url.pathname.includes("/campaigns/")) url.pathname = `/api/campaigns/${creator}/members`;
  else url.searchParams.set("filter[campaign_id]", creator);
  url.searchParams.set("page[count]", String(PAGE_SIZE));
  url.searchParams.set("page[offset]", "0");
  return url;
}

export function boostyRequest(creator, offset = 0) {
  validateCreator("boosty", creator);
  const url = new URL(`https://api.boosty.to/v1/blog/${encodeURIComponent(creator)}/subscribers`);
  url.search = new URLSearchParams({ sort_by: "on_time", order: "gt", offset: String(offset), limit: String(PAGE_SIZE) });
  return url;
}

export function dateValue(value) {
  if (value == null || value === "" || value === 0) return "";
  const date = new Date(typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function numberValue(value, divisor = 1) {
  return value == null || value === "" || !Number.isFinite(Number(value)) ? "" : Number(value) / divisor;
}

export function normalizePatreon(payload, creator, currency = "") {
  if (!Array.isArray(payload?.data) || (payload.included != null && !Array.isArray(payload.included))) {
    throw new Error("Patreon returned an unfamiliar member list. No subscribers were added.");
  }
  const resources = new Map((payload.included ?? []).map((item) => [`${item.type}:${item.id}`, item]));
  const resolve = (ref) => ref && resources.get(`${ref.type}:${ref.id}`);
  return payload.data.map((member) => {
    if (member?.type !== "member" || !member.id || !member.attributes) throw new Error("Patreon returned an unfamiliar member record. No subscribers were added.");
    const a = member.attributes;
    const rel = member.relationships ?? {};
    const userRef = rel.user?.data;
    const user = resolve(userRef)?.attributes ?? {};
    const pledge = resolve(rel.pledge?.data)?.attributes ?? {};
    const tiers = rel.currently_entitled_tiers?.data ?? [];
    return {
      platform: "patreon", creator, subscriber_id: String(member.id), user_id: userRef?.id ?? "",
      name: Object.hasOwn(a, "full_name") ? a.full_name ?? "" : user.full_name ?? "", email: a.email ?? "", status: a.patron_status ?? "",
      tier: tiers.map((ref) => resolve(ref)?.attributes?.title).filter(Boolean).join(" | "),
      amount: numberValue(a.currently_entitled_amount_cents ?? a.pledge_amount_cents ?? pledge.amount_cents, 100),
      currency: a.currency ?? pledge.currency ?? currency,
      lifetime_amount: numberValue(a.campaign_lifetime_support_cents ?? a.lifetime_support_cents, 100),
      joined_at: dateValue(a.pledge_relationship_start), last_payment_at: dateValue(a.last_charge_date),
      last_payment_status: a.last_charge_status ?? "", next_payment_at: dateValue(a.next_charge_date),
      ended_at: "", profile_url: user.url ?? "",
    };
  });
}

export function normalizeBoosty(payload, creator, currency = "") {
  if (!Array.isArray(payload?.data)) throw new Error("Boosty returned an unfamiliar subscriber list. No subscribers were added.");
  return payload.data.map((s) => {
    if (s?.id == null || typeof s !== "object") throw new Error("Boosty returned an unfamiliar subscriber record. No subscribers were added.");
    return {
      platform: "boosty", creator, subscriber_id: String(s.id), user_id: String(s.id),
      name: s.name ?? "", email: s.email ?? "",
      status: s.status ?? (s.subscribed === true ? "active" : s.subscribed === false ? "inactive" : ""),
      tier: s.level?.name ?? "", amount: numberValue(s.price ?? s.level?.price),
      currency: s.currency ?? currency, lifetime_amount: numberValue(s.payments),
      joined_at: dateValue(s.onTime), last_payment_at: "", last_payment_status: "",
      next_payment_at: dateValue(s.nextPayTime), ended_at: dateValue(s.offTime), profile_url: "",
    };
  });
}

export function totalFor(platform, payload) {
  const value = platform === "patreon" ? payload.meta?.pagination?.total : payload.total;
  return value != null && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

export function nextPage(platform, payload, currentUrl, received) {
  const current = new URL(currentUrl);
  if (platform === "patreon") {
    const next = payload.links?.next;
    if (next) {
      const url = new URL(typeof next === "string" ? next : next.href, current);
      if (!isMemberUrl(url) || url.origin !== current.origin || url.pathname !== current.pathname ||
          url.searchParams.get("filter[campaign_id]") !== current.searchParams.get("filter[campaign_id]") || url.username || url.password) {
        throw new Error("Patreon returned an unexpected pagination link. Import stopped.");
      }
      return url;
    }
    const cursor = payload.meta?.pagination?.cursors?.next;
    if (cursor != null && cursor !== "") {
      current.searchParams.delete("page[offset]");
      current.searchParams.set("page[cursor]", String(cursor));
      return current;
    }
    const total = totalFor(platform, payload);
    // With a known total, an early end is a failure, never a successful partial import.
    if (total != null && received < total && payload.data.length === 0) throw new Error("Patreon stopped returning members before its reported total. Please retry.");
    if (current.searchParams.has("page[cursor]")) {
      if (total != null && received < total) throw new Error("Patreon's next-page cursor is missing before the reported total.");
      return null;
    }
    const explicitlyFinished = (payload.links && Object.hasOwn(payload.links, "next") && !payload.links.next) ||
      (payload.meta?.pagination?.cursors && Object.hasOwn(payload.meta.pagination.cursors, "next") && !cursor);
    // An endpoint may cap page size below what we request. A short page alone
    // is not evidence of completion when there is no total or terminal marker.
    if (total != null ? received >= total : payload.data.length === 0 || explicitlyFinished) return null;
    current.searchParams.set("page[offset]", String(Number(current.searchParams.get("page[offset]") || 0) + payload.data.length));
    return current;
  }
  const total = totalFor(platform, payload);
  if (total != null && received < total && payload.data.length === 0) throw new Error("Boosty stopped returning subscribers before its reported total. Please retry.");
  if (total != null ? received >= total : payload.data.length === 0) return null;
  // The website paginates by offset = page index * limit, not the response's
  // offset field (which has varied across versions).
  current.searchParams.set("offset", String(Number(current.searchParams.get("offset") || 0) + payload.data.length));
  return current;
}
