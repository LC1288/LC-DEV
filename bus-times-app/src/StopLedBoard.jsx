import { useEffect, useState } from "react";
import "./StopLedBoard.css";

export default function StopLedBoard({ stop }) {
  const [info, setInfo] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!stop?.atcoCode) return;

    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setErr("");

        // Stop info (always works)
        const r1 = await fetch(
          `http://localhost:3001/api/stop-info?atco=${encodeURIComponent(
            stop.atcoCode
          )}`
        );
        const j1 = await r1.json();
        if (!r1.ok) throw new Error(j1?.error || "Failed to load stop info");
        if (cancelled) return;
        setInfo(j1);

        // Next departures (may be empty until you add GTFS/TripUpdates)
        const r2 = await fetch(
          `http://localhost:3001/api/next?atco=${encodeURIComponent(
            stop.atcoCode
          )}`
        );
        const j2 = await r2.json();
        if (!r2.ok) throw new Error(j2?.error || "Failed to load departures");
        if (cancelled) return;
        setRows(Array.isArray(j2) ? j2 : []);
      } catch (e) {
        if (!cancelled) setErr(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const t = setInterval(load, 15000); // refresh every 15s
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [stop?.atcoCode]);

  return (
    <div className="ledWrap">
      <div className="ledTop">
        <div className="ledTitle">
          {stop.commonName} {stop.indicator ? `(${stop.indicator})` : ""}
        </div>
        <div className="ledSub">
          {stop.localityName} • ATCO {stop.atcoCode}
        </div>
      </div>

      <div className="ledPanel" role="region" aria-label="Next buses board">
        <div className="ledHeader">
          <div>LINE</div>
          <div>DESTINATION</div>
          <div className="right">DUE</div>
        </div>

        {loading && <div className="ledMsg">LOADING…</div>}

        {!loading && err && (
          <div className="ledMsg error">
            ERROR: {err.toUpperCase()}
          </div>
        )}

        {!loading && !err && rows.length === 0 && (
          <div className="ledMsg">
            NO LIVE/SCHEDULED DEPARTURES YET.
            <br />
            (ADD TIMETABLE GTFS OR TRIPUPDATES TO SHOW “DUE / XM”.)
          </div>
        )}

        {!loading &&
          !err &&
          rows.slice(0, 6).map((r, idx) => (
            <div className="ledRow" key={`${r.line}-${r.destination}-${idx}`}>
              <div className="line">{r.line || "--"}</div>
              <div className="dest">{(r.destination || "").toUpperCase()}</div>
              <div className="due right">{(r.dueText || "").toUpperCase()}</div>
            </div>
          ))}
      </div>

      {/* Optional extra info line */}
      {info?.lat && info?.lon ? (
        <div className="ledFoot">
          STOP COORDS: {Number(info.lat).toFixed(5)},{Number(info.lon).toFixed(5)}
        </div>
      ) : (
        <div className="ledFoot">UPDATED EVERY 15 SECONDS</div>
      )}
    </div>
  );
}
