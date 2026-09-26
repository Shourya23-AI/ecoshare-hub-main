import { db } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, updateDoc, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getUnlockedTiers } from "./tiers.js";

// Checks which tier thresholds a user has crossed and, for any that aren't
// already recorded, writes a certificate doc (certificates/{uid}_{tier}) and
// marks it unlocked on the user's profile (users/{uid}.unlockedTiers). Safe
// to call every time impact.html loads — it's idempotent, so re-crossing an
// already-unlocked tier is a no-op.
export async function syncUnlockedCertificates(uid, userName, itemsShared) {
  const unlocked = getUnlockedTiers(itemsShared);
  if (unlocked.length === 0) return [];

  try {
    const userSnap = await getDoc(doc(db, "users", uid));
    const already = (userSnap.exists() && userSnap.data().unlockedTiers) || [];
    const newlyUnlocked = unlocked.filter((tier) => !already.includes(tier.name));

    for (const tier of newlyUnlocked) {
      const certId = `${uid}_${tier.name}`;
      await setDoc(doc(db, "certificates", certId), {
        uid,
        userName: userName || "EcoShare Helper",
        tierName: tier.name,
        icon: tier.icon,
        threshold: tier.threshold,
        unlockedAt: new Date(),
      });
    }

    if (newlyUnlocked.length > 0) {
      await updateDoc(doc(db, "users", uid), {
        unlockedTiers: arrayUnion(...newlyUnlocked.map((t) => t.name)),
      });
    }

    return unlocked;
  } catch (e) {
    console.error("Error syncing certificates:", e);
    return unlocked;
  }
}

// Draws a printable completion certificate onto a canvas and returns it.
function drawCertificate({ userName, tierName, icon, threshold }) {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 700;
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#f0fdf5";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Border
  ctx.strokeStyle = "#166534";
  ctx.lineWidth = 10;
  ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);
  ctx.strokeStyle = "#bbf7d0";
  ctx.lineWidth = 2;
  ctx.strokeRect(42, 42, canvas.width - 84, canvas.height - 84);

  ctx.textAlign = "center";

  // Eyebrow
  ctx.fillStyle = "#15803d";
  ctx.font = "600 16px Inter, sans-serif";
  ctx.fillText("ECOSHARE HUB · CERTIFICATE OF HELP", canvas.width / 2, 120);

  // Medal icon
  ctx.font = "80px sans-serif";
  ctx.fillText(icon, canvas.width / 2, 230);

  // Tier title
  ctx.fillStyle = "#14532d";
  ctx.font = "700 44px Georgia, serif";
  ctx.fillText(`${tierName} Helper`, canvas.width / 2, 300);

  // Body copy
  ctx.fillStyle = "#374151";
  ctx.font = "18px Inter, sans-serif";
  ctx.fillText("This certifies that", canvas.width / 2, 370);

  ctx.fillStyle = "#111827";
  ctx.font = "700 34px Georgia, serif";
  ctx.fillText(userName || "EcoShare Helper", canvas.width / 2, 425);

  ctx.fillStyle = "#374151";
  ctx.font = "18px Inter, sans-serif";
  ctx.fillText(
    `has shared ${threshold}+ items with their community, reducing waste`,
    canvas.width / 2, 470
  );
  ctx.fillText("and helping neighbors reuse what they no longer need.", canvas.width / 2, 496);

  // Date
  const dateStr = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  ctx.fillStyle = "#6b7280";
  ctx.font = "14px Inter, sans-serif";
  ctx.fillText(`Awarded ${dateStr}`, canvas.width / 2, 600);

  ctx.fillStyle = "#166534";
  ctx.font = "700 16px Inter, sans-serif";
  ctx.fillText("EcoShare Hub", canvas.width / 2, 640);

  return canvas;
}

function triggerDownload(canvas, tierName) {
  const link = document.createElement("a");
  link.download = `ecoshare-${tierName.toLowerCase()}-certificate.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

// Opens a lightbox with the certificate rendered full-size and a download
// button. Self-contained (builds its own DOM), so no extra markup is needed
// on the pages that call it.
export function openCertificateViewer({ userName, tierName, icon, threshold }) {
  const canvas = drawCertificate({ userName, tierName, icon, threshold });

  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(15,45,28,0.55); z-index: 10000;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  `;

  const panel = document.createElement("div");
  panel.style.cssText = `
    background: #fff; border-radius: 14px; padding: 20px; max-width: 640px; width: 100%;
    box-shadow: 0 20px 50px rgba(0,0,0,0.25);
  `;

  const previewImg = document.createElement("img");
  previewImg.src = canvas.toDataURL("image/png");
  previewImg.style.cssText = "width: 100%; border-radius: 8px; display: block; margin-bottom: 16px; border: 1px solid #e5e7eb;";

  const actions = document.createElement("div");
  actions.style.cssText = "display: flex; justify-content: flex-end; gap: 10px;";

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn-outline btn-sm";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => overlay.remove());

  const downloadBtn = document.createElement("button");
  downloadBtn.className = "btn btn-primary btn-sm";
  downloadBtn.textContent = "⬇ Download certificate";
  downloadBtn.addEventListener("click", () => triggerDownload(canvas, tierName));

  actions.appendChild(closeBtn);
  actions.appendChild(downloadBtn);
  panel.appendChild(previewImg);
  panel.appendChild(actions);
  overlay.appendChild(panel);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}

// Generates + immediately downloads, skipping the preview lightbox.
export function downloadCertificate({ userName, tierName, icon, threshold }) {
  const canvas = drawCertificate({ userName, tierName, icon, threshold });
  triggerDownload(canvas, tierName);
}
