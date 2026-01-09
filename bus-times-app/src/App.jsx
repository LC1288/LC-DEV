import { useEffect, useState } from "react";
import "./App.css";

export default function App() {
  const [stop, setStop] = useState("059000000"); // any placeholder for now
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | loading | ok | error
  const [error, setError] = useState("");

  async function load() {
    if (!stop) return;

    try {
      setStatus("loading");
      setError("");

      // Use scheduled endpoint (health endpoint won't return departures)
      const res = await fetch(
        `http://localhost:3001/api/scheduled?stop=${encodeURIComponent(stop)}`
      );

      const json = await res.json();

      if (!res.ok) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }

      setData(json);
      setStatus("ok");
    } catch (e) {
      setStatus("error");
      setError(e?.message || "Unknown error");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop]);

  return (
    <div style={{ maxWidth: 900, margin: "40px auto", padding: 16 }}>
      <h1>Peterborough bus times</h1>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label>
          Stop code (ATCO/NaPTAN):
          <input
            value={stop}
            onChange={(e) => setStop(e.target.value)}
            style={{ marginLeft: 8, padding: 6, width: 220 }}
            placeholder="e.g. 0590..."
          />
        </label>

        <button onClick={load} style={{ padding: "6px 12px" }}>
          Refresh
        </button>
      </div>

      {status === "loading" && <p>Loading…</p>}

      {status === "error" && (
        <div style={{ marginTop: 12, color: "salmon" }}>
          <b>Error:</b> {error}
        </div>
      )}

      {status === "ok" && (
        <div style={{ marginTop: 16 }}>
          {data?.departures?.length ? (
            <>
              <h3>Next buses</h3>
              <ul>
                {data.departures.map((d, i) => (
                  <li key={i}>
                    <b>{d.route}</b> → {d.destination} at {d.time}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>No departures returned.</p>
          )}

          <h3 style={{ marginTop: 16 }}>Raw response</h3>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              background: "#111",
              padding: 12,
              borderRadius: 8,
              overflow: "auto",
            }}
          >
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}




