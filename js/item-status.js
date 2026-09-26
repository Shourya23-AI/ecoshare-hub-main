// Shared item-status helpers.
//
// Both the poster's own listing controls (main.js) and the admin dashboard
// listing view (admin.js) need to reverse a claim back to "unclaimed" in
// exactly the same way — restoring quantity and restarting the posting
// timer — so that logic lives here once instead of being duplicated (and
// risking drifting out of sync) in two files.

// Posting time limits: food listings expire fast, everything else gets a few days.
export const FOOD_POST_LIMIT_MS = 2 * 60 * 60 * 1000; // 2 hours
export const OTHER_POST_LIMIT_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

export function getPostLimitMs(category) {
  return (category || "").toLowerCase() === "food" ? FOOD_POST_LIMIT_MS : OTHER_POST_LIMIT_MS;
}

// A fresh expiration/availability timer, starting now.
export function getExpiryDate(category) {
  return new Date(Date.now() + getPostLimitMs(category));
}

// Gold/Platinum/Diamond members get first crack at a listing for this long
// after it goes live (or is reopened); after that it's first-come-first-
// served for everyone. See main.js (openClaimModal / claim handler) and
// firestore.rules (which enforces the same window server-side).
export const PRIORITY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export function getPriorityDeadline() {
  return new Date(Date.now() + PRIORITY_WINDOW_MS);
}

// Resolve an item's total quantity whether it uses the newer integer
// quantityTotal field or the legacy free-text "3 kg" string.
export function resolveQuantityTotal(item) {
  if (typeof item.quantityTotal === "number") {
    return Math.max(1, Math.round(item.quantityTotal));
  }
  const match = /^([\d.]+)\s*(.*)$/.exec((item.quantity || "").trim());
  return match ? Math.max(1, Math.round(parseFloat(match[1]))) : 1;
}

// Build the Firestore update payload that reverses a claim: every unit
// becomes available again, the listing re-opens, and its expiration timer
// restarts from right now — as if freshly posted. Used when a poster or
// admin flips a listing from "Claimed" back to "Unclaimed" because the
// claimer never showed up or backed out of the pickup.
export function buildUnclaimUpdate(item) {
  const quantityTotal = resolveQuantityTotal(item);
  return {
    status: "available",
    quantityTotal,
    quantityAvailable: quantityTotal,
    quantityUnit: item.quantityUnit || "units",
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
    // Timer Reset: give the reopened listing a brand-new expiration window
    // rather than leaving the old (possibly already-passed) one in place.
    expiresAt: getExpiryDate(item.category),
    // Reopening a listing also restarts its 15-minute Gold+/Platinum/Diamond
    // priority claim window, same as a brand-new post.
    priorityUntil: getPriorityDeadline()
  };
}

// Build the update payload for an admin force-closing a listing (marking it
// claimed without an actual claimer) — zero out availability but leave the
// timer alone, since the posting itself hasn't changed.
export function buildForceClaimUpdate(item) {
  return {
    status: "claimed",
    quantityAvailable: 0
  };
}
