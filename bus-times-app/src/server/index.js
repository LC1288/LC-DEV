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
const DEFAULT_BBOX = "52.50,52.65,-0.40,-0.10";

// Paths
const DATA_DIR = path.join(__dirname, "data");
const NAPTAN_FILE = path.join(DATA_DIR, "naptan_peterborough.csv");

// If you're on Node < 18, uncomment and run: npm i node-fetch
// const fetch = (...args) =>
//   import("node-fetch").then(({ default: fetch }) => fetch(...args));

/** Load NaPTAN once and cache it */
let STOPS_CACHE = null;

function loadStopsFromCsv() {
  const raw = fs.readFileSync(NAPTAN_FILE, "utf8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
  });

  // Normalize to your frontend shape
  // NaPTAN headers vary slightly, so we guard with fallbacks
  return records
    .map((r) => {
      const atcoCode = r.ATCOCode || r.atcoCode || r.AtcoCode || r.ATCOCODE;
      if (!atcoCode) return null;

      return {
        atcoCode,
        commonName: r.CommonName || r.commonName || r.COMMONNAME || "Unknown",
        indicator: r.Indicator || r.indicator || "",
        localityName:
          r.LocalityName || r.localityName || r.NptgLocalityName || "",
      };
    })
    .filter(Boolean);
}

function getStops() {
  if (!STOPS_CACHE) STOPS_CACHE = loadStopsFromCsv();
  return STOPS_CACHE;
}

/** Health */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** Stops search */
app.get("/api/stops", (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    if (!q) return res.json([]);

    const stops = getStops();

    const results = stops
      .filter((s) => {
        const hay = `${s.commonName} ${s.indicator} ${s.localityName} ${s.atcoCode}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 200);

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

/** Live buses (vehicle positions) */
app.get("/api/live-buses", async (req, res) => {
  try {
    if (!BODS_API_KEY) {
      return res.status(500).json({
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

      // Extra safety: enforce bbox locally (prevents huge spam)
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

    // Hard limit so your UI stays fast
    const limited = buses.slice(0, 800);

    res.json({ ok: true, bbox, count: limited.length, buses: limited });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
