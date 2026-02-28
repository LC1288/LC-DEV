// src/LiveBusMap.jsx
import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix default marker icons in Vite
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// Peterborough bbox + center
const DEFAULT_BBOX = "52.50,52.65,-0.40,-0.10"; // minLat,maxLat,minLon,maxLon
const CENTER = [52.5726, -0.2439];

export default function LiveBusMap({ limit = 80 }) {
  const [buses, setBuses] = useState([]);
  const [err, setErr] = useState("");

  const url = useMemo(() => {
    return `http://localhost:3001/api/live-buses?bbox=${encodeURIComponent(
      DEFAULT_BBOX
    )}&limit=${encodeURIComponent(limit)}`;
  }, [limit]);

  useEffect(() => {
    let alive = true;

    async function tick() {
      try {
        const res = await fetch(url);

        // Read raw body first so we can show useful errors (HTML, 404 page, etc.)
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(
            `Non-JSON response (${res.status}). First bytes: ${text.slice(0, 140)}`
          );
        }

        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        if (!alive) return;

        // Backend should return: { ok:true, count, buses:[...] }
        // But allow fallback shapes just in case.
        const busesArr =
          Array.isArray(json?.buses) ? json.buses : Array.isArray(json) ? json : [];

        setBuses(busesArr);
        setErr("");
      } catch (e) {
        if (!alive) return;
        setErr(e?.message || "Failed to load live buses");
        setBuses([]);
      }
    }

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
        Live buses: {buses.length}
        {err ? (
          <span style={{ color: "#ff6b6b" }}> • {err}</span>
        ) : null}
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

        {buses.map((b) => (
          <Marker
            key={b.vehicleId || `${b.lat},${b.lon}`}
            position={[b.lat, b.lon]}
          >
            <Popup>
              <div style={{ fontSize: 12, lineHeight: 1.35 }}>
                <div>
                  <b>Vehicle:</b> {b.vehicleId || "—"}
                </div>
                <div>
                  <b>Route:</b> {b.routeId || "—"}
                </div>
                <div>
                  <b>Trip:</b> {b.tripId || "—"}
                </div>
                <div>
                  <b>Updated:</b>{" "}
                  {b.timestamp
                    ? new Date(b.timestamp * 1000).toLocaleTimeString()
                    : "—"}
                </div>
                <div>
                  <b>Bearing:</b> {b.bearing ?? "—"}
                </div>
                <div>
                  <b>Speed:</b> {b.speed ?? "—"}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}