/* eslint-disable */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const app = express();
app.use(cors());

try {
  require("dotenv").config();
} catch (_) {}

const BODS_API_KEY = process.env.BODS_API_KEY;

// Peterborough-ish bbox: south,north,west,east
const DEFAULT_BBOX = "52.50,52.65,-0.40,-0.10";

// Paths
const DATA_DIR = path.join(__dirname, "data");
const NAPTAN_FILE = path.join(DATA_DIR, "naptan_peterborough.csv");

// If you're on Node < 18, uncomment and run: npm i node-fetch
// const fetch = (...args) =>
//   import("node-fetch").then(({ default: fetch }) => fetch(...args));

/** --------- Load NaPTAN once and cache it --------- */
let STOPS_CACHE = null;

function loadStopsFromCsv() {
  const raw = fs.readFileSync(NAPTAN_FILE, "utf8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
  });

  return records
    .map((r) => {
      const atcoCode = r.ATCOCode || r.atcoCode || r.AtcoCode || r.ATCOCODE;
      if (!atcoCode) return null;

      return {
        atcoCode: String(atcoCode).trim(),
        commonName: (r.CommonName || r.commonName || r.COMMONNAME || "Unknown").trim(),
        indicator: (r.Indicator || r.indicator || "").trim(),
        localityName: (
          r.LocalityName ||
          r.localityName ||
          r.NptgLocalityName ||
          r.NPTGLocalityName ||
          ""
        ).trim(),
        // optional coords if your CSV has them
        lat:
          r.Latitude ||
          r.latitude ||
          r.Lat ||
          r.lat ||
          r.StopPointLat ||
          null,
        lon:
          r.Longitude ||
          r.longitude ||
          r.Lon ||
          r.lon ||
          r.StopPointLon ||
          null,
      };
    })
    .filter(Boolean);
}

function getStops() {
  if (!STOPS_CACHE) STOPS_CACHE = loadStopsFromCsv();
  return STOPS_CACHE;
}

/** --------- Health --------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * --------- Ranked Stops Search ---------
 * This boosts Peterborough + Queensgate so villages like Nassington don't dominate results.
 */
app.get("/api/stops", (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    if (!q) return res.json([]);

    const stops = getStops();

    function scoreStop(s) {
      const name = (s.commonName || "").toLowerCase();
      const loc = (s.localityName || "").toLowerCase();
      const atco = (s.atcoCode || "").toLowerCase();

      // Only include if it matches somewhere
      const matches =
        name.includes(q) || loc.includes(q) || atco.includes(q) || (s.indicator || "").toLowerCase().includes(q);
      if (!matches) return 0;

      let score = 0;

      // Name matching (strong)
      if (name === q) score += 1000;
      if (name.startsWith(q)) score += 500;
      if (name.includes(q)) score += 250;

      // Locality boost (Peterborough to top)
      if (loc.includes("peterborough")) score += 250;

      // If user types "queensgate", push queensgate hard
      if (q.includes("queensgate") && name.includes("queensgate")) score += 800;

      // If user types "queens", still favour queensgate if present
      if (q === "queens" && name.includes("queensgate")) score += 400;

      // Indicator match (small)
      if ((s.indicator || "").toLowerCase().includes(q)) score += 80;

      // ATCO match (small)
      if (atco.includes(q)) score += 60;

      return score;
    }

    const results = stops
      .map((s) => ({ s, score: scoreStop(s) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 200)
      .map((x) => ({
        atcoCode: x.s.atcoCode,
        commonName: x.s.commonName,
        indicator: x.s.indicator,
        localityName: x.s.localityName,
      }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

/** --------- Stop info (LED board header) --------- */
app.get("/api/stop-info", (req, res) => {
  try {
    const atco = (req.query.atco || "").toString().trim();
    if (!atco) return res.status(400).json({ error: "Missing atco" });

    const stops = getStops();
    const s = stops.find((x) => x.atcoCode === atco);

    if (!s) return res.status(404).json({ error: "Stop not found" });

    res.json({
      atcoCode: s.atcoCode,
      commonName: s.commonName,
      indicator: s.indicator,
      localityName: s.localityName,
      lat: s.lat,
      lon: s.lon,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * --------- Next departures (LED rows) ---------
 * Placeholder until you add timetable GTFS or TripUpdates.
 * MUST return JSON so the LED board doesn't break.
 */
app.get("/api/next", (req, res) => {
  res.json([]);
});

/** --------- Live buses (GTFS-RT VehiclePositions) --------- */
app.get("/api/live-buses", async (req, res) => {
  try {
    if (!BODS_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing BODS_API_KEY. Put it in src/server/.env",
      });
    }

    const bbox = (req.query.bbox || DEFAULT_BBOX).toString();
    const [minLat, maxLat, minLon, maxLon] = bbox.split(",").map(Number);

    const url =
      `https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/` +
      `?boundingBox=${encodeURIComponent(bbox)}` +
      `&api_key=${encodeURIComponent(BODS_API_KEY)}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return res.status(resp.status).json({
        ok: false,
        error: `BODS request failed: ${resp.status} ${resp.statusText}`,
        body: text.slice(0, 300),
      });
    }

    const ab = await resp.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(ab)
    );

    const buses = [];

    for (const entity of feed.entity) {
      const v = entity.vehicle;
      if (!v || !v.position) continue;

      const { latitude, longitude, bearing, speed } = v.position;
      if (typeof latitude !== "number" || typeof longitude !== "number") continue;

      // Enforce bbox locally (prevents spam)
      if (
        Number.isFinite(minLat) &&
        Number.isFinite(maxLat) &&
        Number.isFinite(minLon) &&
        Number.isFinite(maxLon)
      ) {
        if (
          latitude < minLat ||
          latitude > maxLat ||
          longitude < minLon ||
          longitude > maxLon
        ) {
          continue;
        }
      }

      buses.push({
        vehicleId: v.vehicle?.id || entity.id || null,
        lat: latitude,
        lon: longitude,
        bearing: typeof bearing === "number" ? bearing : null,
        speed: typeof speed === "number" ? speed : null,
        timestamp: v.timestamp ? Number(v.timestamp) : null,
        routeId: v.trip?.routeId || null,
        tripId: v.trip?.tripId || null,
      });
    }

    // Hard limit so UI stays fast
    const limited = buses.slice(0, 800);

    res.json({ ok: true, bbox, count: limited.length, buses: limited });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/**
 * --------- Debug: prove Queensgate exists in your CSV ---------
 * Visit: http://localhost:3001/api/debug/find?q=queensgate
 */
app.get("/api/debug/find", (req, res) => {
  try {
    const q = (req.query.q || "").toString().toLowerCase().trim();
    const stops = getStops();
    const hits = stops
      .filter((s) =>
        `${s.commonName} ${s.localityName} ${s.atcoCode}`.toLowerCase().includes(q)
      )
      .slice(0, 25)
      .map((s) => ({
        atcoCode: s.atcoCode,
        commonName: s.commonName,
        indicator: s.indicator,
        localityName: s.localityName,
      }));
    res.json(hits);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
