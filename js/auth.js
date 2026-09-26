import { auth, db, ADMIN_EMAIL } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { recordLoginIp, isIpBanned } from "./ip-guard.js";

// List of automatic administrator emails. Sourced from firebase-config.js's
// ADMIN_EMAIL so there's exactly one place to change it (kept as a list here
// since syncAdminPrivileges() below checks membership, and this leaves room
// to add more auto-admin emails later).
const ADMIN_EMAILS = [ADMIN_EMAIL];

// Records the current IP on the user's profile and, if it's on the admin
// ban list, signs them straight back out. Called right after every
// sign-up/login, and again on every page load via guardPage/guardAdminPage
// so a session that was already open when the ban was applied gets kicked
// out on its next request too — not just future logins.
async function enforceIpGate(user) {
  if (!user) return;
  const ip = await recordLoginIp(user.uid);
  if (ip && await isIpBanned(ip)) {
    await signOut(auth);
    throw new Error("This device/network has been blocked by an admin and can't access EcoShare Hub.");
  }
}

export async function syncAdminPrivileges(user) {
  if (!user || !user.email) return false;
  const email = user.email.toLowerCase();
  
  // Ensure the user profile exists in the Firestore `users` collection on every auth sync/login
  try {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      await setDoc(userRef, {
        name: user.displayName || email.split("@")[0],
        email: user.email,
        building: "General",
        itemsShared: 0,
        itemsClaimed: 0,
        co2SavedKg: 0,
        createdAt: serverTimestamp(),
      });
    }
  } catch (e) {
    console.error("Error ensuring user profile exists:", e);
  }
  
  if (ADMIN_EMAILS.includes(email)) {
    try {
      await setDoc(doc(db, "admins", user.uid), {
        email: user.email,
        autoGranted: true,
        updatedAt: serverTimestamp()
      }, { merge: true });
      return true;
    } catch (e) {
      console.error("Error syncing admin privileges:", e);
    }
  }
  
  try {
    const adminSnap = await getDoc(doc(db, "admins", user.uid));
    return adminSnap.exists();
  } catch (e) {
    return false;
  }
}

export async function isAdminUser(user) {
  return await syncAdminPrivileges(user);
}

export async function signUp({ name, email, password, building }) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  try {
    await setDoc(doc(db, "users", cred.user.uid), {
      name: name || email.split("@")[0],
      email,
      building: building || "",
      itemsShared: 0,
      itemsClaimed: 0,
      co2SavedKg: 0,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.error("Error creating user profile:", e);
  }
  
  // Provision admin rights if email matches the auto-admin list
  await syncAdminPrivileges(cred.user);
  await enforceIpGate(cred.user);
  return cred.user;
}

export async function logIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  // Ensure user document and admin privileges are synced on login
  await syncAdminPrivileges(cred.user);
  await enforceIpGate(cred.user);
  return cred.user;
}

export async function logOut() {
  return await signOut(auth);
}

export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

const GUEST_KEY = "eshGuest";
export function enterGuestMode() { sessionStorage.setItem(GUEST_KEY, "1"); }
export function isGuest() { return sessionStorage.getItem(GUEST_KEY) === "1"; }

export function guardPage(onAuth) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        await enforceIpGate(user);
      } catch (e) {
        // IP was banned after this session started — enforceIpGate already
        // signed them out; just bounce them to login with a clear reason.
        window.location.href = "login.html?blocked=ip";
        return;
      }
    } else if (!isGuest()) {
      // Not logged in and never clicked "continue as guest" — bounce to
      // the landing page instead of letting the protected page render.
      window.location.href = "index.html";
      return;
    }
    if (onAuth) {
      onAuth(user);
    }
  });
}

export function guardAdminPage(onAdmin) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "login.html?next=admin.html";
    } else {
      try {
        await enforceIpGate(user);
      } catch (e) {
        window.location.href = "login.html?blocked=ip";
        return;
      }
      const authorized = await isAdminUser(user);
      if (!authorized) {
        window.location.href = "home.html";
      } else if (onAdmin) {
        onAdmin(user);
      }
    }
  });
}