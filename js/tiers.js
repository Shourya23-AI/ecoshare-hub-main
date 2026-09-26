import { db, TIERS } from "./firebase-config.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Returns the highest tier a donation count qualifies for, or null if the
// count hasn't reached the first tier yet. TIERS is ordered lowest first,
// so we walk it and keep the last one whose threshold is met.
export function getCurrentTier(count) {
  let current = null;
  for (const tier of TIERS) {
    if (count >= tier.threshold) current = tier;
  }
  return current;
}

// The next locked tier above the current count, or null if every tier
// (including the top one, Diamond) has already been unlocked.
export function getNextTier(count) {
  return TIERS.find((tier) => count < tier.threshold) || null;
}

// Full progress snapshot used to render the "My Impact" tier card and the
// nav pill: current tier, next tier, and how far along the user is between
// them as a 0-100 percentage.
export function getTierProgress(count) {
  const current = getCurrentTier(count);
  const next = getNextTier(count);

  if (!next) {
    // Already at the top tier (Diamond) — show a full bar.
    return { current, next: null, progressPct: 100, remaining: 0 };
  }

  const base = current ? current.threshold : 0;
  const span = next.threshold - base;
  const progressPct = span > 0 ? Math.min(100, Math.round(((count - base) / span) * 100)) : 0;

  return { current, next, progressPct, remaining: Math.max(0, next.threshold - count) };
}

// All tiers the user has unlocked so far, in order.
export function getUnlockedTiers(count) {
  return TIERS.filter((tier) => count >= tier.threshold);
}

// Updates (or hides) the small nav-tier-pill badge shown in the top nav.
export function renderNavTierPill(count) {
  const pill = document.getElementById("nav-tier-pill");
  if (!pill) return;

  const current = getCurrentTier(count);
  if (!current) {
    pill.style.display = "none";
    return;
  }

  pill.className = `badge ${current.badgeClass}`;
  pill.textContent = `${current.icon} ${current.name} Helper`;
  pill.style.display = "inline-flex";
}

// Numeric rank used to sort listings and cards highest-rank-first, and to
// pick a background/style for a poster's rank. "None" (no tier unlocked
// yet) always sorts last and gets the plain white card.
const RANK_ORDER = { Diamond: 5, Platinum: 4, Gold: 3, Silver: 2, Bronze: 1 };

export function tierRank(tierName) {
  return RANK_ORDER[tierName] || 0;
}

// Tiers that get first dibs on a freshly-posted item (see priorityUntil on
// items in main.js / firestore.rules).
const PRIORITY_TIERS = new Set(["Gold", "Platinum", "Diamond"]);
export function isPriorityTier(tierName) {
  return PRIORITY_TIERS.has(tierName);
}

// Persists the plain tier NAME (e.g. "Gold") on users/{uid}.tier — kept in
// sync any time itemsShared changes (posting an item, or an admin editing
// someone's stats) so both the UI *and* firestore.rules (which can't run
// getCurrentTier() itself) can cheaply check "is this user Gold+?" without
// re-deriving it from itemsShared every time. Best-effort: a failure here
// shouldn't block whatever action triggered it.
export async function syncUserTierField(uid, itemsShared) {
  if (!uid) return null;
  const current = getCurrentTier(itemsShared);
  try {
    await updateDoc(doc(db, "users", uid), { tier: current ? current.name : null });
  } catch (e) {
    console.warn("Failed to sync tier field:", e);
  }
  return current ? current.name : null;
}

// Renders (or re-renders) the clickable profile button in the top-right
// nav: an avatar initial + current tier icon that opens a small dropdown
// showing the display name, current tier, and every medal unlocked so far
// (from users/{uid}.unlockedTiers — this is deliberately NOT the same
// thing as "current tier": a Diamond helper still holds their Bronze
// through Platinum medals too, so all of them are listed). Clicking
// outside closes it; clicking it again toggles it.
export function renderNavProfileButton({ name, itemsShared, unlockedTiers }) {
  const slot = document.getElementById("nav-profile-slot");
  if (!slot) return;

  const current = getCurrentTier(itemsShared);
  const displayName = name || "Neighbor";
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";
  const unlocked = Array.isArray(unlockedTiers) ? unlockedTiers : [];

  const medalsHtml = unlocked.length
    ? TIERS.filter((t) => unlocked.includes(t.name))
        .map((t) => `<span class="badge ${t.badgeClass}" title="${t.name}">${t.icon} ${t.name}</span>`)
        .join("")
    : `<div class="nav-profile-medal-empty">No medals unlocked yet — share an item to start earning them!</div>`;

  slot.style.display = "block";
  slot.innerHTML = `
    <div class="nav-profile">
      <button type="button" id="nav-profile-btn" class="nav-profile-btn" aria-haspopup="true" aria-expanded="false">
        <span class="nav-profile-avatar">${escapeHtmlForProfile(initial)}</span>
        ${current ? `<span class="nav-profile-tier-icon" title="${current.name}">${current.icon}</span>` : ""}
        <span class="nav-profile-caret">▾</span>
      </button>
      <div id="nav-profile-dropdown" class="nav-profile-dropdown" style="display:none;">
        <div class="nav-profile-dropdown-name">${escapeHtmlForProfile(displayName)}</div>
        <div class="nav-profile-dropdown-tier">${current ? `${current.icon} ${current.name} Helper` : "Unranked — no tier yet"}</div>
        <div class="nav-profile-medals">${medalsHtml}</div>
        <a class="nav-profile-dropdown-link" href="impact.html">View full impact →</a>
      </div>
    </div>
  `;

  const btn = document.getElementById("nav-profile-btn");
  const dropdown = document.getElementById("nav-profile-dropdown");
  if (!btn || !dropdown) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = dropdown.style.display !== "none";
    dropdown.style.display = isOpen ? "none" : "block";
    btn.setAttribute("aria-expanded", String(!isOpen));
  });

  // Close on any click elsewhere — only wire this up once per render since
  // the whole button+dropdown DOM gets replaced each render anyway.
  document.addEventListener("click", (e) => {
    if (!slot.contains(e.target)) dropdown.style.display = "none";
  });
}

// Tiny local escaper — tiers.js doesn't otherwise touch untrusted strings,
// but a user-set display name is untrusted the same way item titles are.
function escapeHtmlForProfile(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export { TIERS };
