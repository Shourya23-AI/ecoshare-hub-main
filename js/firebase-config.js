import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyAViu1MilSQI0rwFyMOMewWzQJ5zuNL1eo",
  authDomain: "ecoshare-547fa.firebaseapp.com",
  projectId: "ecoshare-547fa",
  storageBucket: "ecoshare-547fa.firebasestorage.app",
  messagingSenderId: "591311439371",
  appId: "1:591311439371:web:b8ad3a7a65c0ea300ea90e",
  measurementId: "G-8C34QQLYE0"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
// Used to upload item photos to Storage (see storage.rules — items/{uid}/**).
export const storage = getStorage(app);
export const ADMIN_EMAIL = "shadow@ecoshare.com";

// Donation milestone tiers. "Donations" = items a user has shared
// (users/{uid}.itemsShared), tracked live as they post items that get
// claimed by neighbors. Order matters — lowest threshold first.
export const TIERS = [
  { name: "Bronze",   icon: "🥉", threshold: 5,   badgeClass: "badge-bronze" },
  { name: "Silver",   icon: "🥈", threshold: 15,  badgeClass: "badge-silver" },
  { name: "Gold",     icon: "🥇", threshold: 25,  badgeClass: "badge-gold" },
  { name: "Platinum", icon: "💎", threshold: 40,  badgeClass: "badge-platinum" },
  { name: "Diamond",  icon: "💠", threshold: 100, badgeClass: "badge-diamond" },
];