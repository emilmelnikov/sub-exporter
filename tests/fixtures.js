// Synthetic fixtures, based on the platforms' JSON response structures.
export const patreonPage = (id = "member-1", { next = null, total = 1 } = {}) => ({
  data: [{ type: "member", id, attributes: {
    email: "reader@example.test", patron_status: "active_patron", currently_entitled_amount_cents: 1234,
    campaign_lifetime_support_cents: 2468, pledge_relationship_start: "2025-01-01T00:00:00Z",
  }, relationships: { user: { data: { type: "user", id: "u-1" } },
    currently_entitled_tiers: { data: [{ type: "tier", id: "t-1" }] },
    pledge: { data: { type: "pledge", id: "p-1" } },
  } }],
  included: [
    { type: "user", id: "u-1", attributes: { full_name: "Zoë, Reader", url: "https://www.patreon.com/user?u=1" } },
    { type: "tier", id: "t-1", attributes: { title: "Studio \"Plus\"" } },
    { type: "pledge", id: "p-1", attributes: { currency: "EUR" } },
  ], meta: { pagination: { total, cursors: { next } } },
});

export const boostyPage = (ids = [1], total = ids.length) => ({ data: ids.map((id) => ({
  id, name: "Читатель", email: "reader@example.test", status: "active", subscribed: true,
  level: { id: 5, name: "За кулисами", price: 300 }, price: 250, payments: 1500,
  onTime: 1735689600, offTime: null, nextPayTime: 1738368000,
})), total, offset: 999, limit: 100 });
