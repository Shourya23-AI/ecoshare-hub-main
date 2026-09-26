import { guardAdminPage, logOut } from "./auth.js";
import { db, ADMIN_EMAIL } from "./firebase-config.js";
import { collection, getDocs, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Purge Feature Restriction: the permanent/primary admin account is the
// highest-value credential in the system, so the irreversible bulk "Purge"
// action is disabled for it specifically. Any promoted admin account can
// still purge listings; this only protects the one account everyone else's
// admin access is rooted in.
const PURGE_RESTRICTED_EMAIL = ADMIN_EMAIL;

let currentAdminEmail = null;

document.addEventListener("DOMContentLoaded", () => {
  // Guard ensures non-admins are immediately booted out
  guardAdminPage((user) => {
    const emailTag = document.getElementById("admin-user-email");
    if (emailTag) emailTag.textContent = `Logged in as: ${user.email}`;
    currentAdminEmail = (user.email || "").toLowerCase();
    initDashboard();
  });

  // Logout handler
  const logoutBtn = document.getElementById("admin-logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await logOut();
      window.location.href = "login.html";
    });
  }

  // Sidebar view switching
  const menuButtons = document.querySelectorAll(".sidebar-link[data-section]");
  menuButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      menuButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const targetId = btn.getAttribute("data-section");
      document.querySelectorAll(".admin-workspace-pane").forEach(pane => {
        pane.style.display = pane.id === targetId ? "block" : "none";
      });

      const titleMap = {
        "overview-section": "System Overview",
        "listings-section": "Content Moderation",
        "users-section": "User Permissions"
      };
      document.getElementById("section-title").textContent = titleMap[targetId] || "Dashboard";
    });
  });
});

async function initDashboard() {
  // Load background collections specifically for the admin panel
  loadAdminListings();
}

async function loadAdminListings() {
  const container = document.getElementById("admin-listings-target");
  if (!container) return;

  const purgeRestricted = currentAdminEmail === PURGE_RESTRICTED_EMAIL;

  try {
    const snapshot = await getDocs(collection(db, "items"));
    if (snapshot.empty) {
      container.innerHTML = "<p>No listings active on platform.</p>";
      return;
    }

    let html = `<ul style="list-style: none; padding: 0;">`;
    if (purgeRestricted) {
      html += `
        <li style="padding: 10px 0; color: #fbbf24; font-size: 0.85rem;">
          🔒 Purge is disabled for the permanent admin account (${PURGE_RESTRICTED_EMAIL}). Use a secondary admin account to purge listings.
        </li>`;
    }
    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      html += `
        <li style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #334155;">
          <span><strong>${data.title || 'Untitled'}</strong> (${data.building || 'General'})</span>
          <button class="btn-admin-action delete-listing-btn" data-id="${docSnap.id}"
            style="background: ${purgeRestricted ? '#6b7280' : '#f87171'}; color: #fff; ${purgeRestricted ? 'cursor: not-allowed; opacity: 0.6;' : ''}"
            ${purgeRestricted ? 'disabled title="Purge is disabled for the permanent admin account"' : ''}>
            Purge
          </button>
        </li>`;
    });
    html += `</ul>`;
    container.innerHTML = html;

    // Attach purge bindings — never wired up at all when purge is restricted,
    // so the feature is fully disabled rather than just visually greyed out.
    if (!purgeRestricted) {
      container.querySelectorAll(".delete-listing-btn").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          const id = e.target.getAttribute("data-id");
          if (confirm("Permanently purge this item from the database?")) {
            await deleteDoc(doc(db, "items", id));
            loadAdminListings();
          }
        });
      });
    }
  } catch (err) {
    container.innerHTML = "<p style='color: #f87171;'>Failed to load database items.</p>";
  }
}