// End-to-end encryption for chats.
//
// Each user gets a browser-generated ECDH (P-256) keypair the first time
// they use the app. The PUBLIC half is published to users/{uid}.publicKey
// so anyone can find it; the PRIVATE half never leaves the browser (it's
// kept in localStorage, never written to Firestore or anywhere else).
//
// When two people chat, each side runs ECDH between "my private key" and
// "their public key" to derive an AES-256-GCM key. Both sides land on the
// exact same AES key without ever transmitting it — that's what makes this
// end-to-end: Firestore (and anyone with access to the database, including
// an admin) only ever sees ciphertext, never the key or the plaintext.
//
// Honest limitation: the private key lives in *this browser's* localStorage.
// Open the same account in a different browser/device and it'll generate a
// new keypair there — that new browser can send/receive new messages fine,
// but can't retroactively decrypt messages tied to the old keypair. This is
// the standard trade-off of a no-backend, client-only E2EE setup (there's
// nowhere trusted to sync a private key to without weakening the "E2E" part).

import { db, auth } from "./firebase-config.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const EC_PARAMS = { name: "ECDH", namedCurve: "P-256" };
const privKeyStorageKey = (uid) => `ecoshare_e2ee_privkey_${uid}`;

const sharedKeyCache = new Map(); // otherUid -> CryptoKey (AES-GCM)
const publicKeyCache = new Map(); // uid -> ArrayBuffer (raw public key)

function bufToB64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Generates (once) and returns this browser's ECDH keypair for `uid`,
// publishing the public half to Firestore if it isn't there yet.
async function ensureKeyPair(uid) {
  if (!uid) return null;
  const stored = localStorage.getItem(privKeyStorageKey(uid));

  let keyPair;
  if (stored) {
    try {
      const jwk = JSON.parse(stored);
      const privateKey = await crypto.subtle.importKey("jwk", jwk, EC_PARAMS, true, ["deriveKey", "deriveBits"]);
      const publicJwk = { ...jwk };
      delete publicJwk.d;
      delete publicJwk.key_ops;
      const publicKey = await crypto.subtle.importKey("jwk", publicJwk, EC_PARAMS, true, []);
      keyPair = { privateKey, publicKey };
    } catch (e) {
      console.warn("Stored E2EE key was unreadable, generating a new one:", e);
    }
  }

  if (!keyPair) {
    keyPair = await crypto.subtle.generateKey(EC_PARAMS, true, ["deriveKey", "deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
    localStorage.setItem(privKeyStorageKey(uid), JSON.stringify(jwk));
  }

  // Publish/refresh the public key on the user's profile (best-effort —
  // don't block chat if this write fails for some reason).
  try {
    const rawPub = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const b64Pub = bufToB64(rawPub);
    const userRef = doc(db, "users", uid);
    const snap = await getDoc(userRef);
    if (!snap.exists() || snap.data().publicKey !== b64Pub) {
      await updateDoc(userRef, { publicKey: b64Pub });
    }
  } catch (e) {
    console.warn("Failed to publish E2EE public key:", e);
  }

  return keyPair;
}

async function getMyKeyPair() {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be logged in to use encrypted chat.");
  return ensureKeyPair(user.uid);
}

async function fetchPublicKeyRaw(uid) {
  if (publicKeyCache.has(uid)) return publicKeyCache.get(uid);
  const snap = await getDoc(doc(db, "users", uid));
  const b64 = snap.exists() ? snap.data().publicKey : null;
  if (!b64) return null;
  const raw = b64ToBuf(b64);
  publicKeyCache.set(uid, raw);
  return raw;
}

// Derives (and caches) the shared AES-GCM key for a chat with `otherUid`.
// Returns null if the other person hasn't published a public key yet (e.g.
// they've genuinely never opened the app since this feature shipped) — in
// that case the caller should fall back to a "waiting on the other person"
// message rather than sending anything.
export async function getSharedKey(otherUid) {
  if (sharedKeyCache.has(otherUid)) return sharedKeyCache.get(otherUid);

  const myKeyPair = await getMyKeyPair();
  const otherRaw = await fetchPublicKeyRaw(otherUid);
  if (!otherRaw) return null;

  const otherPublicKey = await crypto.subtle.importKey("raw", otherRaw, EC_PARAMS, true, []);
  const aesKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: otherPublicKey },
    myKeyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  sharedKeyCache.set(otherUid, aesKey);
  return aesKey;
}

// Encrypts `text` for `otherUid`. Returns { cipher, iv } (both base64) ready
// to store on a Firestore document, or null if no shared key could be
// derived yet.
export async function encryptForUser(otherUid, text) {
  const key = await getSharedKey(otherUid);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return { cipher: bufToB64(cipherBuf), iv: bufToB64(iv.buffer) };
}

// Decrypts a { cipher, iv } pair that was encrypted for the current user by
// `otherUid`. Throws if the shared key can't be derived or decryption fails
// (wrong/rotated key) — callers should catch and show a placeholder.
export async function decryptFromUser(otherUid, cipherB64, ivB64) {
  const key = await getSharedKey(otherUid);
  if (!key) throw new Error("No shared key yet");
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(b64ToBuf(ivB64)) },
    key,
    b64ToBuf(cipherB64)
  );
  return new TextDecoder().decode(plainBuf);
}

// Called on every page load (once a user is signed in) so a public key
// exists as early as possible — otherwise the FIRST message someone tries
// to send them could have no public key to encrypt against yet.
export async function initE2ee(uid) {
  try {
    await ensureKeyPair(uid);
  } catch (e) {
    console.warn("E2EE init failed:", e);
  }
}
