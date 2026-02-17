import "./StopLedBoard.css";

export default function StopLedBoard({ stop, departures }) {
  const rows = Array.isArray(departures) ? departures : [];

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

        {rows.length === 0 ? (
          <div className="ledEmpty">
            NO LIVE/SCHEDULED DEPARTURES YET.
            <br />
            (To show exact destinations, you need GTFS static trips/headsigns.)
          </div>
        ) : (
          rows.slice(0, 6).map((d, i) => {
            const safeDue =
              typeof d.dueText === "string" && d.dueText.includes("NaN")
                ? "—"
                : (d.dueText || "—");

            return (
              <div className="ledRow" key={`${d.line}-${d.destination}-${safeDue}-${i}`}>
                <div className="ledLine">{d.line || "—"}</div>
                <div className="ledDest">{d.destination || "—"}</div>
                <div className="ledDue">{safeDue}</div>
              </div>
            );
          })
        )}
      </div>

      <div className="ledFooter">UPDATED EVERY 15 SECONDS</div>
    </div>
  );
}
