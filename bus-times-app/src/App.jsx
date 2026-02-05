import { useEffect, useState } from "react";
import "./App.css";

export default function App() {
  const [query, setQuery] = useState("Enter Here");
  const [stops, setStops] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadStops(q) {
    try {
      setLoading(true);
      setError("");

      const res = await fetch(
        `http://localhost:3001/api/stops?q=${encodeURIComponent(q)}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);

      setStops(json);
    } catch (e) {
      setError(e?.message || "Failed to load stops");
      setStops([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStops(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: "40px auto", padding: 16 }}>
      <h1>Bus times</h1>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a stop (e.g. Queensgate, Parnwell, Tesco...)"
          style={{ padding: 10, flex: 1 }}
        />
        <button onClick={() => loadStops(query)} style={{ padding: "10px 14px" }}>
          Search
        </button>
      </div>

      {loading && <p style={{ marginTop: 12 }}>Loading stops…</p>}

      {error && (
        <div style={{ marginTop: 12, color: "salmon" }}>
          <b>Error:</b> {error}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <h3>
          Results {stops.length ? `(${stops.length})` : ""}{" "}
          <span style={{ opacity: 0.7, fontSize: 12 }}>
            (click a stop to copy its ATCO code)
          </span>
        </h3>

        <div style={{ border: "1px solid #333", borderRadius: 10, overflow: "hidden" }}>
          {stops.slice(0, 50).map((s) => (
            <button
              key={s.atcoCode}
              onClick={() => {
                navigator.clipboard?.writeText(s.atcoCode);
                alert(`Copied ATCO code: ${s.atcoCode}`);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: 12,
                border: "none",
                borderBottom: "1px solid #222",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 800 }}>
                {s.commonName} {s.indicator ? `(${s.indicator})` : ""}
              </div>
              <div style={{ opacity: 0.75, fontSize: 12 }}>
                {s.localityName} • {s.atcoCode}
              </div>
            </button>
          ))}

          {!loading && !error && stops.length === 0 && (
            <div style={{ padding: 12, opacity: 0.8 }}>No stops found.</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 18, opacity: 0.75, fontSize: 12 }}>
        ✅ Stops data loaded from your NaPTAN CSV. <br />
        ⏳ Next step: add timetable data (GTFS) so we can show “next buses” for a stop.
      </div>
    </div>
  );
}