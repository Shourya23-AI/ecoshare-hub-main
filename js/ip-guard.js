// Best-effort IP banning for a client-only (no backend server) app.
//
// IMPORTANT LIMITATION: Firestore Security Rules have no concept of the
// caller's real network IP address — there is no `request.ip` in the rules
// language. So this can't be enforced the way a real server-side IP ban
// would be. What we do instead: ask a public "what's my IP" API what
// address the browser is calling from, record it on the user's profile at
// login, and check it against an admin-maintained `bannedIPs` collection
// at login/signup and on every page load. This deters casual ban-evasion
// (spinning up a second account from the same home wifi) but can be
// bypassed by a VPN, mobile data, or another network — it's a speed bump,
// not a lock.
import { db } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, deleteDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const IP_ENDPOINTS = [
  "https://api.ipify.org?format=json",
  "https://api64.ipify.org?format=json",
];

// Looks up the browser's current public IP via a third-party echo service.
// Returns null (fail open — never blocks on lookup failure) if every
// endpoint fails or times out.
export async function getPublicIp() {
  for (const url of IP_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.ip) return data.ip;
    } catch (e) {
      // try the next endpoint
    }
  }
  return null;
}

export async function isIpBanned(ip) {
  if (!ip) return false;
  try {
    const snap = await getDoc(doc(db, "bannedIPs", ip));
    return snap.exists();
  } catch (e) {
    return false; // fail open
  }
}

// Records the caller's current public IP on their profile (best-effort,
// silent on failure) so an admin can see and, if needed, ban it later from
// the user editor in admin.html.
export async function recordLoginIp(uid) {
  const ip = await getPublicIp();
  if (!ip) return null;
  try {
    await updateDoc(doc(db, "users", uid), { lastKnownIp: ip });
  } catch (e) {
    // Non-fatal — the login itself should still succeed even if this fails.
  }
  return ip;
}

export async function banIp(ip, reason, adminUid) {
  await setDoc(doc(db, "bannedIPs", ip), {
    ip,
    reason: reason || "",
    bannedAt: new Date(),
    bannedByUid: adminUid || null,
  });
}

export async function unbanIp(ip) {
  await deleteDoc(doc(db, "bannedIPs", ip));
}
