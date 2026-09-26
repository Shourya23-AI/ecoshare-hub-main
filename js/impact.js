import { auth, db, TIERS } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, collection, getDocs, query, where, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getCurrentTier, getTierProgress, renderNavTierPill, renderNavProfileButton } from "./tiers.js";
import { syncUnlockedCertificates, openCertificateViewer } from "./certificates.js";

const statItemsCount = document.getElementById("impact-items-count");
const statWasteCount = document.getElementById("impact-waste-count");
const statRank = document.getElementById("impact-rank");
const statTier = document.getElementById("impact-tier");

const progressFill = document.getElementById("impact-progress-fill");
const progressLabel = document.getElementById("impact-progress-label");
const progressCurrent = document.getElementById("impact-progress-current");
const progressNext = document.getElementById("impact-progress-next");

const certBanner = document.getElementById("impact-cert-banner");
const certTitle = document.getElementById("impact-cert-title");
const certDesc = document.getElementById("impact-cert-desc");
const certViewBtn = document.getElementById("impact-cert-view-btn");

const tierGrid = document.getElementById("impact-tier-grid");
const historyList = document.getElementById("impact-history-list");

onAuthStateChanged(auth, async (user) => {
  if (user) {
    await loadUserImpact(user);
  } else {
    showLoggedOutState();
  }
});

function showLoggedOutState() {
  if (statItemsCount) statItemsCount.textContent = "--";
  if (statWasteCount) statWasteCount.textContent = "--";
  if (statRank) statRank.textContent = "--";
  if (statTier) statTier.textContent = "Sign in";
  if (historyList) {
    historyList.innerHTML = `<p style="color:#6b7280;">Sign in to see your personal sharing history and medals.</p>`;
  }
  renderTierGrid(0);
}

async function loadUserImpact(user) {
  try {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    const userData = userSnap.exists() ? userSnap.data() : {};
    const itemsShared = userData.itemsShared || 0;
    const displayName = userData.name || user.displayName || (user.email || "").split("@")[0];

    // --- Top stat cards ---
    if (statItemsCount) statItemsCount.textContent = itemsShared;
    if (statWasteCount) statWasteCount.textContent = `${(itemsShared * 2.5).toFixed(1)} kg`;

    const tier = getCurrentTier(itemsShared);
    if (statTier) statTier.textContent = tier ? `${tier.icon} ${tier.name}` : "Getting started";

    renderNavTierPill(itemsShared);

    // --- Community rank ---
    const rank = await getCommunityRank(user.uid, itemsShared);
    if (statRank) statRank.textContent = rank ? `#${rank}` : "--";

    // --- Progress bar toward next medal ---
    renderProgress(itemsShared);

    // --- Unlock any certificates newly earned, then show the top one ---
    const unlocked = await syncUnlockedCertificates(user.uid, displayName, itemsShared);
    renderNavProfileButton({
      name: displayName,
      itemsShared,
      unlockedTiers: userData.unlockedTiers || unlocked.map((t) => t.name),
    });
    renderCertBanner(unlocked, displayName);

    // --- Full tier grid ---
    renderTierGrid(itemsShared);

    // --- Recent contribution history ---
    await renderHistory(user.uid);
  } catch (e) {
    console.error("Error loading user impact:", e);
    if (historyList) {
      historyList.innerHTML = `<p style="color:#dc2626;">Couldn't load your impact right now. Please refresh.</p>`;
    }
  }
}

// Ranks the user among everyone else by itemsShared (ties share a rank).
async function getCommunityRank(uid, myCount) {
  try {
    const snapshot = await getDocs(collection(db, "users"));
    let higherCount = 0;
    snapshot.forEach((docSnap) => {
      if (docSnap.id === uid) return;
      const shared = docSnap.data().itemsShared || 0;
      if (shared > myCount) higherCount++;
    });
    return higherCount + 1;
  } catch (e) {
    console.error("Error computing rank:", e);
    return null;
  }
}

function renderProgress(itemsShared) {
  const { current, next, progressPct, remaining } = getTierProgress(itemsShared);

  if (progressFill) progressFill.style.width = `${progressPct}%`;
  if (progressCurrent) {
    progressCurrent.textContent = current
      ? `${current.icon} ${current.name} — ${itemsShared} donations`
      : `${itemsShared} donations`;
  }
  if (next) {
    if (progressNext) progressNext.textContent = `${next.icon} ${next.name} at ${next.threshold}`;
    if (progressLabel) progressLabel.textContent = `${remaining} more to go`;
  } else {
    if (progressNext) progressNext.textContent = "Top tier reached! 💠";
    if (progressLabel) progressLabel.textContent = "All medals unlocked";
  }
}

function renderCertBanner(unlockedTiers, displayName) {
  if (!certBanner) return;
  if (!unlockedTiers || unlockedTiers.length === 0) {
    certBanner.style.display = "none";
    return;
  }
  const top = unlockedTiers[unlockedTiers.length - 1];
  certBanner.style.display = "flex";
  if (certTitle) certTitle.textContent = `${top.icon} ${top.name} Helper Certificate`;
  if (certDesc) certDesc.textContent = `You've shared ${top.threshold}+ items — download or view your certificate of help.`;
  if (certViewBtn) {
    certViewBtn.onclick = () => openCertificateViewer({
      userName: displayName,
      tierName: top.name,
      icon: top.icon,
      threshold: top.threshold,
    });
  }
}

function renderTierGrid(itemsShared) {
  if (!tierGrid) return;
  const displayName = auth.currentUser
    ? (auth.currentUser.displayName || (auth.currentUser.email || "").split("@")[0])
    : "EcoShare Helper";

  tierGrid.innerHTML = "";
  TIERS.forEach((tier) => {
    const unlocked = itemsShared >= tier.threshold;
    const isCurrent = getCurrentTier(itemsShared) === tier;

    const card = document.createElement("div");
    card.className = `tier-card${isCurrent ? " current" : ""}`;
    card.innerHTML = `
      <h4>${tier.icon} ${tier.name}</h4>
      <div class="req">${tier.threshold} donations</div>
      <ul>
        <li>${unlocked ? "✅ Unlocked" : "🔒 Locked"}</li>
      </ul>
    `;

    if (unlocked && auth.currentUser) {
      const btn = document.createElement("button");
      btn.className = "btn btn-outline btn-sm";
      btn.style.cssText = "margin-top:8px; width:100%;";
      btn.textContent = "View certificate";
      btn.addEventListener("click", () => openCertificateViewer({
        userName: displayName,
        tierName: tier.name,
        icon: tier.icon,
        threshold: tier.threshold,
      }));
      card.appendChild(btn);
    }

    tierGrid.appendChild(card);
  });
}

async function renderHistory(uid) {
  if (!historyList) return;
  try {
    let snapshot;
    try {
      const q = query(collection(db, "items"), where("userId", "==", uid), orderBy("createdAt", "desc"), limit(10));
      snapshot = await getDocs(q);
    } catch (indexErr) {
      // Composite index may not exist yet — fall back to an unordered fetch.
      const q = query(collection(db, "items"), where("userId", "==", uid));
      snapshot = await getDocs(q);
    }

    if (snapshot.empty) {
      historyList.innerHTML = `<p style="color:#6b7280;">You haven't shared any items yet — post your first one to start earning medals!</p>`;
      return;
    }

    const rows = [];
    snapshot.forEach((docSnap) => {
      const item = docSnap.data();
      const isClaimed = item.status === "claimed";
      const dateStr = item.createdAt && item.createdAt.toDate ? item.createdAt.toDate().toLocaleDateString() : "";
      rows.push(`
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f3f4f6;">
          <div>
            <strong style="color:#111827;">${escapeHtml(item.title || "Untitled item")}</strong>
            <div style="font-size:12px; color:#6b7280;">${escapeHtml(item.category || "General")} · ${dateStr}</div>
          </div>
          <span style="font-size:12px; font-weight:600; padding:3px 10px; border-radius:999px; background:${isClaimed ? "#f0fdf4" : "#eff6ff"}; color:${isClaimed ? "#166534" : "#1d4ed8"};">
            ${isClaimed ? "Claimed" : "Available"}
          </span>
        </div>
      `);
    });

    historyList.innerHTML = rows.join("");
  } catch (e) {
    console.error("Error loading contribution history:", e);
    historyList.innerHTML = `<p style="color:#dc2626;">Couldn't load your sharing history.</p>`;
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
