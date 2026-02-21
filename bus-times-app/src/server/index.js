/* eslint-disable */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const app = express();
app.use(cors());

/** Load env (.env in this folder) */
try {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
} catch (_) {}

const PORT = process.env.PORT || 3001;
const BODS_API_KEY = process.env.BODS_API_KEY;

// Peterborough-ish bbox: south,north,west,east
const DEFAULT_BBOX = "52.50,52.65,-0.40,-0.10";

// Stops file (NaPTAN CSV)
const STOPS_FILE = path.join(__dirname, "data", "naptan_peterborough.csv");

/** ---------------- Utils ---------------- */
function parseBbox(str) {
  const [south, north, west, east] = String(str).split(",").map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return { south, north, west, east };
}

function inBbox(lat, lon, b) {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

function readStopsCsvOnce() {
  // Simple cache so we don't re-parse on every request
  if (readStopsCsvOnce._cache) return readStopsCsvOnce._cache;

  if (!fs.existsSync(STOPS_FILE)) {
    readStopsCsvOnce._cache = [];
    return readStopsCsvOnce._cache;
  }

  const buf = fs.readFileSync(STOPS_FILE);

  // UTF-8 with BOM handling
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  // Normalise key fields we use in the frontend
  const stops = records
    .map((r) => {
      const atco =
        r.ATCOCode || r.atcocode || r.atcoCode || r.AtcoCode || r.atco || "";
      const common =
        r.CommonName || r.commonName || r.commonname || r.Name || "";
      const locality =
        r.LocalityName || r.localityName || r.localityname || r.Locality || "";
      const indicator = r.Indicator || r.indicator || "";
      return {
        atcoCode: String(atco).trim(),
        commonName: String(common).trim(),
        localityName: String(locality).trim(),
        indicator: String(indicator).trim(),
      };
    })
    .filter((s) => s.atcoCode && s.commonName);

  readStopsCsvOnce._cache = stops;
  return stops;
}

/** ---------------- Health ---------------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** ---------------- Stops search ----------------
 * GET /api/stops?q=queens
 * Returns: [{ atcoCode, commonName, localityName, indicator }]
 */
app.get("/api/stops", (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (!q) return res.json([]);

    const stops = readStopsCsvOnce();

    const results = stops
      .filter((s) => {
        const hay = `${s.commonName} ${s.localityName} ${s.indicator} ${s.atcoCode}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 200);

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

/** ---------------- Live buses (GTFS-RT) ----------------
 * GET /api/live-buses?bbox=52.50,52.65,-0.40,-0.10&limit=80
 * Returns JSON: { ok, bbox, count, buses: [{ vehicleId, lat, lon, bearing, speed, timestamp, routeId, tripId }] }
 */
app.get("/api/live-buses", async (req, res) => {
  try {
    if (!BODS_API_KEY) {
      return res.status(500).json({
        error: "Missing BODS_API_KEY. Put it in src/server/.env",
      });
    }

    const bbox = String(req.query.bbox || DEFAULT_BBOX);
    const bb = parseBbox(bbox) || parseBbox(DEFAULT_BBOX);

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 80;

    const url =
      `https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/` +
      `?boundingBox=${encodeURIComponent(bbox)}` +
      `&api_key=${encodeURIComponent(BODS_API_KEY)}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return res.status(resp.status).json({
        error: `BODS request failed: ${resp.status} ${resp.statusText}`,
        body: text.slice(0, 250),
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

      // IMPORTANT: enforce bbox filtering ourselves (keeps Peterborough only)
      if (bb && !inBbox(latitude, longitude, bb)) continue;

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

      if (buses.length >= limit) break;
    }

    res.json({
      ok: true,
      bbox,
      count: buses.length,
      buses,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});