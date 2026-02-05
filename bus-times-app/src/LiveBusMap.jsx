import React, { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";

// Fix default marker icon paths (Vite + Leaflet)
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const PETERBOROUGH_CENTER = [52.572, -0.242];

function fmtTime(ts) {
  if (!ts) return "unknown";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
}

export default function LiveBusMap() {
  const [buses, setBuses] = useState([]);
  const [error, setError] = useState("");

  // bbox: south,north,west,east
  const bbox = useMemo(() => "52.50,52.65,-0.40,-0.10", []);

  async function load() {
    try {
      setError("");
      const r = await fetch(`http://localhost:3001/api/live-buses?bbox=${bbox}`);
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Failed to load live buses");
      setBuses(data.buses || []);
    } catch (e) {
      setError(e.message || String(e));
      setBuses([]);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ width: "100%" }}>
      <div style={{ marginBottom: 10, opacity: 0.9 }}>
        <div>
          <b>Live buses:</b> {buses.length}
        </div>
        {error ? <div style={{ color: "tomato" }}>{error}</div> : null}
      </div>

      <MapContainer center={PETERBOROUGH_CENTER} zoom={13} style={{ width: "100%" }}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />

        {buses.map((b, idx) => (
          <Marker
            // unique key even if vehicleId repeats
            key={`${b.vehicleId || "noid"}-${b.tripId || "notrip"}-${b.routeId || "noroute"}-${idx}`}
            position={[b.lat, b.lon]}
          >
            <Popup>
              <div style={{ minWidth: 220 }}>
                <div>
                  <b>Vehicle:</b> {b.vehicleId || "unknown"}
                </div>
                <div>
                  <b>Route:</b> {b.routeId || "unknown"}
                </div>
                <div>
                  <b>Trip:</b> {b.tripId || "unknown"}
                </div>
                <div>
                  <b>Updated:</b> {fmtTime(b.timestamp)}
                </div>
                <div>
                  <b>Bearing:</b> {b.bearing ?? "n/a"}
                </div>
                <div>
                  <b>Speed:</b> {b.speed ?? "n/a"}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}

