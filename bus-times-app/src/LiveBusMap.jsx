import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const CENTER = [52.5726, -0.2439];

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Non-JSON response (${res.status}). First 140 chars:\n${text.slice(0, 140)}`
    );
  }
}

export default function LiveBusMap({ limit = 80, radiusKm = 15 }) {
  const [vehicles, setVehicles] = useState([]);
  const [err, setErr] = useState("");

  const url = useMemo(() => {
    const [lat, lon] = CENTER;
    // IMPORTANT: relative /api so Vite proxy applies
    return `/api/vehicles?lat=${lat}&lon=${lon}&radius_km=${radiusKm}&limit=${limit}`;
  }, [limit, radiusKm]);

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch(url);
        const json = await safeJson(res);
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);

        const list = Array.isArray(json?.vehicles) ? json.vehicles : [];
        if (!alive) return;

        setVehicles(list);
        setErr("");
      } catch (e) {
        if (!alive) return;
        setVehicles([]);
        setErr(e?.message || "Failed to load vehicles");
      }
    };

    tick();
    const t = setInterval(tick, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url]);

  return (
    <div>
      <div style={{ marginTop: 10, marginBottom: 8, opacity: 0.85 }}>
        Live buses: {vehicles.length}
        {err ? <span style={{ color: "#ff6b6b" }}> • {err}</span> : null}
      </div>

      <MapContainer
        center={CENTER}
        zoom={12}
        style={{ height: 420, width: "100%", borderRadius: 14, overflow: "hidden" }}
      >
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {vehicles.map((v, idx) => {
          if (typeof v.lat !== "number" || typeof v.lon !== "number") return null;
          const key = v.vehicleId || `${v.lat},${v.lon},${idx}`;

          return (
            <Marker key={key} position={[v.lat, v.lon]}>
              <Popup>
                <div style={{ fontSize: 12, lineHeight: 1.35 }}>
                  <div><b>Vehicle:</b> {v.vehicleId || "—"}</div>
                  <div><b>Route:</b> {v.routeId || "—"}</div>
                  <div><b>Trip:</b> {v.tripId || "—"}</div>
                  <div>
                    <b>Updated:</b>{" "}
                    {v.timestamp ? new Date(v.timestamp * 1000).toLocaleTimeString() : "—"}
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}