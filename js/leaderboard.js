import { db } from "./firebase-config.js";
import { collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getCurrentTier } from "./tiers.js";

// See main.js for the full rationale — helper display names are
// user-controlled and get interpolated into innerHTML below.
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

document.addEventListener("DOMContentLoaded", async () => {
  const leaderboardListEl = document.getElementById("leaderboard-list");
  if (!leaderboardListEl) return;

  try {
    // Rank directly off users.itemsShared (the same live "donations" count
    // that drives medals on My Impact), sorted numerically descending by
    // Firestore itself — this is what makes Platinum/Diamond helpers sort
    // above lower tiers correctly, instead of the old items-collection
    // aggregation that could mis-group or mis-order people.
    const usersQuery = query(collection(db, "users"), orderBy("itemsShared", "desc"));
    const usersSnapshot = await getDocs(usersQuery);

    const helpers = [];
    usersSnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const itemsShared = data.itemsShared || 0;
      if (itemsShared <= 0) return; // keep the board focused on active helpers
      helpers.push({
        name: data.name || (data.email || "Neighbor").split("@")[0],
        itemsShared,
        itemsClaimed: data.itemsClaimed || 0,
      });
    });

    // Community summary stats
    const itemsSnapshot = await getDocs(collection(db, "items"));
    const totalItems = itemsSnapshot.size;
    const totalWasteKg = totalItems * 2.5;

    let certificatesCount = 0;
    try {
      const certsSnapshot = await getDocs(collection(db, "certificates"));
      certificatesCount = certsSnapshot.size;
    } catch (e) {
      certificatesCount = 0;
    }

    const leadItemsEl = document.getElementById("lead-stat-items");
    const leadWasteEl = document.getElementById("lead-stat-waste");
    const leadMembersEl = document.getElementById("lead-stat-members");
    const leadCertsEl = document.getElementById("lead-stat-certs");

    if (leadItemsEl) leadItemsEl.innerText = totalItems;
    if (leadWasteEl) leadWasteEl.innerText = `${Math.round(totalWasteKg)} kg`;
    if (leadMembersEl) leadMembersEl.innerText = helpers.length;
    if (leadCertsEl) leadCertsEl.innerText = certificatesCount;

    if (helpers.length === 0) {
      leaderboardListEl.innerHTML = `<p style="text-align: center; color: #6b7280; padding: 20px;">No ranking data available yet. Start sharing items to top the leaderboard!</p>`;
      return;
    }

    // Firestore already sorted by itemsShared desc; ties keep their
    // original (stable) order.
    let html = `
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div style="display: grid; grid-template-columns: 60px 1fr 120px 120px; font-weight: 600; font-size: 13px; color: #6b7280; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;">
          <span>Rank</span>
          <span>Helper</span>
          <span>Medal</span>
          <span style="text-align: right;">Items Shared</span>
        </div>
    `;

    helpers.forEach((helper, index) => {
      const rank = index + 1;
      let badgeColor = "#f3f4f6";
      let textColor = "#374151";

      if (rank === 1) { badgeColor = "#fef3c7"; textColor = "#b45309"; }
      else if (rank === 2) { badgeColor = "#f1f5f9"; textColor = "#475569"; }
      else if (rank === 3) { badgeColor = "#ffedd5"; textColor = "#c2410c"; }

      const tier = getCurrentTier(helper.itemsShared);
      const medalHtml = tier
        ? `<span class="badge ${tier.badgeClass}">${tier.icon} ${tier.name}</span>`
        : `<span style="font-size:12px; color:#9ca3af;">Unranked</span>`;

      html += `
        <div style="display: grid; grid-template-columns: 60px 1fr 120px 120px; align-items: center; padding: 10px 0; border-bottom: 1px solid #f9fafb;">
          <div style="display: flex; align-items: center;">
            <span style="background: ${badgeColor}; color: ${textColor}; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px;">
              ${rank}
            </span>
          </div>
          <div style="font-weight: 600; color: #111827; font-size: 14px;">
            ${escapeHtml(helper.name)} ${rank === 1 ? '👑' : ''}
          </div>
          <div>${medalHtml}</div>
          <div style="text-align: right; font-weight: 700; color: #166534; font-size: 14px;">
            ${helper.itemsShared} items
          </div>
        </div>
      `;
    });

    html += `</div>`;
    leaderboardListEl.innerHTML = html;

  } catch (err) {
    console.error("Error loading leaderboard:", err);
    leaderboardListEl.innerHTML = `<p style="color: #991b1b; text-align: center;">Failed to load leaderboard data.</p>`;
  }
});
