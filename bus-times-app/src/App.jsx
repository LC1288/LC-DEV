import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

/** Fix default Leaflet marker icons in Vite */
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow
});

function useDebounce(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export default function App() {
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 250);

  const [stopLoading, setStopLoading] = useState(false);
  const [stopError, setStopError] = useState("");
  const [stops, setStops] = useState([]);
  const [selected, setSelected] = useState(null);

  const [busLoading, setBusLoading] = useState(false);
  const [busError, setBusError] = useState("");
  const [buses, setBuses] = useState([]);

  // tracking lines (breadcrumb trails)
  const [tracks, setTracks] = useState({});
  const trackRef = useRef({});

  const mapRef = useRef(null);

  // SEARCH STOPS
  useEffect(() => {
    const q = debounced.trim();
    if (!q) {
      setStops([]);
      setStopError("");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setStopLoading(true);
        setStopError("");
        const r = await fetch(`/api/stops?q=${encodeURIComponent(q)}&limit=50`);
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data?.error || `Stops failed (${r.status})`);
        if (!cancelled) setStops(data.items || []);
      } catch (e) {
        if (!cancelled) setStopError(String(e.message || e));
      } finally {
        if (!cancelled) setStopLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [debounced]);

  // LIVE BUSES POLL + build tracks
  useEffect(() => {
    let cancelled = false;

    async function loadBuses() {
      try {
        setBusLoading(true);
        setBusError("");
        const r = await fetch(`/api/live-buses`);
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data?.error || `Live buses failed (${r.status})`);

        if (!cancelled) {
          const nextBuses = data.items || [];
          setBuses(nextBuses);

          const prev = trackRef.current;
          const updated = { ...prev };

          for (const b of nextBuses) {
            const id = b.id;
            const point = [b.lat, b.lon];

            if (!updated[id]) updated[id] = [];

            const last = updated[id][updated[id].length - 1];
            const moved =
              !last ||
              Math.abs(last[0] - point[0]) > 0.00005 ||
              Math.abs(last[1] - point[1]) > 0.00005;

            if (moved) {
              updated[id] = [...updated[id], point].slice(-25);
            }
          }

          // cleanup: keep only tracks for buses currently in feed
          const liveIds = new Set(nextBuses.map((b) => b.id));
          for (const id of Object.keys(updated)) {
            if (!liveIds.has(id)) delete updated[id];
          }

          trackRef.current = updated;
          setTracks(updated);
        }
      } catch (e) {
        if (!cancelled) setBusError(String(e.message || e));
      } finally {
        if (!cancelled) setBusLoading(false);
      }
    }

    loadBuses();
    const t = setInterval(loadBuses, 10000);

    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Filter buses near selected stop (default radius 1.5km)
  const radiusKm = 1.5;

  const nearbyBuses = useMemo(() => {
    if (!selected) return buses;
    return buses.filter((b) => {
      const d = haversineKm(selected.lat, selected.lon, b.lat, b.lon);
      return d <= radiusKm;
    });
  }, [buses, selected]);

  function selectStop(s) {
    setSelected(s);
    if (mapRef.current) {
      mapRef.current.setView([s.lat, s.lon], 14, { animate: true });
    }
  }

  function clearSelection() {
    setSelected(null);
    if (mapRef.current) {
      mapRef.current.setView([52.5726, -0.2427], 12, { animate: true });
    }
  }

  function clearSearch() {
    setQuery("");
    setStops([]);
    setStopError("");
    clearSelection();
  }

  const mapCenter = selected ? [selected.lat, selected.lon] : [52.5726, -0.2427];
  const mapZoom = selected ? 14 : 12;

  return (
    <div className="page">
      <div className="shell">
        <header className="header">
          <div>
            <h1>Bus times</h1>
            <p>Search a stop, select it, and see stop info + live buses.</p>
          </div>
        </header>

        <section className="card">
          <div className="row">
            <div className="field">
              <label>Search bus stop</label>

              <div style={{ display: "flex", gap: 10 }}>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search a stop (e.g. Queensgate, Station, ATCOCode...)"
                  autoComplete="off"
                  style={{ flex: 1 }}
                />

                <button
                  className="smallBtn"
                  onClick={clearSearch}
                  type="button"
                  disabled={!query && !selected}
                  title="Clear search and selection"
                >
                  Clear
                </button>

                <button
                  className="smallBtn"
                  onClick={clearSelection}
                  type="button"
                  disabled={!selected}
                  title="Clear selected stop"
                >
                  Reset stop
                </button>
              </div>

              <div className="hint">
                Tip: search by <b>stop name</b>, <b>locality</b>, or <b>ATCO code</b>.
              </div>
            </div>
          </div>

          <div className="resultsHead">
            <span>Results</span>
            {stopLoading ? <span className="pill">Loading…</span> : null}
          </div>

          {stopError ? <div className="error">{stopError}</div> : null}

          <div className="results">
            {!query.trim() ? (
              <div className="empty">No stops yet — try a search.</div>
            ) : stops.length === 0 && !stopLoading ? (
              <div className="empty">No stops found.</div>
            ) : (
              stops.map((s) => (
                <button
                  key={s.id}
                  className={"resultItem" + (selected?.id === s.id ? " selected" : "")}
                  onClick={() => selectStop(s)}
                >
                  <div className="resultTitle">{s.name}</div>
                  <div className="resultMeta">
                    {s.id}
                    {s.indicator ? ` • ${s.indicator}` : ""}
                    {s.locality ? ` • ${s.locality}` : ""}
                  </div>
                </button>
              ))
            )}
          </div>

          {selected ? (
            <div className="selectedCard">
              <div className="selectedTitle">Selected stop</div>
              <div className="selectedName">{selected.name}</div>
              <div className="selectedMeta">
                {selected.id} • {selected.locality || "Unknown locality"}
              </div>
            </div>
          ) : null}
        </section>

        <section className="card">
          <div className="mapHead">
            <div>
              <div className="mapTitle">Live bus map</div>
              <div className="mapSub">
                Live locations from your BODS SIRI-VM feed
                {selected ? ` (showing within ${radiusKm}km of selected stop)` : ""}.
              </div>
            </div>

            <div className="rightPills">
              {busLoading ? <span className="pill">Refreshing…</span> : <span className="pill">Auto refresh 10s</span>}
              <span className="pill">Live buses: {nearbyBuses.length}</span>
            </div>
          </div>

          {busError ? <div className="error">{busError}</div> : null}

          <div className="mapWrap">
            <MapContainer
              center={mapCenter}
              zoom={mapZoom}
              scrollWheelZoom={true}
              whenCreated={(m) => (mapRef.current = m)}
              style={{ height: "420px", width: "100%" }}
            >
              <TileLayer
                attribution='&copy; OpenStreetMap contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />

              {selected ? (
                <>
                  <Marker position={[selected.lat, selected.lon]}>
                    <Popup>
                      <b>{selected.name}</b>
                      <br />
                      {selected.id}
                    </Popup>
                  </Marker>
                  <Circle center={[selected.lat, selected.lon]} radius={radiusKm * 1000} />
                </>
              ) : null}

              {/* Tracking lines (breadcrumb trails) */}
              {nearbyBuses.map((b) => {
                const line = tracks[b.id];
                if (!line || line.length < 2) return null;
                return <Polyline key={`line-${b.id}`} positions={line} />;
              })}

              {nearbyBuses.map((b) => (
                <Marker key={b.id} position={[b.lat, b.lon]}>
                  <Popup>
                    <b>Line:</b> {b.line}
                    <br />
                    <b>Destination:</b> {b.destination || "—"}
                    <br />
                    <b>Recorded:</b> {b.recordedAtTime || "—"}
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          </div>
        </section>
      </div>
    </div>
  );
}