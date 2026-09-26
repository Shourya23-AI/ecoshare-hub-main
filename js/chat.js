import { db, auth } from "./firebase-config.js";
import {
  collection, doc, addDoc, setDoc, getDoc, query, where,
  orderBy, onSnapshot, serverTimestamp, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { encryptForUser, decryptFromUser, initE2ee } from "./e2ee.js";

// See main.js for the full rationale — same escaping needed anywhere an
// item field (title/location/condition) is interpolated into innerHTML.
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Given a chat doc and "my" uid, returns the uid of whoever's on the other end.
export function otherParticipant(chat, myUid) {
  return (chat.participants || []).find((p) => p !== myUid) || null;
}

// Deterministic chat id so the owner and claimer always land in the same
// thread for a given item, however many times either of them opens it.
export function chatIdFor(itemId, uidA, uidB) {
  return `${itemId}_${[uidA, uidB].sort().join("_")}`;
}

// Creates the thread the first time either side opens it; reuses it after.
export async function getOrCreateChat(itemId, itemTitle, otherUid, otherName) {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be logged in to chat.");
  if (!otherUid) throw new Error("There's no one to chat with on this item yet.");

  const chatId = chatIdFor(itemId, user.uid, otherUid);
  const ref = doc(db, "chats", chatId);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      itemId,
      itemTitle: itemTitle || "",
      participants: [user.uid, otherUid],
      participantNames: {
        [user.uid]: user.displayName || user.email,
        [otherUid]: otherName || "Neighbor",
      },
      createdAt: serverTimestamp(),
      lastMessage: "",
      lastMessageAt: serverTimestamp(),
    });
  }
  return chatId;
}

export async function getChat(chatId) {
  const snap = await getDoc(doc(db, "chats", chatId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// End-to-end encrypted send: the message is encrypted in THIS browser for
// `otherUid` before it ever touches the network, so Firestore only ever
// stores ciphertext (cipher + iv), never the plaintext. `otherUid` must be
// supplied by the caller (chat.html knows it from the chat doc's
// `participants`) since a chat has exactly two people in it.
export async function sendMessage(chatId, text, otherUid) {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be logged in to chat.");
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  if (!otherUid) throw new Error("Couldn't tell who this chat is with.");

  const enc = await encryptForUser(otherUid, trimmed);
  if (!enc) {
    throw new Error(
      "The other person hasn't set up encrypted chat on their device yet — " +
      "ask them to open Messages once, then try sending again."
    );
  }

  await addDoc(collection(db, "chats", chatId, "messages"), {
    senderId: user.uid,
    cipher: enc.cipher,
    iv: enc.iv,
    createdAt: serverTimestamp(),
  });
  // The thread-list preview is encrypted the same way — never store the
  // plaintext preview outside the messages subcollection either.
  await updateDoc(doc(db, "chats", chatId), {
    lastMessageCipher: enc.cipher,
    lastMessageIv: enc.iv,
    lastMessage: null, // clear any legacy plaintext preview
    lastMessageAt: serverTimestamp(),
  });
}

// Decrypts one message doc for display. `otherUid` is whoever ELSE is in
// the chat (encryption is symmetric per-pair, so it's used both to decrypt
// messages they sent us and to re-derive the same key for our own sent
// messages). Falls back to legacy plaintext `text` for messages created
// before encryption was added, and to a placeholder if decryption fails.
export async function decryptMessage(msg, otherUid) {
  if (msg.cipher && msg.iv) {
    try {
      return await decryptFromUser(otherUid, msg.cipher, msg.iv);
    } catch (e) {
      return "🔒 Unable to decrypt (sent from a different device/browser)";
    }
  }
  return msg.text || "";
}

// Live message stream for one thread. Returns the unsubscribe function.
export function listenMessages(chatId, cb) {
  const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

// Live list of every thread the current user is part of, newest first.
// Returns the unsubscribe function. Falls back to an unordered,
// client-sorted query if the composite index for
// (participants array-contains, lastMessageAt desc) hasn't been created yet
// — without this fallback, a missing index makes the WHOLE inbox silently
// fail to load (this was one of the reasons "chats weren't working").
export function listenMyChats(cb) {
  const user = auth.currentUser;
  if (!user) return () => {};

  const fallback = () => {
    const q = query(collection(db, "chats"), where("participants", "array-contains", user.uid));
    return onSnapshot(
      q,
      (snap) => {
        const chats = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        chats.sort((a, b) => (b.lastMessageAt?.toMillis?.() || 0) - (a.lastMessageAt?.toMillis?.() || 0));
        cb(chats);
      },
      (err) => console.error("Chat list failed to load even without ordering:", err)
    );
  };

  try {
    const q = query(
      collection(db, "chats"),
      where("participants", "array-contains", user.uid),
      orderBy("lastMessageAt", "desc")
    );
    return onSnapshot(
      q,
      (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => {
        console.warn("Ordered chat query failed (likely a missing Firestore index), falling back:", err);
        fallback();
      }
    );
  } catch (e) {
    console.warn("Chat query threw synchronously, falling back:", e);
    return fallback();
  }
}

// UI Automation & Pickup Coordination Handler
document.addEventListener("DOMContentLoaded", async () => {
  const activeClaimItemId = sessionStorage.getItem('active_claim_item');

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    // Make sure this browser has an E2EE keypair (and has published its
    // public half) as early as possible on the Messages page.
    initE2ee(user.uid);

    // If redirected here after claiming an item, auto-initialize or open the chat thread.
    // Clear the flag right away so revisiting Messages later doesn't keep
    // re-showing the pickup banner and re-firing getOrCreateChat() on every
    // load — it should only fire once, immediately after the claim.
    if (activeClaimItemId) {
      sessionStorage.removeItem('active_claim_item');
      try {
        const itemSnap = await getDoc(doc(db, "items", activeClaimItemId));
        if (itemSnap.exists()) {
          const itemData = itemSnap.data();
          renderPickupBanner(itemData);

          // If the current user is NOT the owner, automatically establish a chat with the owner
          if (itemData.userId && itemData.userId !== user.uid) {
            await getOrCreateChat(
              activeClaimItemId, 
              itemData.title, 
              itemData.userId, 
              itemData.userEmail || "Item Owner"
            );
          }
        }
      } catch (err) {
        console.error("Error setting up claimed item chat:", err);
      }
    }
  });

  function renderPickupBanner(item) {
    const existingBanner = document.getElementById("pickup-coordination-banner");
    if (existingBanner) existingBanner.remove();

    const banner = document.createElement("div");
    banner.id = "pickup-coordination-banner";
    banner.style.cssText = `
      background: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 10px;
      margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.02);
    `;
    banner.innerHTML = `
      <h3 style="margin: 0 0 6px 0; font-size: 16px; color: #166534;">📦 Coordinating Pickup for: ${escapeHtml(item.title)}</h3>
      <p style="margin: 0 0 8px 0; font-size: 13px; color: #374151;">
        <strong>Pickup Location:</strong> ${escapeHtml(item.pickupLocation)} | <strong>Condition:</strong> ${escapeHtml(item.condition)}
      </p>
      <p style="margin: 0; font-size: 12px; color: #6b7280;">Send a message below to confirm a convenient time with your neighbor!</p>
    `;
    
    const mainContent = document.querySelector(".container") || document.body;
    mainContent.insertBefore(banner, mainContent.firstChild);
  }
});