import "./StopLedBoard.css";

export default function StopLedBoard({ stop, departures }) {
  return (
    <div className="ledCard" style={{ marginTop: 14 }}>
      <div className="ledHeader">
        <div className="ledStopName">{stop.commonName}</div>
        <div className="ledStopMeta">
          {stop.localityName} • ATCO {stop.atcoCode}
        </div>
      </div>

      <div className="ledBoard">
        <div className="ledRow ledHead">
          <div>LINE</div>
          <div>DESTINATION</div>
          <div style={{ textAlign: "right" }}>DUE</div>
        </div>

        {(departures || []).length === 0 ? (
          <div className="ledEmpty">
            NO LIVE/SCHEDULED DEPARTURES YET.
            <br />
            (Add timetable GTFS or TripUpdates to show “DUE / Xm”.)
          </div>
        ) : (
          departures.slice(0, 6).map((d, i) => (
            <div className="ledRow" key={`${d.line}-${d.destination}-${d.dueText}-${i}`}>
              <div className="ledLine">{d.line || "—"}</div>
              <div className="ledDest">{d.destination || "—"}</div>
              <div className="ledDue">{d.dueText || "—"}</div>
            </div>
          ))
        )}
      </div>

      <div className="ledFooter">UPDATED EVERY 15 SECONDS</div>
    </div>
  );
}
