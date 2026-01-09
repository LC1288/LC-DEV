import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

const app = express();
app.use(cors());

const USER = process.env.NEXTBUSES_USER; // TravelineAPIxxx
const PASS = process.env.NEXTBUSES_PASS;

function siriStopMonitoringXML({ requestorRef, monitoringRef }) {
  const now = new Date().toISOString();
  const msgId = String(Date.now());
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Siri version="1.0" xmlns="http://www.siri.org.uk/">
  <ServiceRequest>
    <RequestTimestamp>${now}</RequestTimestamp>
    <RequestorRef>${requestorRef}</RequestorRef>
    <StopMonitoringRequest version="1.0">
      <RequestTimestamp>${now}</RequestTimestamp>
      <MessageIdentifier>${msgId}</MessageIdentifier>
      <MonitoringRef>${monitoringRef}</MonitoringRef>
    </StopMonitoringRequest>
  </ServiceRequest>
</Siri>`;
}

app.get("/api/departures", async (req, res) => {
  try {
    const stop = req.query.stop; // AtcoCode or NaptanCode
    if (!stop) return res.status(400).json({ error: "Missing ?stop=" });

    if (!USER || !PASS) {
      return res.status(500).json({ error: "Missing NEXTBUSES_USER / NEXTBUSES_PASS env vars" });
    }

    const url = `http://${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}@nextbus.mxdata.co.uk/nextbuses/1.0/1`;

    const xml = siriStopMonitoringXML({ requestorRef: USER, monitoringRef: stop });

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: xml,
    });

    if (!r.ok) throw new Error(`NextBuses HTTP ${r.status}`);

    const text = await r.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const data = parser.parse(text);

    // Return raw parsed JSON for now (we can “shape” it next)
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || "Unknown error" });
  }
});

app.listen(3001, () => console.log("API on http://localhost:3001"));
