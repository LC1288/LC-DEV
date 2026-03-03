import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
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

function isUkLatLon(lat, lon) {
  return lat >= 49 && lat <= 61 && lon >= -9 && lon <= 3;
}

export default function App() {
  const PB = useMemo(() => ({ lat: 52.5726, lon: -0.2427 }), []);

  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 250);

  const [stopLoading, setStopLoading] = useState(false);
  const [stopError, setStopError] = useState("");
  const [stops, setStops] = useState([]);
  const [selected, setSelected] = useState(null);

  const [depsLoading, setDepsLoading] = useState(false);
  const [depsError, setDepsError] = useState("");
  const [departures, setDepartures] = useState([]);

  const [busLoading, setBusLoading] = useState(false);
  const [busError, setBusError] = useState("");
  const [buses, setBuses] = useState([]);

  const [tracks, setTracks] = useState({});
  const trackRef = useRef({});

  const mapRef = useRef(null);

  // --- stop search ---
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

  // --- departures for selected stop ---
  useEffect(() => {
    if (!selected?.id) {
      setDepartures([]);
      setDepsError("");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setDepsLoading(true);
        setDepsError("");
        const r = await fetch(`/api/departures?stopId=${encodeURIComponent(selected.id)}&limit=12`);
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data?.error || `Departures failed (${r.status})`);
        if (!cancelled) setDepartures(data.items || []);
      } catch (e) {
        if (!cancelled) setDepsError(String(e.message || e));
      } finally {
        if (!cancelled) setDepsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  // --- live buses poll ---
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

            if (moved) updated[id] = [...updated[id], point].slice(-25);
          }

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

  // --- map filtering (map is an ADD-ON) ---
  const radiusKmSelected = 1.5;
  const defaultRadiusKm = 15;

  const filteredBuses = useMemo(() => {
    const centre = selected ? { lat: selected.lat, lon: selected.lon } : PB;
    const radius = selected ? radiusKmSelected : defaultRadiusKm;

    return buses.filter((b) => {
      const d = haversineKm(centre.lat, centre.lon, b.lat, b.lon);
      return d <= radius;
    });
  }, [buses, selected, PB]);

  const visibleBuses = useMemo(() => filteredBuses.slice(0, 250), [filteredBuses]);

  function selectStop(s) {
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    setSelected(s);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isUkLatLon(lat, lon)) return;
    if (mapRef.current) mapRef.current.setView([lat, lon], 14, { animate: true });
  }

  function clearSelection() {
    setSelected(null);
    if (mapRef.current) mapRef.current.setView([PB.lat, PB.lon], 12, { animate: true });
  }

  function clearSearch() {
    setQuery("");
    setStops([]);
    setStopError("");
    clearSelection();
  }

  const mapCenter = selected ? [selected.lat, selected.lon] : [PB.lat, PB.lon];
  const mapZoom = selected ? 14 : 12;

  return (
    <div className="page">
      <div className="shell">
        <header className="header">
          <div>
            <h1>Bus times</h1>
            <p>Search a stop, select it, and see departures + live buses.</p>
          </div>
        </header>

        {/* SEARCH + DEPARTURES (main feature) */}
        <section className="card">
          <div className="field">
            <label>Search bus stop</label>

            <div style={{ display: "flex", gap: 10 }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search (Queensgate, Hospital, Parnwell...)"
                autoComplete="off"
                style={{ flex: 1 }}
              />
              <button className="smallBtn" onClick={clearSearch} type="button" disabled={!query && !selected}>
                Clear
              </button>
              <button className="smallBtn" onClick={clearSelection} type="button" disabled={!selected}>
                Reset stop
              </button>
            </div>

            <div className="hint">Tip: search by <b>stop name</b>, <b>locality</b>, or <b>ATCO code</b>.</div>
          </div>

          <div className="resultsHead">
            <span>Results</span>
            {stopLoading ? <span className="pill">Loading…</span> : null}
          </div>

          {stopError ? <div className="error">{stopError}</div> : null}

          <div className="results">
            {!query.trim() ? (
              <div className="empty">Start typing to search stops.</div>
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

          {/* DEPARTURES */}
          {selected ? (
            <div className="selectedCard">
              <div className="selectedTitle">Selected stop</div>
              <div className="selectedName">{selected.name}</div>
              <div className="selectedMeta">{selected.id} • {selected.locality || "Unknown locality"}</div>

              <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontWeight: 800 }}>Next departures</div>
                {depsLoading ? <span className="pill">Loading…</span> : <span className="pill">Today</span>}
              </div>

              {depsError ? <div className="error">{depsError}</div> : null}

              {!depsLoading && departures.length === 0 && !depsError ? (
                <div className="empty" style={{ marginTop: 10 }}>
                  No departures found for this stop (GTFS may not match this stop id).
                </div>
              ) : null}

              {departures.length > 0 ? (
                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  {departures.map((d, idx) => (
                    <div
                      key={`${d.trip_id}-${idx}`}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 14,
                        padding: 12,
                        background: "rgba(0,0,0,0.18)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ fontWeight: 850 }}>
                          {d.route_short_name || "Route"} {d.route_long_name ? `• ${d.route_long_name}` : ""}
                        </div>
                        <div style={{ fontWeight: 850 }}>{d.departure_time?.slice(0, 5)}</div>
                      </div>
                      <div style={{ marginTop: 6, color: "var(--muted)", fontSize: 13 }}>
                        {d.headsign ? `To: ${d.headsign}` : "Destination: —"}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* MAP (addition) */}
        <section className="card">
          <div className="mapHead">
            <div>
              <div className="mapTitle">Live bus map</div>
              <div className="mapSub">
                Live vehicle locations (extra context).
                {selected
                  ? ` Showing within ${radiusKmSelected}km of the selected stop.`
                  : ` Showing within ${defaultRadiusKm}km of Peterborough.`}
              </div>
            </div>

            <div className="rightPills">
              {busLoading ? <span className="pill">Refreshing…</span> : <span className="pill">Auto refresh 10s</span>}
              <span className="pill">
                Visible: {visibleBuses.length}
                {filteredBuses.length > visibleBuses.length ? ` (of ${filteredBuses.length})` : ""}
              </span>
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
                attribution="&copy; OpenStreetMap contributors"
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
                  <Circle center={[selected.lat, selected.lon]} radius={radiusKmSelected * 1000} />
                </>
              ) : null}

              {visibleBuses.map((b) => {
                const line = tracks[b.id];
                if (!line || line.length < 2) return null;
                return <Polyline key={`line-${b.id}`} positions={line} />;
              })}

              {visibleBuses.map((b) => (
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