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
  require("dotenv").config({ path: path.join(__dirname, ".env") });
} catch (_) {}

const BODS_API_KEY = process.env.BODS_API_KEY;

// ---------- Paths ----------
const DATA_DIR = path.join(__dirname, "data");
const STOPS_FILE = path.join(DATA_DIR, "naptan_peterborough.csv");

// Peterborough-ish bounding box: south,north,west,east
const DEFAULT_BBOX = "52.50,52.65,-0.40,-0.10";

// ---------- Helpers ----------
function safeLower(x) {
  return (x ?? "").toString().toLowerCase();
}

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath);
  // Try UTF-8; if BOM, Node handles; if UTF-16, this is still a problem, but most NaPTAN CSV is UTF-8.
  const text = raw.toString("utf8");
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: true,
  });
}

function formatDueFromMinutes(mins) {
  if (!Number.isFinite(mins)) return null;
  if (mins <= 0) return "DUE";
  return `${mins}min`;
}

function parseBBox(bboxStr) {
  // "south,north,west,east"
  const parts = bboxStr.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [south, north, west, east] = parts;
  return { south, north, west, east };
}

function inBbox(lat, lon, bbox) {
  return (
    lat >= bbox.south &&
    lat <= bbox.north &&
    lon >= bbox.west &&
    lon <= bbox.east
  );
}

// ---------- Health ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- Stops search ----------
app.get("/api/stops", (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json([]);

    if (!fs.existsSync(STOPS_FILE)) {
      return res.status(500).json({
        error: `Stops CSV not found at ${STOPS_FILE}. Put naptan_peterborough.csv in src/server/data/`,
      });
    }

    const rows = readCsv(STOPS_FILE);

    // NaPTAN fields vary by export; support common names.
    const mapped = rows
      .map((r) => {
        // Try multiple column names
        const atco =
          r.ATCOCode ||
          r.AtcoCode ||
          r.atcocode ||
          r.atcoCode ||
          r.atco ||
          "";
        const commonName =
          r.CommonName || r.commonname || r.commonName || r.Name || "";
        const indicator =
          r.Indicator || r.indicator || r.Ind || r.ind || "";
        const localityName =
          r.LocalityName || r.localityname || r.localityName || r.Locality || "";
        const lat = Number(
          r.Latitude || r.latitude || r.Lat || r.lat || ""
        );
        const lon = Number(
          r.Longitude || r.longitude || r.Lon || r.lon || ""
        );

        return {
          atcoCode: (atco || "").toString(),
          commonName: (commonName || "").toString(),
          indicator: (indicator || "").toString(),
          localityName: (localityName || "").toString(),
          lat: Number.isFinite(lat) ? lat : null,
          lon: Number.isFinite(lon) ? lon : null,
        };
      })
      .filter((s) => s.atcoCode && s.commonName);

    const qq = safeLower(q);

    const hits = mapped
      .filter((s) => {
        const hay =
          safeLower(s.commonName) +
          " " +
          safeLower(s.localityName) +
          " " +
          safeLower(s.indicator) +
          " " +
          safeLower(s.atcoCode);
        return hay.includes(qq);
      })
      .slice(0, 200); // API cap

    res.json(hits);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ---------- Live bus positions (GTFS-RT VehiclePositions inside feed) ----------
app.get("/api/live-buses", async (req, res) => {
  try {
    if (!BODS_API_KEY) {
      return res.status(500).json({
        error: "Missing BODS_API_KEY. Put it in src/server/.env",
      });
    }

    const bboxStr = (req.query.bbox || DEFAULT_BBOX).toString();
    const bbox = parseBBox(bboxStr);
    if (!bbox) return res.status(400).json({ error: "Invalid bbox" });

    const limit = Math.max(
      1,
      Math.min(500, Number(req.query.limit ?? 80) || 80)
    );

    const url =
      `https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/` +
      `?boundingBox=${encodeURIComponent(bboxStr)}` +
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
      if (!v?.position) continue;

      const lat = v.position.latitude;
      const lon = v.position.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!inBbox(lat, lon, bbox)) continue;

      buses.push({
        vehicleId: v.vehicle?.id || entity.id || null,
        lat,
        lon,
        bearing: Number.isFinite(v.position.bearing) ? v.position.bearing : null,
        speed: Number.isFinite(v.position.speed) ? v.position.speed : null,
        timestamp: v.timestamp ? Number(v.timestamp) : null,
        routeId: v.trip?.routeId || null,
        tripId: v.trip?.tripId || null,
      });

      if (buses.length >= limit) break;
    }

    res.json({ ok: true, bbox: bboxStr, count: buses.length, buses });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ---------- Next departures for a stop (GTFS-RT TripUpdates) ----------
app.get("/api/next", async (req, res) => {
  try {
    if (!BODS_API_KEY) {
      return res.status(500).json({ error: "Missing BODS_API_KEY in src/server/.env" });
    }

    const atco = (req.query.atco || "").toString().trim();
    if (!atco) return res.status(400).json({ error: "Missing atco" });

    const bboxStr = (req.query.bbox || DEFAULT_BBOX).toString();

    // Load stop coords from NaPTAN so we can estimate if needed
    if (!fs.existsSync(STOPS_FILE)) {
      return res.status(500).json({ error: `Stops CSV missing: ${STOPS_FILE}` });
    }

    const stopRows = readCsv(STOPS_FILE);
    const stop = stopRows
      .map((r) => {
        const code = (r.ATCOCode || r.AtcoCode || r.atcoCode || r.atcocode || "").toString();
        const lat = Number(r.Latitude || r.latitude || r.lat || r.Lat || "");
        const lon = Number(r.Longitude || r.longitude || r.lon || r.Lon || "");
        return { code, lat, lon };
      })
      .find((s) => s.code === atco && Number.isFinite(s.lat) && Number.isFinite(s.lon));

    const url =
      `https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/` +
      `?boundingBox=${encodeURIComponent(bboxStr)}` +
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
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(ab));

    const nowMs = Date.now();

    // ---------- 1) Try REAL TripUpdates for this stop ----------
    const tripRows = [];

    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu?.stopTimeUpdate?.length) continue;

      for (const stu of tu.stopTimeUpdate) {
        const stopId = (stu.stopId || "").toString();
        if (stopId !== atco) continue;

        const arrSec = stu.arrival?.time ? Number(stu.arrival.time) : null;
        const depSec = stu.departure?.time ? Number(stu.departure.time) : null;
        const sec = Number.isFinite(arrSec) ? arrSec : depSec;
        if (!Number.isFinite(sec)) continue;

        const mins = Math.round((sec * 1000 - nowMs) / 60000);
        const dueText = formatDueFromMinutes(mins);
        if (!dueText) continue;

        tripRows.push({
          line: tu.trip?.routeId || "—",
          destination: "—",
          dueText,
          _mins: mins,
        });
      }
    }

    tripRows.sort((a, b) => (a._mins ?? 999999) - (b._mins ?? 999999));
    if (tripRows.length) {
      return res.json(tripRows.slice(0, 6).map(({ _mins, ...r }) => r));
    }

    // ---------- 2) Fallback: estimate using live bus positions ----------
    if (!stop) {
      // Can't estimate without stop coordinates
      return res.json([]);
    }

    // Haversine distance (meters)
    function distMeters(lat1, lon1, lat2, lon2) {
      const R = 6371000;
      const toRad = (x) => (x * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    }

    const estimates = [];

    for (const entity of feed.entity) {
      const v = entity.vehicle;
      if (!v?.position) continue;

      const lat = v.position.latitude;
      const lon = v.position.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const d = distMeters(lat, lon, stop.lat, stop.lon);

      // speed from feed is usually meters/second, but often missing/0
      let speed = Number.isFinite(v.position.speed) ? v.position.speed : null;
      if (!speed || speed <= 0) speed = 6; // default ~13 mph

      const mins = Math.round(d / speed / 60);
      const dueText = formatDueFromMinutes(mins);
      if (!dueText) continue;

      estimates.push({
        line: v.trip?.routeId || "—",
        destination: "—",
        dueText,
        _mins: mins,
      });
    }

    estimates.sort((a, b) => (a._mins ?? 999999) - (b._mins ?? 999999));
    return res.json(estimates.slice(0, 6).map(({ _mins, ...r }) => r));
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});


// ---------- Start ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
