# EcoShare Hub

Plain HTML/CSS/JS build matching the Figma design, wired up to Firebase
(Auth + Firestore + Storage). No build tools, no npm — open it and go.

## 1. Open in VS Code
Unzip this folder, open it in VS Code, and install the **Live Server**
extension (Ritwick Dey) if you don't have it. Right-click `index.html` →
"Open with Live Server". `index.html` is now the **welcome/landing page**
— a glimpse of the app with Sign in / Sign up buttons. The site works
without Firebase configured — it falls back to demo data everywhere,
and you can click "Continue as guest" to skip straight into the app
without an account.

## 2. Connect Firebase (for real accounts, listings, and photos)
1. Go to https://console.firebase.google.com → **Add project**.
2. Inside the project, click **Add app → Web (</>)** and copy the config object.
3. Paste it into `js/firebase-config.js`, replacing the placeholder values.
4. In the Firebase console, enable:
   - **Authentication → Sign-in method → Email/Password**
   - **Firestore Database → Create database** (start in production mode)
   - **Storage → Get started**
5. In Firestore, go to **Rules** and paste in the contents of `firestore.rules`.
6. In Storage, go to **Rules** and paste in the contents of `storage.rules`.

That's it — refresh the page, sign up for an account, and posting/claiming
items will now persist for real.

## Project structure
```
index.html            Welcome / landing page — glimpse of the app, Sign in + Sign up
home.html              Home + Browse listings (the actual app, was index.html)
impact.html            My Impact (helper tier, progress, certificate)
leaderboard.html       Community Leaderboard
login.html             Sign up / log in (reads ?mode=signup|login and ?next=<page>)
chat.html               Messages — per-item chat between an item's owner and claimer
admin.html              Admin console — locked to one email, see below
css/style.css          All styling (colors, cards, badges, modal, landing page, chat, admin)
js/firebase-config.js  Your Firebase keys, helper-tier thresholds, ADMIN_EMAIL
js/auth.js             Sign up / log in / log out / nav pill / page guard / guest mode
js/items.js            Post item, claim item, fetch listings, leaderboard
js/main.js             Renders cards/rows into the pages, modal + toast logic, wires up chat buttons
js/chat.js              Create/read/send chat threads (Firestore-backed, live updates)
js/admin.js             Admin-only data ops: fetch/edit/delete any listing or user
firestore.rules        Firestore security rules (users, items, chats, admin lock)
storage.rules          Storage security rules
```

## Admin console
There's only **one** login page for everyone — `login.html`. Which space
you land in after signing in depends on whose account it is, not on a
separate admin form:

```js
// js/firebase-config.js
export const ADMIN_EMAIL = "shouryaupadhyay50@gmail.com";
```

- Sign in (or sign up, the first time) on `login.html` with that email,
  and you're sent to `admin.html`.
- Any other account is sent to `home.html` as usual.

The first time, use the normal **"Create an account"** link on the login
page with the admin email and whatever password you want — that's it,
there's nothing to configure or "add later." Firebase Auth stores that
password itself, hashed — this app (and its admin console) never sees or
saves the raw password anywhere, including in this codebase.

The lock is enforced **twice**: the login page only routes that one email
to `admin.html`, and — this is the part that actually matters — Firestore
itself refuses to mark any *other* account as admin (`firestore.rules`
checks the sign-in token's email server-side), so it holds even if
someone edits the page or calls Firestore directly. `admin.html` also
isn't linked from the regular nav, and if a signed-in non-admin visits it
directly, they're redirected straight back to `home.html`.

Once in, the console lists every listing (inline status edit + delete)
and every member. It reads real data from Firestore, so it needs Firebase
configured (step 2 above) to show anything.

**Full admin powers, for beta testing:** click any username (or "Edit") in
the Users tab to open a profile editor where you can:
- Rewrite a user's `itemsShared` / `itemsClaimed` / CO₂-saved stats
  directly — `itemsShared` is what drives their medal tier, leaderboard
  rank, and certificate unlocks, so bumping it up fast-forwards a test
  account through Bronze → Diamond without actually posting 100 items.
- Manually unlock or revoke any of the 5 tier certificates for that user,
  independent of their real donation count.
- Ban / unban a user. A banned user can still browse and read past chats,
  but Firestore itself refuses their new item posts, claims, and chat
  messages (enforced in `firestore.rules`, not just hidden in the UI).
- Promote/revoke admin rights (unchanged from before).
- Delete a user's Firestore profile (wipes their stats/tier/admin rights;
  their login itself still exists — deleting a Firebase Auth account
  requires the Admin SDK, which only runs server-side).
- Click a listing's Owner UID to jump straight to that owner's profile.

`admin-dashboard.html` (an older, separate console) now just redirects to
`admin.html` — everything lives in one place.

### IP banning (best-effort)
This is a static frontend + Firestore app with no backend server, and
Firestore Security Rules have no way to see a request's real network IP —
there's no `request.ip` in the rules language. So IP banning here is a
**deterrent, not a guarantee**: the client asks a public "what's my IP"
service (ipify) for its own address, records it on the user's profile at
every login (`users/{uid}.lastKnownIp`), and checks it against an
admin-maintained `bannedIPs` collection at login/signup and on every page
load. An admin bans an IP from the same "Edit User" panel described above.
It stops the casual case (banning someone, then them just signing up again
from the same home wifi) but a VPN or a different network gets around it.

### Claim proximity guard (anti self-dealing)
When someone posts an item, the browser's Geolocation API (if the person
allows it) stores a `location: {lat, lng}` on the item. When someone tries
to claim it, their current location is compared against that — if they're
within 10 meters of where it was posted, the claim is blocked with an
explanation, since that pattern (claim your own listing from a second
account) is the easiest way to farm fake donation stats/medals. This is
opt-in and fails open on both ends: if either side's location isn't
available (permission denied, unsupported browser, or an older item posted
before this existed), the check is simply skipped rather than blocking a
legitimate claim. Like the IP check, this is a soft deterrent — a
determined user can still spoof browser geolocation — so an admin can
always override a wrongly-blocked claim via the "Force Claim" status
toggle in the Listings tab.

## Messages
Once an item is claimed, a **💬 Chat** button appears on that item's card
for both the owner and the claimer (nobody else sees it). It opens
`chat.html`, a private thread scoped to just those two people — enforced
in `firestore.rules` so no one else can read or write into it. Each item
gets its own thread per pair of people, so old conversations stay
separated by item.

## How the sign-in flow works
`index.html` is the entry point. It shows a hero, a live preview of a few
listings, feature highlights, and "Sign in" / "Sign up" buttons that go to
`login.html?mode=...`. After a successful sign up or log in, `login.html`
checks whether that account's email matches `ADMIN_EMAIL`: the admin
account is sent to `admin.html`, everyone else to `home.html` (or
wherever `?next=` pointed, e.g. after being bounced from a guarded page).
`home.html`, `impact.html`, `leaderboard.html`, and `chat.html` all call
`guardPage()` from `js/auth.js` on load — if nobody is signed in (and
they haven't clicked "Continue as guest"), they're bounced back to
`index.html`. `admin.html` calls the stricter `guardAdminPage()` instead,
which requires the admin account specifically. Guest mode is stored in
`sessionStorage` so people can preview the app without configuring
Firebase; it's cleared on logout.

## Data model
- **users/{uid}**: `name, email, building, itemsShared, itemsClaimed, co2SavedKg`
- **items/{id}**: `title, category, condition, quantity, availableUntil, pickupLocation, description, photoURL, status, ownerId, ownerName, claimedBy?`

## Helper tiers (Certificate of Help system)
Thresholds live in `js/firebase-config.js` → `TIERS`. Tier is derived live
from `itemsShared`, so it updates automatically as someone posts more items.
The **Download certificate** button on `impact.html` is stubbed — wire it to
a PDF library like [jsPDF](https://github.com/parallax/jsPDF) (client-side)
or a Firebase Cloud Function (server-side, better for tamper-proof certs).

## Next steps you'll likely want
- An item-detail page (`item.html?id=...`) for a full listing view
- A Cloud Function to auto-expire food items past their `availableUntil`
- The 60-minute Gold/Platinum priority window (currently just a UI badge —
  needs a `priorityUntil` timestamp check before non-priority users can claim)





## Things That will be added:-
 #fix the item posting table by keeping different time limits for food and other items and keeping the food limit for 2 hrs and other items max limit for posting for 5days and they get removed #Identity verification using an ai 
 #Also phonemumber and email id verification
 #Item verification using ai if it's real or not 
 #No of of posing according to number of items like if there are 2 items there will be 2 posting so 2 different people can get it 
 #A highly secure system so noone can bypass it to fool people or get personal data
 #lag free website and market it around colleges and unis as there will be the most students
 #make it completely free but adding ads at the sides so the cost of hosting and all come into account 
 #forget password option through OTP by email or phone number 
 #Admin should have the access to change the item from claimed to unclaimed,admin must have the access to ban a id,ip. Admin also must have the access to unban id and ip 
 #a report system which automatically bans certain person from posting and recieving items and the banned person gets a option to appeal to a admin to get unban by proving they weren't misusing