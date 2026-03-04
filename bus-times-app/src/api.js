const API_BASE =
  import.meta.env.MODE === "development"
    ? "" // use Vite proxy: /api -> http://localhost:3001
    : ""; // in production you’ll host the API behind same domain or set a full URL

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `API did not return JSON (status ${res.status}). First 120 chars:\n` +
        text.slice(0, 120)
    );
  }
}

export async function searchStops(q) {
  const res = await fetch(`${API_BASE}/api/stops?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Stops request failed: ${res.status}`);
  return safeJson(res);
}

export async function getDepartures(lat, lon) {
  const res = await fetch(`${API_BASE}/api/departures?lat=${lat}&lon=${lon}`);
  if (!res.ok) throw new Error(`Departures request failed: ${res.status}`);
  return safeJson(res);
}

export async function getVehicles(lat, lon, radiusKm = 15) {
  const res = await fetch(
    `${API_BASE}/api/vehicles?lat=${lat}&lon=${lon}&radius_km=${radiusKm}`
  );
  if (!res.ok) throw new Error(`Vehicles request failed: ${res.status}`);
  return safeJson(res);
}