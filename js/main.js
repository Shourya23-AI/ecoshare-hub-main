import { auth, db, storage } from "./firebase-config.js";
import { 
  collection, addDoc, serverTimestamp, getDocs, query, orderBy, doc, deleteDoc, updateDoc, getDoc,
  runTransaction, arrayUnion, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref as storageRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { 
  onAuthStateChanged, signOut 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getExpiryDate, buildUnclaimUpdate, getPriorityDeadline } from "./item-status.js";
import { notifyPosterOfClaim, initClaimNotifications } from "./notifications.js";
import { renderNavTierPill, renderNavProfileButton, getCurrentTier, syncUserTierField, tierRank, isPriorityTier, TIERS } from "./tiers.js";
import { syncUnlockedCertificates } from "./certificates.js";
import { getCurrentPositionSafe, distanceMeters, MIN_CLAIM_DISTANCE_METERS } from "./geo.js";
import { recordLoginIp, isIpBanned } from "./ip-guard.js";
import { initE2ee } from "./e2ee.js";
import { isAdminUser } from "./auth.js";
import { getOrCreateChat } from "./chat.js";

// Escapes HTML-significant characters before untrusted data (item titles,
// descriptions, locations, conditions, poster names, etc.) gets interpolated
// into an innerHTML template — without this, a listing containing something
// like <img src=x onerror=...> would execute in every viewer's browser.
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Radius used to split the community feed into a "near you" bucket and a
// "rest of the community" bucket (see loadItems()). Distance is computed
// from the viewer's live browser location to the item's stored post
// location, best-effort — see js/geo.js for why this fails open.
const NEARBY_RADIUS_METERS = 1000;

// The browser location prompt only needs to fire once per page load, not
// on every loadItems() call (category clicks, post/claim actions, etc.).
// undefined = not yet requested, null = denied/unsupported/timed out.
let cachedViewerLocation;
async function getViewerLocationCached() {
  if (cachedViewerLocation === undefined) {
    cachedViewerLocation = await getCurrentPositionSafe();
  }
  return cachedViewerLocation;
}

// DOM Elements
const postModalOverlay = document.getElementById("post-modal-overlay");
const navPostBtn = document.getElementById("nav-post-btn");
const heroPostBtn = document.getElementById("hero-post-btn");
const postModalClose = document.getElementById("post-modal-close");
const postItemForm = document.getElementById("post-item-form");
const logoutBtn = document.getElementById("logout-btn");
const itemGrid = document.getElementById("item-grid");

// Item photo upload elements (post/edit modal)
const postPhotoInput = document.getElementById("post-photo-input");
const postPhotoPreview = document.getElementById("post-photo-preview");
const postPhotoFilename = document.getElementById("post-photo-filename");
let editingPhotoURL = null; // existing photoURL of the item being edited, kept unless a new file is chosen

// Claim Modal Elements
const claimModalOverlay = document.getElementById("claim-modal-overlay");
const claimModalClose = document.getElementById("claim-modal-close");
const claimCancelBtn = document.getElementById("claim-cancel-btn");
const claimConfirmBtn = document.getElementById("claim-confirm-btn");
const claimItemDetails = document.getElementById("claim-item-details");

// Ensure modal overlays are hidden on load
if (postModalOverlay) postModalOverlay.style.display = "none";
if (claimModalOverlay) claimModalOverlay.style.display = "none";

// Tracks whether the signed-in user is currently banned (set from the
// users/{uid} doc in the auth listener below) — used to short-circuit
// posting/claiming with a friendly message instead of a raw permission
// error from Firestore rules.
let currentUserBanned = false;

// The signed-in user's current medal tier NAME (e.g. "Gold"), or null if
// they haven't unlocked one yet. Kept in sync in the auth listener below —
// used to gate claiming during a listing's Gold+/Platinum/Diamond priority
// window (see openClaimModal / the claim confirm handler).
let currentUserTier = null;

// --- Quantity helpers ---
// Items now track quantityTotal / quantityAvailable as whole-number integers
// so a listing can be partially claimed instead of being all-or-nothing.
// Older docs only have a free-text `quantity` string (e.g. "3 kg") — fall
// back to parsing that so existing listings keep working.
function getQuantityInfo(item) {
  if (typeof item.quantityTotal === "number" && typeof item.quantityAvailable === "number") {
    return {
      total: Math.max(0, Math.round(item.quantityTotal)),
      available: Math.max(0, Math.round(item.quantityAvailable)),
      unit: item.quantityUnit || "units"
    };
  }

  // Legacy fallback: parse "3 kg" style strings and treat the item as fully
  // available/claimed based on its status, since no partial data exists.
  const match = /^([\d.]+)\s*(.*)$/.exec((item.quantity || "").trim());
  const total = match ? Math.max(1, Math.round(parseFloat(match[1]))) : 1;
  const unit = (match && match[2].trim()) || "units";
  const available = (!item.status || item.status === "available") ? total : 0;
  return { total, available, unit };
}

let searchInput = document.getElementById("search-input") || document.querySelector("input[type='search']") || document.querySelector("input[placeholder*='Search' i]");
let editingDocId = null;
let currentCategory = "All";
let selectedClaimDocId = null;
let selectedClaimItemData = null;

// Ensure search bar exists and functions
if (itemGrid && !searchInput) {
  const searchWrapper = document.createElement("div");
  searchWrapper.style.cssText = "display: flex; gap: 8px; margin-bottom: 24px; max-width: 600px; width: 100%; position: relative; z-index: 10;";
  searchWrapper.innerHTML = `
    <input type="search" id="dynamic-search-input" placeholder="Search items by title or description..." style="flex: 1; padding: 12px 16px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; outline: none;" />
    <button id="dynamic-search-btn" style="background: #166534; color: #ffffff; border: none; padding: 0 18px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 16px;">➔</button>
  `;
  itemGrid.parentElement.insertBefore(searchWrapper, itemGrid);
  searchInput = document.getElementById("dynamic-search-input");
}

if (searchInput) {
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadItems();
    }
  });
}

const existingSearchBtn = document.getElementById("search-action-btn") || document.getElementById("dynamic-search-btn");
if (existingSearchBtn) {
  existingSearchBtn.addEventListener("click", () => loadItems());
}

// Show a live thumbnail of whatever photo the person just picked, and note
// its filename so it's clear a photo has been attached before they submit.
if (postPhotoInput) {
  postPhotoInput.addEventListener("change", () => {
    const file = postPhotoInput.files && postPhotoInput.files[0];
    if (!file) {
      if (postPhotoFilename) postPhotoFilename.textContent = "No file selected — items with photos get claimed faster";
      if (postPhotoPreview) postPhotoPreview.style.display = "none";
      return;
    }
    if (postPhotoFilename) postPhotoFilename.textContent = file.name;
    if (postPhotoPreview) {
      const reader = new FileReader();
      reader.onload = () => {
        postPhotoPreview.src = reader.result;
        postPhotoPreview.style.display = "block";
      };
      reader.readAsDataURL(file);
    }
  });
}

function resetPhotoField(existingPhotoURL = null) {
  editingPhotoURL = existingPhotoURL;
  if (postPhotoInput) postPhotoInput.value = "";
  if (postPhotoPreview) {
    if (existingPhotoURL) {
      postPhotoPreview.src = existingPhotoURL;
      postPhotoPreview.style.display = "block";
    } else {
      postPhotoPreview.src = "";
      postPhotoPreview.style.display = "none";
    }
  }
  if (postPhotoFilename) {
    postPhotoFilename.textContent = existingPhotoURL
      ? "Current photo — choose a file to replace it"
      : "No file selected — items with photos get claimed faster";
  }
}

// Modal Controls (Post / Edit)
function openModal(editData = null) {
  if (postModalOverlay) postModalOverlay.style.display = "flex";
  
  const modalTitle = postModalOverlay.querySelector("h3");
  const submitBtn = postItemForm ? postItemForm.querySelector('button[type="submit"]') : null;

  if (editData) {
    editingDocId = editData.id;
    if (modalTitle) modalTitle.textContent = "Edit item";
    if (submitBtn) submitBtn.textContent = "Save changes";

    if (postItemForm) {
      postItemForm.title.value = editData.title || "";
      postItemForm.category.value = editData.category || "";
      postItemForm.condition.value = editData.condition || "";

      // Prefer the structured integer fields; fall back to parsing the old
      // free-text quantity string ("3 kg") for listings created before this.
      const knownUnits = ["units", "kg", "g", "pieces", "packs", "liters"];
      let amountValue = 1;
      let parsedUnit = "";
      if (typeof editData.quantityTotal === "number") {
        amountValue = Math.max(1, Math.round(editData.quantityTotal));
        parsedUnit = (editData.quantityUnit || "").toLowerCase();
      } else {
        const quantityMatch = /^([\d.]+)\s*(.*)$/.exec((editData.quantity || "").trim());
        amountValue = quantityMatch ? Math.max(1, Math.round(parseFloat(quantityMatch[1]))) : 1;
        parsedUnit = quantityMatch ? quantityMatch[2].trim().toLowerCase() : "";
      }
      postItemForm.quantityAmount.value = amountValue;
      postItemForm.quantityUnit.value = knownUnits.includes(parsedUnit) ? parsedUnit : "units";

      postItemForm.pickupLocation.value = editData.pickupLocation || "";
      postItemForm.description.value = editData.description || "";
    }
    resetPhotoField(editData.photoURL || null);
    updatePostingLimitNote();
  } else {
    editingDocId = null;
    if (modalTitle) modalTitle.textContent = "Post an item";
    if (submitBtn) submitBtn.textContent = "Post listing";
    if (postItemForm) postItemForm.reset();
    resetPhotoField(null);
    updatePostingLimitNote();
  }
}

function closeModal() {
  if (postModalOverlay) postModalOverlay.style.display = "none";
  if (postItemForm) postItemForm.reset();
  editingDocId = null;
  resetPhotoField(null);
}

if (navPostBtn) navPostBtn.addEventListener("click", () => openModal());
if (heroPostBtn) heroPostBtn.addEventListener("click", () => openModal());
if (postModalClose) postModalClose.addEventListener("click", closeModal);

if (postModalOverlay) {
  postModalOverlay.addEventListener("click", (e) => {
    if (e.target === postModalOverlay) closeModal();
  });
}

// Claim Modal Controls
function openClaimModal(docId, item) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    showNotification("Please log in to claim items.", "error");
    window.location.href = "login.html";
    return;
  }

  const qty = getQuantityInfo(item);
  if (item.status === "claimed" || qty.available <= 0) {
    showNotification("This item is no longer available.", "error");
    return;
  }

  const priorityUntilMs = item.priorityUntil && item.priorityUntil.toDate ? item.priorityUntil.toDate().getTime() : null;
  if (priorityUntilMs && Date.now() < priorityUntilMs && !isPriorityTier(currentUserTier)) {
    const minsLeft = Math.ceil((priorityUntilMs - Date.now()) / 60000);
    showNotification(
      `This item is in its priority window — only Gold, Platinum and Diamond members can claim it right now. Opens to everyone in about ${minsLeft} minute${minsLeft === 1 ? "" : "s"}.`,
      "error"
    );
    return;
  }

  selectedClaimDocId = docId;
  selectedClaimItemData = item;

  if (claimItemDetails) {
    claimItemDetails.innerHTML = `
      You are about to claim <strong>${escapeHtml(item.title || "this item")}</strong> located at <strong>${escapeHtml(item.pickupLocation || "Specified location")}</strong>. 
      Once confirmed, a direct chat will open with the owner to coordinate pickup.
    `;
  }

  const claimAmountContainer = document.getElementById("claim-amount-container");
  if (claimAmountContainer) {
    if (qty.available > 1) {
      claimAmountContainer.innerHTML = `
        <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">
          How many would you like to claim? (${qty.available} ${qty.unit} available)
        </label>
        <input type="number" id="claim-amount-input" min="1" step="1" max="${qty.available}" value="1"
          style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;" />
      `;
    } else {
      claimAmountContainer.innerHTML = "";
    }
  }

  if (claimModalOverlay) claimModalOverlay.style.display = "flex";
}

function closeClaimModal() {
  if (claimModalOverlay) claimModalOverlay.style.display = "none";
  const claimAmountContainer = document.getElementById("claim-amount-container");
  if (claimAmountContainer) claimAmountContainer.innerHTML = "";
  selectedClaimDocId = null;
  selectedClaimItemData = null;
}

if (claimModalClose) claimModalClose.addEventListener("click", closeClaimModal);
if (claimCancelBtn) claimCancelBtn.addEventListener("click", closeClaimModal);

if (claimModalOverlay) {
  claimModalOverlay.addEventListener("click", (e) => {
    if (e.target === claimModalOverlay) closeClaimModal();
  });
}

// Confirm Claim Button Action
if (claimConfirmBtn) {
  claimConfirmBtn.addEventListener("click", async () => {
    if (!selectedClaimDocId) return;

    const currentUser = auth.currentUser;
    if (!currentUser) {
      window.location.href = "login.html";
      return;
    }
    if (currentUserBanned) {
      showNotification("Your account is restricted and can't claim items. Contact an admin.", "error");
      return;
    }

    const amountInput = document.getElementById("claim-amount-input");
    // Whole units only — a claim can never be a fraction of an item.
    let claimAmount = amountInput ? Math.round(parseFloat(amountInput.value)) : 1;
    if (!Number.isFinite(claimAmount) || claimAmount < 1) claimAmount = 1;

    claimConfirmBtn.disabled = true;
    const itemRef = doc(db, "items", selectedClaimDocId);

    try {
      // Anti-abuse proximity guard: if the item has a posted location and
      // we can get the claimer's current location, block claims made from
      // essentially the same spot (within MIN_CLAIM_DISTANCE_METERS). This
      // is aimed at someone claiming their own listing from a second
      // account just to farm donation stats. Best-effort only — skipped
      // entirely if either location isn't available (permission denied,
      // unsupported browser, or an older item with no stored location).
      const preSnap = await getDoc(itemRef);
      const preData = preSnap.exists() ? preSnap.data() : null;
      if (preData && preData.location) {
        const claimerLocation = await getCurrentPositionSafe();
        if (claimerLocation) {
          const distance = distanceMeters(preData.location, claimerLocation);
          if (distance !== null && distance < MIN_CLAIM_DISTANCE_METERS) {
            throw new Error(
              `This claim was blocked: you're within ${MIN_CLAIM_DISTANCE_METERS} meters of where this item was posted. ` +
              "Claims can't be made from the same spot the item was listed from — this rule exists to stop people " +
              "claiming their own items (e.g. from a second account) to inflate their donation stats. If this seems " +
              "wrong, contact an admin."
            );
          }
        }
      }

      // Run the read-check-write as a transaction so two people claiming the
      // last item(s) at the same time can't both succeed (no overselling)
      // and so the listing only closes once quantity actually hits zero.
      const result = await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(itemRef);
        if (!snap.exists()) throw new Error("This item no longer exists.");

        const data = snap.data();
        if (data.userId === currentUser.uid) {
          throw new Error("You cannot claim your own item.");
        }

        const qty = getQuantityInfo(data);
        if (data.status === "claimed" || qty.available <= 0) {
          throw new Error("This item is no longer available.");
        }

        const amount = Math.min(claimAmount, qty.available);
        const newAvailable = qty.available - amount;

        transaction.update(itemRef, {
          quantityTotal: qty.total,
          quantityAvailable: newAvailable,
          quantityUnit: qty.unit,
          // Keep the post active while stock remains; only close it out
          // once every unit has been claimed.
          status: newAvailable <= 0 ? "claimed" : "available",
          claimedBy: currentUser.uid,
          claimedByName: currentUser.displayName || currentUser.email.split('@')[0],
          claimedAt: serverTimestamp(),
          claims: arrayUnion({
            uid: currentUser.uid,
            name: currentUser.displayName || currentUser.email.split('@')[0],
            amount,
            claimedAt: new Date()
          })
        });

        return { amount, remaining: newAvailable, unit: qty.unit, posterUid: data.userId, itemTitle: data.title };
      });

      const userRef = doc(db, "users", currentUser.uid);
      updateDoc(userRef, { itemsClaimed: increment(result.amount) }).catch((e) =>
        console.warn("Failed to update claimed-item stat:", e)
      );

      // Let the poster know their item was claimed — surfaced as a popup /
      // bell notification next time they're on their dashboard.
      notifyPosterOfClaim({
        posterUid: result.posterUid,
        itemId: selectedClaimDocId,
        itemTitle: result.itemTitle,
        claimerUid: currentUser.uid,
        claimerName: currentUser.displayName || currentUser.email.split('@')[0],
        amount: result.amount,
        unit: result.unit,
      });

      sessionStorage.setItem('active_claim_item', selectedClaimDocId);
      closeClaimModal();
      showNotification(
        `Claimed ${result.amount} ${result.unit}! Redirecting to messages...`,
        "success"
      );

      setTimeout(() => {
        window.location.href = "chat.html";
      }, 1000);
    } catch (err) {
      console.error("Error claiming item:", err);
      const isPermissionDenied = err && (err.code === "permission-denied" || /permission/i.test(err.message || ""));
      showNotification(
        isPermissionDenied
          ? "Couldn't claim this item — it may still be in its Gold/Platinum/Diamond priority window, or it changed since this page loaded. Try refreshing."
          : (err.message || "Failed to claim item. Try again."),
        "error"
      );
    } finally {
      claimConfirmBtn.disabled = false;
    }
  });
}

// --- STANDALONE LIVE STATS ---
async function fetchLiveStats() {
  try {
    const snapshot = await getDocs(collection(db, "items"));
    const totalItems = snapshot.size;
    
    const uniqueUsers = new Set();
    let totalWasteKg = 0;

    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      if (data.userId) uniqueUsers.add(data.userId);
      totalWasteKg += 1.5;
    });

    let certificatesCount = 0;
    try {
      const certsSnapshot = await getDocs(collection(db, "certificates"));
      certificatesCount = certsSnapshot.size;
    } catch (e) {
      certificatesCount = 0;
    }

    const itemsEl = document.getElementById("stat-items-shared");
    const wasteEl = document.getElementById("stat-waste-diverted");
    const membersEl = document.getElementById("stat-active-members");
    const certsEl = document.getElementById("stat-certificates");

    const memberCount = Math.max(uniqueUsers.size, totalItems > 0 ? 1 : 0);

    if (itemsEl) itemsEl.innerText = totalItems;
    if (wasteEl) wasteEl.innerText = `${Math.round(totalWasteKg)} kg`;
    if (membersEl) membersEl.innerText = memberCount;
    if (certsEl) certsEl.innerText = certificatesCount;

    // Feed the "instant stats" cache home.html/leaderboard.html read on
    // load (see the inline fallback scripts there) so the NEXT time this
    // tab visits either page this session, last-known numbers can paint
    // immediately instead of showing "--" while this fetch is in flight.
    try {
      sessionStorage.setItem("ecoshare_home_stats", JSON.stringify({
        items: totalItems,
        waste: Math.round(totalWasteKg),
        members: memberCount,
        certs: certificatesCount,
      }));
    } catch (e) {
      // sessionStorage can throw in some private-browsing modes — the
      // cache is a best-effort convenience, so just skip it.
    }
  } catch (err) {
    console.error("Error fetching stats:", err);
  }
}

fetchLiveStats();

// Authentication UI tracking & Admin Dashboard Button Handler
onAuthStateChanged(auth, async (user) => {
  if (logoutBtn) logoutBtn.style.display = user ? "inline-block" : "none";

  const navContainer = document.querySelector(".nav");
  let adminBtn = document.getElementById("nav-admin-dashboard-btn");

  if (user) {
    const isAdmin = await isAdminUser(user);

    if (isAdmin && navContainer && !adminBtn) {
      adminBtn = document.createElement("a");
      adminBtn.id = "nav-admin-dashboard-btn";
      adminBtn.href = "admin.html";
      adminBtn.textContent = "Dashboard";
      adminBtn.style.cssText = "color: #166534; text-decoration: none; font-weight: 650; background: #dcfce7; padding: 6px 12px; border-radius: 6px;";
      navContainer.appendChild(adminBtn);
    } else if (!isAdmin && adminBtn) {
      adminBtn.remove();
    }

    // Keep the nav medal pill (🥉/🥈/🥇/💎/💠) in sync on every page, and
    // remember ban state so posting/claiming/chat can be blocked gracefully.
    // Publish/refresh this browser's end-to-end-encryption public key as
    // early as possible, so anyone opening a chat with this user can
    // encrypt to them right away (best-effort, never blocks the page).
    initE2ee(user.uid);

    try {
      const userSnap = await getDoc(doc(db, "users", user.uid));
      const userData = userSnap.exists() ? userSnap.data() : {};
      const itemsShared = userData.itemsShared || 0;
      currentUserBanned = !!userData.banned;
      currentUserTier = (getCurrentTier(itemsShared) || {}).name || null;
      renderNavTierPill(itemsShared);
      renderNavProfileButton({
        name: userData.name || user.displayName || (user.email || "").split("@")[0],
        itemsShared,
        unlockedTiers: userData.unlockedTiers || [],
      });
      if (currentUserBanned) {
        showNotification("Your account has been restricted by an admin. You can browse, but can't post, claim, or chat.", "error");
      }

      // IP ban re-check: catches a session that was already open when an
      // admin banned its network, not just fresh logins (auth.js handles
      // the fresh-login case). Best-effort — see js/ip-guard.js for why
      // this can't be a hard guarantee in a client-only app.
      const ip = await recordLoginIp(user.uid);
      if (ip && await isIpBanned(ip)) {
        showNotification("This device/network has been blocked by an admin. Signing you out...", "error");
        setTimeout(async () => {
          await signOut(auth);
          window.location.href = "login.html?blocked=ip";
        }, 1200);
        return;
      }
    } catch (e) {
      console.warn("Failed to load tier pill:", e);
    }
  } else {
    if (adminBtn) adminBtn.remove();
    const pill = document.getElementById("nav-tier-pill");
    if (pill) pill.style.display = "none";
    currentUserTier = null;
  }

  loadItems();
});

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "login.html";
  });
}

// Posting time limits and the "posting limit" note now live in item-status.js
// so the poster-side and admin-side unclaim/reset logic stay in sync.

// Live "Posting Limit" note in the post/edit modal, based on the chosen category
const postingLimitNote = document.getElementById("posting-limit-note");
const categorySelect = postItemForm ? postItemForm.querySelector('select[name="category"]') : null;

function updatePostingLimitNote() {
  if (!postingLimitNote || !categorySelect) return;
  const isFood = categorySelect.value.toLowerCase() === "food";
  postingLimitNote.textContent = isFood
    ? "🍞 Food listings auto-remove after 2 hours"
    : "📦 Other items auto-remove after 5 days";
}

if (categorySelect) {
  categorySelect.addEventListener("change", updatePostingLimitNote);
}

// Countdown formatting + a single ticking interval that updates every visible countdown
function formatCountdown(remainingMs) {
  if (remainingMs <= 0) return "Expired";
  const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
  const seconds = Math.floor((remainingMs % (60 * 1000)) / 1000);
  return `${days}d ${hours}h ${minutes}m ${seconds}s left`;
}

setInterval(() => {
  document.querySelectorAll(".countdown-timer").forEach((el) => {
    const expiresAtMs = Number(el.getAttribute("data-expires"));
    if (!expiresAtMs) return;
    el.textContent = formatCountdown(expiresAtMs - Date.now());
  });

  // Priority-window countdowns ("Opens to everyone in Xm Ys") on cards
  // currently locked to Gold/Platinum/Diamond claimers. Once one hits
  // zero, refresh the grid once so the card flips over to a normal,
  // everyone-can-claim button — instead of just freezing at "0:00".
  let anyPriorityExpired = false;
  document.querySelectorAll(".priority-window-timer").forEach((el) => {
    const untilMs = Number(el.getAttribute("data-priority-until"));
    if (!untilMs) return;
    const remaining = untilMs - Date.now();
    if (remaining <= 0) {
      anyPriorityExpired = true;
    } else {
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      el.textContent = `Opens to everyone in ${mins}m ${String(secs).padStart(2, "0")}s`;
    }
  });
  if (anyPriorityExpired) loadItems();
}, 1000);

// Handle Posting / Updating Items
let isSubmitting = false;

if (postItemForm) {
  postItemForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (currentUserBanned) {
      showNotification("Your account is restricted and can't post items. Contact an admin.", "error");
      return;
    }
    isSubmitting = true;

    const submitBtn = postItemForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving...";
    }

    const formData = new FormData(postItemForm);
    const currentUser = auth.currentUser;

    try {
      const category = formData.get("category");
      const quantityUnit = formData.get("quantityUnit") || "units";
      // Quantities are always whole units — round and floor at 1 so the
      // amount can never dip into fractions like 0.1.
      const quantityTotal = Math.max(1, Math.round(parseFloat(formData.get("quantityAmount"))));

      // Best-effort location capture (see js/geo.js) — used later to block
      // a claim made from essentially the same spot the item was posted
      // from. Skipped silently if the browser/user doesn't allow it.
      const postLocation = editingDocId ? undefined : await getCurrentPositionSafe();

      // Photo upload (optional) — stored at items/{uid}/{timestamp}-{filename}
      // to match storage.rules, which only allow a user to write under their
      // own uid. Only uploads when a new file was actually chosen; editing an
      // item without touching the photo field leaves the existing photo (if
      // any) untouched via editingPhotoURL.
      let photoURL = editingPhotoURL || null;
      const chosenPhoto = postPhotoInput && postPhotoInput.files && postPhotoInput.files[0];
      if (chosenPhoto && currentUser) {
        if (submitBtn) submitBtn.textContent = "Uploading photo...";
        const safeName = chosenPhoto.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `items/${currentUser.uid}/${Date.now()}-${safeName}`;
        const fileRef = storageRef(storage, path);
        await uploadBytes(fileRef, chosenPhoto);
        photoURL = await getDownloadURL(fileRef);
        if (submitBtn) submitBtn.textContent = "Saving...";
      }

      const itemPayload = {
        title: formData.get("title"),
        category,
        condition: formData.get("condition"),
        quantityTotal,
        quantityUnit,
        quantity: `${quantityTotal} ${quantityUnit}`, // kept for legacy/display compatibility
        pickupLocation: formData.get("pickupLocation"),
        description: formData.get("description") || "",
        photoURL: photoURL || null,
        // Food listings expire after 2 hours, everything else after 5 days.
        expiresAt: getExpiryDate(category)
      };

      if (editingDocId) {
        // Preserve whatever has already been claimed: shrink/grow the
        // available count with the total instead of resetting it, so an
        // edit never re-opens units that were already claimed away.
        const existingSnap = await getDoc(doc(db, "items", editingDocId));
        const existingData = existingSnap.exists() ? existingSnap.data() : {};
        const existingQty = getQuantityInfo(existingData);
        const claimedSoFar = existingQty.total - existingQty.available;
        const newAvailable = Math.max(0, quantityTotal - claimedSoFar);

        await updateDoc(doc(db, "items", editingDocId), {
          ...itemPayload,
          quantityAvailable: newAvailable,
          status: newAvailable <= 0 ? "claimed" : "available",
          updatedAt: serverTimestamp()
        });
        showNotification("Item updated successfully! ✏️", "success");
      } else {
        // Snapshot the poster's CURRENT rank onto the listing itself — this
        // is what colors the card's background and decides its place in
        // the "highest rank first" sort order. It reflects their rank at
        // the moment they hit "Post listing", the same way the badge on
        // their profile works.
        let posterItemsShared = 0;
        if (currentUser) {
          const posterSnap = await getDoc(doc(db, "users", currentUser.uid));
          posterItemsShared = posterSnap.exists() ? (posterSnap.data().itemsShared || 0) : 0;
        }
        const posterTier = (getCurrentTier(posterItemsShared) || {}).name || null;

        await addDoc(collection(db, "items"), {
          ...itemPayload,
          quantityAvailable: quantityTotal,
          status: "available",
          userId: currentUser ? currentUser.uid : "anonymous",
          userEmail: currentUser ? currentUser.email : "anonymous",
          claimedBy: null,
          claimedByName: null,
          location: postLocation || null,
          createdAt: serverTimestamp(),
          posterTier,
          // Gold/Platinum/Diamond members get first crack at claiming this
          // for 15 minutes; after that it's open to everyone.
          priorityUntil: getPriorityDeadline()
        });

        // Posting an item counts as a "donation" toward medal tiers —
        // bump the user's live itemsShared count and unlock any
        // certificate thresholds it just crossed.
        if (currentUser) {
          try {
            const userRef = doc(db, "users", currentUser.uid);
            await updateDoc(userRef, { itemsShared: increment(1) });
            const freshUserSnap = await getDoc(userRef);
            const freshShared = freshUserSnap.exists() ? (freshUserSnap.data().itemsShared || 0) : 0;
            const displayName = (freshUserSnap.exists() && freshUserSnap.data().name)
              || currentUser.displayName || currentUser.email.split("@")[0];
            await syncUnlockedCertificates(currentUser.uid, displayName, freshShared);
            renderNavTierPill(freshShared);
            currentUserTier = (await syncUserTierField(currentUser.uid, freshShared)) || null;
          } catch (statErr) {
            console.warn("Failed to update donation stats:", statErr);
          }
        }

        showNotification("Item posted successfully! 🎉", "success");
      }

      closeModal();
      fetchLiveStats();
      loadItems();
    } catch (err) {
      console.error("Error saving item:", err);
      showNotification("Error saving item.", "error");
    } finally {
      isSubmitting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = editingDocId ? "Save changes" : "Post listing";
      }
    }
  });
}

// Category Filter Click Handling
document.addEventListener("click", (e) => {
  const categoryBtn = e.target.closest("[data-category], .filter-chip");
  if (categoryBtn) {
    currentCategory = categoryBtn.getAttribute("data-category") || categoryBtn.textContent.trim();
    
    document.querySelectorAll(".filter-chip").forEach(btn => {
      const btnCat = btn.getAttribute("data-category");
      if (btnCat && btnCat.toLowerCase() === currentCategory.toLowerCase()) {
        btn.style.backgroundColor = "#166534";
        btn.style.color = "#ffffff";
        btn.style.borderColor = "#166534";
      } else {
        btn.style.backgroundColor = "#ffffff";
        btn.style.color = "#374151";
        btn.style.borderColor = "#e5e7eb";
      }
    });

    loadItems();
  }
});

// Toast notification helper
function showNotification(message, type = "success") {
  const existing = document.getElementById("toast-notification");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "toast-notification";
  toast.style.cssText = `
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 99999;
    padding: 16px 24px; border-radius: 10px; font-size: 15px; font-weight: 600;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15); text-align: center;
    max-width: min(90vw, 480px); line-height: 1.4;
    background: ${type === "success" ? "#f0fdf4" : "#fef2f2"};
    color: ${type === "success" ? "#166534" : "#991b1b"};
    border: 1px solid ${type === "success" ? "#bbf7d0" : "#fecaca"};
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

// Core function to load items with fail-safe error rendering
async function loadItems() {
  if (!itemGrid) return;
  
  try {
    let snapshot;
    try {
      const q = query(collection(db, "items"), orderBy("createdAt", "desc"));
      snapshot = await getDocs(q);
    } catch (indexError) {
      console.warn("Index warning detected, falling back to unordered fetch:", indexError);
      snapshot = await getDocs(collection(db, "items"));
    }

    itemGrid.innerHTML = "";

    if (snapshot.empty) {
      itemGrid.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #666; padding: 40px;">No items posted yet. Be the first to share!</p>`;
      return;
    }

    const currentUserId = auth.currentUser ? auth.currentUser.uid : null;
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : "";

    const myItemsList = [];
    const communityItemsList = [];
    const expiredDocIds = [];

    snapshot.forEach((docSnap) => {
      const item = docSnap.data();
      const docId = docSnap.id;

      // Remove items past their posting time limit (2hrs for food, 5 days otherwise).
      if (item.expiresAt && item.expiresAt.toDate && item.expiresAt.toDate() < new Date()) {
        expiredDocIds.push(docId);
        return;
      }

      const title = (item.title || "").toLowerCase();
      const description = (item.description || "").toLowerCase();
      const category = (item.category || "").toLowerCase();

      const matchesSearch = !searchTerm || title.includes(searchTerm) || description.includes(searchTerm);
      const matchesCategory = currentCategory === "All" || category === currentCategory.toLowerCase();

      if (!matchesSearch || !matchesCategory) return;

      const isOwner = currentUserId && item.userId === currentUserId;
      if (isOwner) {
        myItemsList.push({ docId, item, isOwner });
      } else {
        communityItemsList.push({ docId, item, isOwner });
      }
    });

    if (expiredDocIds.length > 0) {
      expiredDocIds.forEach((docId) => {
        deleteDoc(doc(db, "items", docId)).catch((err) =>
          console.warn("Failed to auto-remove expired item:", docId, err)
        );
      });
    }

    // Split everyone else's listings into "within 1km" and "rest of the
    // community" using the viewer's live browser location vs. each item's
    // stored post location. This is best-effort and fails open: if the
    // viewer never granted location, or an item has no stored location
    // (e.g. an older listing), it simply falls into the community bucket
    // instead of blocking anything.
    const viewerLocation = await getViewerLocationCached();
    const nearbyItemsList = [];
    const widerCommunityList = [];

    communityItemsList.forEach((entry) => {
      const itemLocation = entry.item.location;
      const distance = viewerLocation && itemLocation ? distanceMeters(viewerLocation, itemLocation) : null;
      entry.distanceMeters = distance;
      if (distance !== null && distance <= NEARBY_RADIUS_METERS) {
        nearbyItemsList.push(entry);
      } else {
        widerCommunityList.push(entry);
      }
    });

    // Highest-ranked posters (Diamond > Platinum > Gold > Silver > Bronze >
    // no rank) float to the top of each section. Array.sort is stable, so
    // within the same rank items stay in their existing createdAt-desc order.
    const byPosterRankDesc = (a, b) => tierRank(b.item.posterTier) - tierRank(a.item.posterTier);
    myItemsList.sort(byPosterRankDesc);
    // Nearby items sort closest-first (ties broken by poster rank); distance
    // is only meaningful within the "near you" bucket, so the wider
    // community list keeps the plain rank sort.
    nearbyItemsList.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0) || tierRank(b.item.posterTier) - tierRank(a.item.posterTier));
    widerCommunityList.sort(byPosterRankDesc);

    if (myItemsList.length === 0 && nearbyItemsList.length === 0 && widerCommunityList.length === 0) {
      itemGrid.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #666; padding: 40px;">No items found matching your search or category.</p>`;
      return;
    }

    if (myItemsList.length > 0) {
      const mySection = document.createElement("div");
      mySection.style.cssText = "margin-bottom: 36px; width: 100%; grid-column: 1 / -1;";
      mySection.innerHTML = `
        <h2 style="font-size: 20px; font-weight: 700; color: #166534; margin-bottom: 16px; border-bottom: 2px solid #bbf7d0; padding-bottom: 8px;">
          📦 My Posted Items (${myItemsList.length})
        </h2>
        <div id="my-subgrid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px;"></div>
      `;
      itemGrid.appendChild(mySection);
      const mySubgrid = mySection.querySelector("#my-subgrid");
      myItemsList.forEach(({ docId, item, isOwner }) => {
        mySubgrid.appendChild(createItemCard(docId, item, isOwner));
      });
    }

    if (nearbyItemsList.length > 0) {
      const nearbySection = document.createElement("div");
      nearbySection.style.cssText = "margin-bottom: 36px; width: 100%; grid-column: 1 / -1;";
      nearbySection.innerHTML = `
        <h2 style="font-size: 20px; font-weight: 700; color: #0369a1; margin-bottom: 16px; border-bottom: 2px solid #bae6fd; padding-bottom: 8px;">
          📍 Near You — within 1km (${nearbyItemsList.length})
        </h2>
        <div id="nearby-subgrid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px;"></div>
      `;
      itemGrid.appendChild(nearbySection);
      const nearbySubgrid = nearbySection.querySelector("#nearby-subgrid");
      nearbyItemsList.forEach(({ docId, item, isOwner, distanceMeters }) => {
        nearbySubgrid.appendChild(createItemCard(docId, item, isOwner, distanceMeters));
      });
    } else if (!viewerLocation) {
      const nearbyNote = document.createElement("div");
      nearbyNote.style.cssText = "margin-bottom: 24px; width: 100%; grid-column: 1 / -1; font-size: 13px; color: #6b7280; background: #f9fafb; border: 1px dashed #d1d5db; border-radius: 8px; padding: 12px 16px;";
      nearbyNote.textContent = "📍 Enable location access in your browser to see items posted within 1km of you.";
      itemGrid.appendChild(nearbyNote);
    }

    if (widerCommunityList.length > 0) {
      const commSection = document.createElement("div");
      commSection.style.cssText = "width: 100%; grid-column: 1 / -1;";
      commSection.innerHTML = `
        <h2 style="font-size: 20px; font-weight: 700; color: #1f2937; margin-bottom: 16px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px;">
          🌍 Entire Community (${widerCommunityList.length})
        </h2>
        <div id="comm-subgrid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px;"></div>
      `;
      itemGrid.appendChild(commSection);
      const commSubgrid = commSection.querySelector("#comm-subgrid");
      widerCommunityList.forEach(({ docId, item, isOwner, distanceMeters }) => {
        commSubgrid.appendChild(createItemCard(docId, item, isOwner, distanceMeters));
      });
    }

  } catch (e) {
    console.error("Critical error loading items:", e);
    // Overwrite the loading text so the user sees a clear error message instead of freezing
    itemGrid.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #dc2626; padding: 40px;">Failed to load items. Check your internet connection or Firebase Console rules.</p>`;
  }
}

// Maps a posterTier name to the CSS class that gives the card its
// rank-colored background (see css/style.css for the actual looks:
// wood-toned bronze, silverish gradient, gold gradient, a platinum
// iridescent sheen, and a faceted "diamond" look). No rank at all just
// stays plain white.
function rankCardClass(tierName) {
  switch (tierName) {
    case "Bronze": return "rank-card-bronze";
    case "Silver": return "rank-card-silver";
    case "Gold": return "rank-card-gold";
    case "Platinum": return "rank-card-platinum";
    case "Diamond": return "rank-card-diamond";
    default: return "rank-card-none";
  }
}

// Formats a distance in meters as a short human label, e.g. "450 m away"
// or "3.2 km away". Returns "" when distance is null/unknown so callers
// can safely drop it into a template without an extra branch.
function formatDistance(distanceMeters) {
  if (distanceMeters === null || distanceMeters === undefined) return "";
  if (distanceMeters < 1000) return `${Math.round(distanceMeters)} m away`;
  return `${(distanceMeters / 1000).toFixed(1)} km away`;
}

function createItemCard(docId, item, isOwner, distanceMeters = null) {
  const card = document.createElement("div");
  card.className = "item-card";
  card.style.cssText = "position: relative; z-index: 5;";

  const qty = getQuantityInfo(item);
  // A listing stays open for claims as long as any units remain — it only
  // closes out once quantityAvailable actually reaches 0 (or an admin
  // force-closes it directly via the status field).
  const isAvailable = item.status !== "claimed" && qty.available > 0;

  const expiresAtMs = item.expiresAt && item.expiresAt.toDate ? item.expiresAt.toDate().getTime() : null;
  const timeLeftHtml = expiresAtMs
    ? `<span class="countdown-timer" data-expires="${expiresAtMs}">calculating…</span>`
    : "No limit set";

  // Poster's rank → card background + a small badge next to the category chip.
  const posterTierInfo = TIERS.find((t) => t.name === item.posterTier) || null;
  const rankClass = rankCardClass(item.posterTier);
  const posterBadgeHtml = posterTierInfo
    ? `<span class="badge ${posterTierInfo.badgeClass}" title="Poster rank">${posterTierInfo.icon} ${posterTierInfo.name}</span>`
    : "";

  // Gold/Platinum/Diamond priority claim window — first 15 minutes after a
  // listing goes live (or is reopened) are reserved for them; after that,
  // it's first-come-first-served for everyone.
  const priorityUntilMs = item.priorityUntil && item.priorityUntil.toDate ? item.priorityUntil.toDate().getTime() : null;
  const isPriorityActive = !!priorityUntilMs && Date.now() < priorityUntilMs;
  const viewerHasPriorityAccess = isPriorityTier(currentUserTier);
  const priorityBadgeHtml = isPriorityActive
    ? `<span class="badge badge-priority" title="Gold/Platinum/Diamond get first access for 15 minutes">⚡ Priority window</span>`
    : "";

  const photoHtml = item.photoURL
    ? `<div style="width: 100%; height: 150px; border-radius: 8px; margin-bottom: 14px; background-image: url('${encodeURI(item.photoURL)}'); background-size: cover; background-position: center; background-color: #e5e7eb;"></div>`
    : "";

  card.innerHTML = `
    <div class="rank-card ${rankClass}" style="padding: 20px; border-radius: 12px; height: 100%; display: flex; flex-direction: column; justify-content: space-between;">
      <div>
        ${photoHtml}
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; gap: 8px; flex-wrap: wrap;">
          <div style="display:flex; gap:6px; align-items:center; flex-wrap: wrap;">
            <span style="background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600;">${escapeHtml(item.category || "General")}</span>
            ${posterBadgeHtml}
            ${priorityBadgeHtml}
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <span style="font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 4px; background: ${isAvailable ? '#f0fdf4' : '#fef2f2'}; color: ${isAvailable ? '#166534' : '#991b1b'};">
              ${isAvailable ? (qty.total > 1 ? `${qty.available} of ${qty.total} left` : 'Available') : 'Claimed'}
            </span>
            <div class="owner-actions-${docId}" style="display: flex; gap: 6px;"></div>
          </div>
        </div>
        <h3 style="margin: 0 0 8px 0; font-size: 18px; color: #111;">${escapeHtml(item.title)}</h3>
        <p style="color: #4b5563; font-size: 14px; margin-bottom: 14px; line-height: 1.4;">${escapeHtml(item.description || "No description provided.")}</p>
      </div>
      <div>
        <div style="font-size: 13px; color: #6b7280; border-top: 1px solid rgba(0,0,0,0.06); margin-top: 12px; padding-top: 12px; display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px;">
          <span>📍 <strong>Location:</strong> ${escapeHtml(item.pickupLocation)}${distanceMeters !== null ? ` · <strong>${formatDistance(distanceMeters)}</strong>` : ""}</span>
          <span>✨ <strong>Condition:</strong> ${escapeHtml(item.condition)}</span>
          <span>🔢 <strong>Quantity:</strong> ${qty.available} / ${qty.total} ${qty.unit} available</span>
          <span>⏳ <strong>Time left:</strong> ${timeLeftHtml}</span>
        </div>
        <div class="card-action-footer-${docId}"></div>
      </div>
    </div>
  `;

  const footerActionContainer = card.querySelector(`.card-action-footer-${docId}`);

  if (isOwner) {
    const actionsContainer = card.querySelector(`.owner-actions-${docId}`);
    
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.style.cssText = "background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 600;";
    editBtn.addEventListener("click", async () => {
      const docSnap = await getDoc(doc(db, "items", docId));
      if (docSnap.exists()) openModal({ id: docSnap.id, ...docSnap.data() });
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.dataset.confirmState = "false";
    deleteBtn.style.cssText = "background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 600;";

    deleteBtn.addEventListener("click", async () => {
      if (deleteBtn.dataset.confirmState === "false") {
        deleteBtn.dataset.confirmState = "true";
        deleteBtn.textContent = "Confirm?";
        deleteBtn.style.backgroundColor = "#dc2626";
        deleteBtn.style.color = "#ffffff";
        setTimeout(() => {
          if (deleteBtn.dataset.confirmState === "true") {
            deleteBtn.dataset.confirmState = "false";
            deleteBtn.textContent = "Delete";
            deleteBtn.style.backgroundColor = "#fef2f2";
            deleteBtn.style.color = "#991b1b";
          }
        }, 3000);
        return;
      }

      try {
        await deleteDoc(doc(db, "items", docId));
        showNotification("Item deleted successfully! 🗑️", "success");
        fetchLiveStats();
        loadItems();
      } catch (e) {
        showNotification("Delete failed.", "error");
      }
    });

    actionsContainer.appendChild(editBtn);
    actionsContainer.appendChild(deleteBtn);

    if (item.status === "claimed") {
      const unclaimBtn = document.createElement("button");
      unclaimBtn.textContent = "Mark as Unclaimed";
      unclaimBtn.style.cssText = "background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 600;";
      unclaimBtn.addEventListener("click", async () => {
        if (!confirm("Reopen this listing as unclaimed? This resets it to fully available and restarts its posting timer.")) {
          return;
        }
        unclaimBtn.disabled = true;
        try {
          // Re-read the item first so the reset is based on current data
          // (e.g. quantityTotal) rather than a possibly-stale card.
          const freshSnap = await getDoc(doc(db, "items", docId));
          if (!freshSnap.exists()) {
            showNotification("This listing no longer exists.", "error");
            return;
          }
          await updateDoc(doc(db, "items", docId), buildUnclaimUpdate(freshSnap.data()));
          showNotification("Listing reopened as unclaimed. ↩️", "success");
          fetchLiveStats();
          loadItems();
        } catch (e) {
          console.error("Failed to reopen listing:", e);
          showNotification("Failed to reopen listing.", "error");
        } finally {
          unclaimBtn.disabled = false;
        }
      });
      actionsContainer.appendChild(unclaimBtn);

      if (item.claimedBy) {
        const chatBtn = document.createElement("button");
        chatBtn.textContent = "💬 Chat";
        chatBtn.style.cssText = "background: #eef2ff; color: #4338ca; border: 1px solid #c7d2fe; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 600;";
        chatBtn.addEventListener("click", async () => {
          chatBtn.disabled = true;
          try {
            const chatId = await getOrCreateChat(docId, item.title, item.claimedBy, item.claimedByName || "Neighbor");
            window.location.href = `chat.html?id=${encodeURIComponent(chatId)}`;
          } catch (e) {
            console.error("Failed to open chat:", e);
            showNotification("Couldn't open chat.", "error");
          } finally {
            chatBtn.disabled = false;
          }
        });
        actionsContainer.appendChild(chatBtn);
      }
    }

    footerActionContainer.innerHTML = `<button class="btn btn-outline btn-sm" disabled style="width: 100%; opacity: 0.6; cursor: not-allowed;">Your Listing</button>`;
  } else if (isAvailable) {
    if (isPriorityActive && !viewerHasPriorityAccess) {
      // Locked out of the priority window — show why, and count down to
      // when it opens up to everyone.
      footerActionContainer.innerHTML = `
        <button class="btn btn-outline btn-sm" disabled style="width: 100%; opacity: 0.75; cursor: not-allowed; flex-direction: column; gap: 2px; padding: 8px 12px;">
          <span>🔒 Gold/Platinum/Diamond priority window</span>
          <span class="priority-window-timer" data-priority-until="${priorityUntilMs}" style="font-size: 11px; font-weight: 600;">calculating…</span>
        </button>
      `;
    } else {
      const claimBtn = document.createElement("button");
      claimBtn.className = "btn btn-primary btn-sm";
      claimBtn.textContent = isPriorityActive ? "Claim Item ⚡ (priority access)" : "Claim Item";
      claimBtn.style.width = "100%";
      claimBtn.addEventListener("click", () => openClaimModal(docId, item));
      footerActionContainer.appendChild(claimBtn);
    }
  } else if (auth.currentUser && item.claimedBy === auth.currentUser.uid) {
    const chatBtn = document.createElement("button");
    chatBtn.className = "btn btn-primary btn-sm";
    chatBtn.style.width = "100%";
    chatBtn.textContent = "💬 Chat with poster";
    chatBtn.addEventListener("click", async () => {
      chatBtn.disabled = true;
      try {
        const posterName = (item.userEmail && item.userEmail !== "anonymous") ? item.userEmail.split("@")[0] : "Neighbor";
        const chatId = await getOrCreateChat(docId, item.title, item.userId, posterName);
        window.location.href = `chat.html?id=${encodeURIComponent(chatId)}`;
      } catch (e) {
        console.error("Failed to open chat:", e);
        showNotification("Couldn't open chat.", "error");
      } finally {
        chatBtn.disabled = false;
      }
    });
    footerActionContainer.appendChild(chatBtn);
  } else {
    footerActionContainer.innerHTML = `<button class="btn btn-outline btn-sm" disabled style="width: 100%; opacity: 0.6; cursor: not-allowed;">Already Claimed</button>`;
  }

  return card;
}

// Trigger initial load immediately so it doesn't wait solely on onAuthStateChanged
loadItems();

// Poster notifications: shows a popup + keeps a nav bell in sync whenever
// the signed-in user has unread "your item was claimed" notifications.
initClaimNotifications();