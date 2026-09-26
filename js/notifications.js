import { auth, db } from "./firebase-config.js";
import {
  collection, addDoc, doc, updateDoc, getDocs, query, where, orderBy, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const NOTIFICATIONS_COLLECTION = "notifications";

// --- Data layer -------------------------------------------------------

// Called right after a claim succeeds. Writes one record tied to the
// poster (recipientId) so they can be told which item was claimed and by
// whom. Never throws into the caller's claim flow — a failed notification
// shouldn't undo or block a successful claim.
export async function notifyPosterOfClaim({ posterUid, itemId, itemTitle, claimerUid, claimerName, amount, unit }) {
  if (!posterUid || posterUid === claimerUid) return; // no self-notifications
  try {
    await addDoc(collection(db, NOTIFICATIONS_COLLECTION), {
      recipientId: posterUid,
      type: "item_claimed",
      itemId: itemId || null,
      itemTitle: itemTitle || "your item",
      claimedByUid: claimerUid || null,
      claimedByName: claimerName || "A neighbor",
      amount: amount || 1,
      unit: unit || "units",
      read: false,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("Failed to create claim notification:", err);
  }
}

// Every notification for this user, newest first. Falls back to an
// unordered fetch + client-side sort if the composite index isn't set up
// yet (same fallback pattern used for the items listing query).
async function fetchNotificationsFor(uid) {
  const base = collection(db, NOTIFICATIONS_COLLECTION);
  try {
    const q = query(base, where("recipientId", "==", uid), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("Notification index warning, falling back to unordered fetch:", err);
    const q = query(base, where("recipientId", "==", uid));
    const snap = await getDocs(q);
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    return list;
  }
}

async function markNotificationsRead(ids) {
  if (!ids.length) return;
  try {
    const batch = writeBatch(db);
    ids.forEach((id) => batch.update(doc(db, NOTIFICATIONS_COLLECTION, id), { read: true }));
    await batch.commit();
  } catch (err) {
    console.error("Failed to mark notifications as read:", err);
  }
}

// --- UI layer -----------------------------------------------------------

function timeAgo(ts) {
  const ms = ts?.toMillis ? ts.toMillis() : (ts ? new Date(ts).getTime() : Date.now());
  const diffMin = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function notifRow(n) {
  const qtyLabel = n.amount && n.amount > 1 ? `${n.amount} ${n.unit || "units"} of ` : "";
  return `
    <div style="padding: 14px 16px; border-bottom: 1px solid #f3f4f6; display: flex; gap: 12px; align-items: flex-start;">
      <span style="font-size: 20px; line-height: 1;">📦</span>
      <div style="flex: 1;">
        <p style="margin: 0 0 4px 0; font-size: 14px; color: #111827; line-height: 1.4;">
          <strong>${escapeHtml(n.claimedByName || "A neighbor")}</strong> claimed
          ${qtyLabel}<strong>${escapeHtml(n.itemTitle || "your item")}</strong>.
        </p>
        <span style="font-size: 12px; color: #9ca3af;">${timeAgo(n.createdAt)}</span>
      </div>
    </div>
  `;
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// One-time popup shown right after login/page-load when there are unread
// claim notifications waiting. Dismissing it marks everything shown as read.
function showClaimPopup(unread, onDismiss) {
  const existing = document.getElementById("claim-notif-popup-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "claim-notif-popup-overlay";
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5);
    z-index: 10000; display: flex; justify-content: center; align-items: center; padding: 16px;
  `;

  overlay.innerHTML = `
    <div style="background: #ffffff; width: 100%; max-width: 420px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.15); overflow: hidden;">
      <div style="padding: 18px 20px; border-bottom: 1px solid #f3f4f6; display: flex; justify-content: space-between; align-items: center; background: #f0fdf4;">
        <h3 style="margin: 0; font-size: 17px; color: #166534;">🔔 ${unread.length} item${unread.length > 1 ? "s" : ""} claimed!</h3>
        <button id="claim-notif-popup-close" style="background: none; border: none; font-size: 20px; cursor: pointer; color: #6b7280;">&times;</button>
      </div>
      <div style="max-height: 320px; overflow-y: auto;">
        ${unread.map(notifRow).join("")}
      </div>
      <div style="padding: 12px 16px; text-align: right; border-top: 1px solid #f3f4f6;">
        <button id="claim-notif-popup-dismiss" class="btn btn-primary btn-sm">Got it</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    if (onDismiss) onDismiss();
  };
  overlay.querySelector("#claim-notif-popup-close").addEventListener("click", close);
  overlay.querySelector("#claim-notif-popup-dismiss").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

// Persistent bell in the nav so someone can reopen their claim history
// after dismissing the popup, instead of it only ever appearing once.
function ensureBell(allNotifs) {
  const navActions = document.querySelector(".nav-actions");
  if (!navActions) return;

  let bell = document.getElementById("notif-bell-btn");
  if (!bell) {
    bell = document.createElement("button");
    bell.id = "notif-bell-btn";
    bell.className = "btn btn-outline btn-sm";
    bell.style.cssText = "position: relative; padding: 6px 10px;";
    navActions.insertBefore(bell, navActions.firstChild);
  }

  const unreadCount = allNotifs.filter((n) => !n.read).length;
  bell.innerHTML = `🔔${unreadCount > 0 ? `<span style="position:absolute; top:-4px; right:-4px; background:#dc2626; color:#fff; font-size:10px; font-weight:700; border-radius:999px; padding:1px 5px; line-height:1.4;">${unreadCount}</span>` : ""}`;

  bell.onclick = async () => {
    const panelExisting = document.getElementById("notif-panel");
    if (panelExisting) { panelExisting.remove(); return; }

    const panel = document.createElement("div");
    panel.id = "notif-panel";
    panel.style.cssText = `
      position: absolute; top: 56px; right: 16px; width: 340px; max-height: 400px; overflow-y: auto;
      background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.12); z-index: 9999;
    `;
    panel.innerHTML = allNotifs.length
      ? allNotifs.map(notifRow).join("")
      : `<p style="padding: 16px; font-size: 13px; color: #6b7280; margin: 0;">No notifications yet.</p>`;
    document.body.appendChild(panel);

    const unreadIds = allNotifs.filter((n) => !n.read).map((n) => n.id);
    await markNotificationsRead(unreadIds);
    allNotifs.forEach((n) => { n.read = true; });
    ensureBell(allNotifs);

    const closePanel = (e) => {
      if (!panel.contains(e.target) && e.target !== bell) {
        panel.remove();
        document.removeEventListener("click", closePanel);
      }
    };
    setTimeout(() => document.addEventListener("click", closePanel), 0);
  };
}

// Call once on any page with a nav bar and a logged-in user (currently
// home.html — the account dashboard). Fetches this user's notifications,
// pops up an alert for anything unread from a claim, and keeps a bell
// icon in the nav in sync so the history stays reachable afterwards.
export function initClaimNotifications() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    try {
      const all = await fetchNotificationsFor(user.uid);
      ensureBell(all);

      const unread = all.filter((n) => !n.read);
      if (unread.length > 0) {
        showClaimPopup(unread, async () => {
          await markNotificationsRead(unread.map((n) => n.id));
          unread.forEach((n) => { n.read = true; });
          ensureBell(all);
        });
      }
    } catch (err) {
      console.error("Failed to load notifications:", err);
    }
  });
}
