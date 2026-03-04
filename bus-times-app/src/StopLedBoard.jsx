import "./StopLedBoard.css";

export default function StopLedBoard({ stop, departures }) {
  const rows = Array.isArray(departures) ? departures : [];

  const stopName =
    stop?.commonName || stop?.stop_name || stop?.stop_name || "Selected stop";

  const stopMeta =
    stop?.localityName
      ? `${stop.localityName} • ATCO ${stop.atcoCode}`
      : stop?.stop_id
      ? `Stop ID ${stop.stop_id}${stop.distance_m != null ? ` • ${stop.distance_m}m` : ""}`
      : "";

  return (
    <div className="ledCard" style={{ marginTop: 14 }}>
      <div className="ledHeader">
        <div className="ledStopName">{stopName}</div>
        <div className="ledStopMeta">{stopMeta}</div>
      </div>

      <div className="ledBoard">
        <div className="ledRow ledHead">
          <div>LINE</div>
          <div>DESTINATION</div>
          <div style={{ textAlign: "right" }}>EXPECTED</div>
        </div>

        {rows.length === 0 ? (
          <div className="ledEmpty">
            NO LIVE/SCHEDULED DEPARTURES.
          </div>
        ) : (
          rows.slice(0, 6).map((d, i) => (
            <div className="ledRow" key={`${d.route}-${d.destination}-${i}`}>
              <div className="ledLine">{d.route || "—"}</div>
              <div className="ledDest">{d.destination || "—"}</div>
              <div className="ledDue" style={{ textAlign: "right" }}>
                {d.expected || d.scheduled_time || "—"}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="ledFooter">UPDATED EVERY 15 SECONDS</div>
    </div>
  );
}