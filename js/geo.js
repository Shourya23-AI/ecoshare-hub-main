// Best-effort browser geolocation for the item posting/claiming proximity
// guard. Geolocation is always opt-in and fails OPEN: if the browser
// doesn't support it, the user denies the permission prompt, or it times
// out, we simply return null and the caller skips the proximity check
// rather than blocking the action. This is a soft anti-abuse deterrent,
// not a hard guarantee — a determined user can still spoof their location.
export function getCurrentPositionSafe(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        done(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

// Haversine great-circle distance in meters between two {lat, lng} points.
export function distanceMeters(a, b) {
  if (!a || !b || typeof a.lat !== "number" || typeof b.lat !== "number") return null;
  const R = 6371000; // Earth's mean radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

// Claims made from within this many meters of the item's posted location
// are blocked — this is aimed at someone claiming their own listing from a
// second account (or a friend's account) just to farm donation stats.
export const MIN_CLAIM_DISTANCE_METERS = 10;
