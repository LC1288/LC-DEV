/* eslint-disable */
const express = require("express");
const cors = require("cors");
const { XMLParser } = require("fast-xml-parser");

const app = express();
app.use(cors());

// quick test endpoint so we KNOW the server is reachable
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// scheduled demo endpoint (works WITHOUT credentials)
app.get("/api/scheduled", (req, res) => {
  const stop = req.query.stop;
  if (!stop) return res.status(400).json({ error: "Missing ?stop=" });

  res.json({
    stop,
    departures: [
      { route: "1", destination: "City Centre", time: "10:35" },
      { route: "1", destination: "City Centre", time: "10:55" },
      { route: "3", destination: "Bretton", time: "11:05" }
    ],
    source: "scheduled"
  });
});

// live departures endpoint (requires credentials)
app.get("/api/departures", async (req, res) => {
  try {
    const stop = req.query.stop;
    if (!stop) return res.status(400).json({ error: "Missing ?stop=" });

    const USER = process.env.NEXTBUSES_USER;
    const PASS = process.env.NEXTBUSES_PASS;

    // If you don't have credentials yet, return a clear message
    if (!USER || !PASS) {
      return res.status(501).json({
        error:
          "NextBuses credentials not set. Set NEXTBUSES_USER and NEXTBUSES_PASS to enable live departures."
      });
    }

    const url = `http://${encodeURIComponent(USER)}:${encodeURIComponent(
      PASS
    )}@nextbus.mxdata.co.uk/nextbuses/1.0/1`;

    const now = new Date().toISOString();
    const msgId = String(Date.now());

    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Siri version="1.0" xmlns="http://www.siri.org.uk/">
  <ServiceRequest>
    <RequestTimestamp>${now}</RequestTimestamp>
    <RequestorRef>${USER}</RequestorRef>
    <StopMonitoringRequest version="1.0">
      <RequestTimestamp>${now}</RequestTimestamp>
      <MessageIdentifier>${msgId}</MessageIdentifier>
      <MonitoringRef>${stop}</MonitoringRef>
    </StopMonitoringRequest>
  </ServiceRequest>
</Siri>`;

    // Node 18+ has fetch built in
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: xml
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(502).json({
        error: `NextBuses HTTP ${r.status}`,
        body: text.slice(0, 500)
      });
    }

    const parser = new XMLParser({ ignoreAttributes: false });
    const data = parser.parse(text);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

app.listen(3001, () => console.log("API running on http://localhost:3001"));


