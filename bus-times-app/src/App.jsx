import { useEffect, useState } from "react";
import "./App.css";
import LiveBusMap from "./LiveBusMap";
import StopLedBoard from "./StopLedBoard";

export default function App() {
  const [query, setQuery] = useState("");
  const [stops, setStops] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedStop, setSelectedStop] = useState(null);
  const [departures, setDepartures] = useState([]);

  async function loadNext(atco) {
    try {
      const res = await fetch(
        `http://localhost:3001/api/next?atco=${encodeURIComponent(atco)}`
      );
      const json = await res.json();

      if (!res.ok) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }

      setDepartures(Array.isArray(json) ? json : []);
    } catch (err) {
      console.error(err);
      setDepartures([]);
    }
  }

  useEffect(() => {
    if (!selectedStop?.atcoCode) {
      setDepartures([]);
      return;
    }

    loadNext(selectedStop.atcoCode);

    const interval = setInterval(() => {
      loadNext(selectedStop.atcoCode);
    }, 15000);

    return () => clearInterval(interval);
  }, [selectedStop]);

  async function loadStops(q) {
    if (!q.trim()) {
      setStops([]);
      setError("");
      return;
    }

    try {
      setLoading(true);
      setError("");

      // ✅ Only return stops that exist in GTFS timetable
      const res = await fetch(
        `http://localhost:3001/api/stops?q=${encodeURIComponent(q)}&timetabled=1`
      );

      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);

      setStops(Array.isArray(json) ? json : []);
    } catch (e) {
      setError(e?.message || "Failed to load stops");
      setStops([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="appShell">
      <div className="appWrap">
        <header className="header">
          <h1 className="title">Bus times</h1>
          <p className="subtitle">
            Search a stop, select it, and see its info + live buses.
          </p>
        </header>

        <section className="card">
          <div className="searchRow">
            <input
              className="input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a stop (e.g. Queensgate...)"
              onKeyDown={(e) => {
                if (e.key === "Enter") loadStops(query);
              }}
            />
            <button className="btn" onClick={() => loadStops(query)}>
              Search
            </button>
          </div>

          {loading && (
            <p className="muted" style={{ marginTop: 12 }}>
              Loading stops…
            </p>
          )}

          {error && (
            <div className="errorBox">
              <b>Error:</b> {error}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <div className="sectionTitle">
              Results{" "}
              <span className="muted">
                {stops.length ? `(${stops.length})` : ""} • click a stop to select
              </span>
            </div>

            <div className="list">
              {stops.slice(0, 50).map((s) => {
                const isSelected = selectedStop?.atcoCode === s.atcoCode;
                return (
                  <button
                    key={s.atcoCode}
                    className="listItem"
                    onClick={() => setSelectedStop(s)}
                    style={{
                      background: isSelected
                        ? "rgba(255,255,255,0.08)"
                        : "transparent",
                    }}
                  >
                    <div className="stopName">
                      {s.commonName} {s.indicator ? `(${s.indicator})` : ""}
                    </div>
                    <div className="stopMeta">
                      {s.localityName} • {s.atcoCode}
                      {isSelected ? " • selected" : ""}
                    </div>
                  </button>
                );
              })}

              {!loading && !error && stops.length === 0 && (
                <div className="empty">No stops yet — try a search.</div>
              )}
            </div>

            {selectedStop ? (
              <StopLedBoard stop={selectedStop} departures={departures} />
            ) : null}
          </div>
        </section>

        <section className="card" style={{ marginTop: 18 }}>
          <div className="sectionTitle">Live bus map</div>
          <div className="muted" style={{ marginTop: 6 }}>
            Live locations via BODS feed (Peterborough bbox + limit).
          </div>

          <div className="mapFrame">
            <LiveBusMap limit={80} />
          </div>
        </section>
      </div>
    </div>
  );
}