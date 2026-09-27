const MIN_METRES = 15;
const MIN_MS = 20000;

export function distanceMetres(a, b) {
  const earth = 6371000;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function alongTrail(pin, trail) {
  const spine = (trail || []).filter((point) => point && point.lat != null && point.lng != null);
  if (spine.length < 2 || !pin || pin.lat == null) return null;
  let best = 0;
  let bestDistance = Infinity;
  spine.forEach((point, index) => {
    const distance = distanceMetres(pin, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

export function orderEarlierNotes(items, trail) {
  return items
    .map((item) => ({
      ...item,
      along: alongTrail(item, trail) ?? item.at,
    }))
    .sort((a, b) => a.along - b.along || a.at - b.at);
}

export function clusterStops(items, metres = 40) {
  const stops = [];
  items.forEach((item) => {
    const current = stops[stops.length - 1];
    const anchor = current && current[current.length - 1];
    if (anchor && distanceMetres(anchor, item) <= metres) current.push(item);
    else stops.push([item]);
  });
  return stops;
}

export function nearestStopIndex(pin, stops) {
  if (!pin || !stops.length) return 0;
  let best = 0;
  let bestDistance = Infinity;
  stops.forEach((stop, index) => {
    stop.forEach((item) => {
      const distance = distanceMetres(pin, item);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
  });
  return best;
}

export function toPin(position) {
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
    at: position.timestamp || Date.now(),
  };
}

export function createTracker({ onPoint, onStatus }) {
  let watchId = null;
  let lastStored = null;
  let latest = null;

  function shouldStore(pin) {
    if (!lastStored) return true;
    const moved = distanceMetres(lastStored, pin) >= MIN_METRES;
    const aged = pin.at - lastStored.at >= MIN_MS;
    return moved || aged;
  }

  function consider(pin) {
    latest = pin;
    onStatus("fix");
    if (document.hidden || !shouldStore(pin)) return;
    if (onPoint(pin) === false) return;
    lastStored = pin;
  }

  function start() {
    if (!navigator.geolocation) {
      onStatus("unavailable");
      return;
    }
    if (watchId != null || document.hidden) return;
    onStatus(latest ? "fix" : "waiting");
    watchId = navigator.geolocation.watchPosition(
      (position) => consider(toPin(position)),
      (error) => {
        onStatus(error.code === 1 ? "denied" : "error");
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }

  function stop() {
    if (watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  function peek() {
    return latest;
  }

  function current() {
    if (latest && Date.now() - latest.at < 30000) {
      return Promise.resolve(latest);
    }
    if (!navigator.geolocation) return Promise.resolve(latest || null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (pin) => {
        if (settled) return;
        settled = true;
        resolve(pin || null);
      };
      const timer = setTimeout(() => finish(latest), 4000);
      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(timer);
          const pin = toPin(position);
          consider(pin);
          finish(pin);
        },
        () => {
          clearTimeout(timer);
          finish(latest);
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 3500 }
      );
    });
  }

  return { start, stop, current, peek };
}
