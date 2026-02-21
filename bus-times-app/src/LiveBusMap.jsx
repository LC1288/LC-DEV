import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix marker icons
import icon2x from "leaflet/dist/images/marker-icon-2x.png";
import icon from "leaflet/dist/images/marker-icon.png";
import shadow from "leaflet/dist/images/marker-shadow.png";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: icon2x,
  iconUrl: icon,
  shadowUrl: shadow,
});

// HARD LOCK Peterborough center
const CENTER = [52.5726, -0.2439];

// HARD LOCK bbox
const BBOX = "52.50,52.65,-0.40,-0.10";

export default function LiveBusMap() {
  const [buses, setBuses] = useState([]);
  const [error, setError] = useState("");

  const url = useMemo(() => {
    return `http://localhost:3001/api/live-buses?bbox=${BBOX}&limit=80`;
  }, []);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const res = await fetch(url);
        const json = await res.json();

        if (!alive) return;

        setBuses(json.buses || []);
        setError("");
      } catch {
        if (!alive) return;
        setError("Failed to fetch");
        setBuses([]);
      }
    }

    load();

    const t = setInterval(load, 15000);

    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url]);

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        Live buses: {buses.length} {error && `• ${error}`}
      </div>

      <MapContainer
        center={CENTER}
        zoom={13}
        scrollWheelZoom={true}
        zoomControl={true}
        dragging={true}
        doubleClickZoom={true}
        style={{
          height: "420px",
          width: "100%",
          borderRadius: "12px",
        }}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {buses.map((b, i) => (
          <Marker key={i} position={[b.lat, b.lon]}>
            <Popup>
              <b>Route:</b> {b.routeId || "—"}<br/>
              <b>Vehicle:</b> {b.vehicleId || "—"}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </>
  );
}