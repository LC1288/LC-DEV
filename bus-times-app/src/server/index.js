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

const PORT = process.env.PORT || 3001;
const BODS_API_KEY = process.env.BODS_API_KEY;

// ✅ Your NaPTAN file (as requested)
const STOPS_FILE = path.join(__dirname, "data", "naptan_peterborough.csv");

// ✅ Peterborough bbox (south,north,west,east)
const PETERBOROUGH_BBOX = "52.50,52.70,-0.40,-0.10";

// ✅ Limit buses shown on map
const MAX_BUSES = 40;

// Sort buses closest to centre first (Queensgate-ish)
const CENTRE_LAT = 52.5746;
const CENTRE_LON = -0.2417;

/* =============================
   STOPS CACHE
============================= */
let STOP_CACHE = null;

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== "") return obj[k];
  }
  return "";
}

function loadStops() {
  if (!fs.existsSync(STOPS_FILE)) {
    throw new Error(
      `Missing stops file at: ${STOPS_FILE}\nPut naptan_peterborough.csv in src/server/data/.`
    );
  }

  const raw = fs.readFileSync(STOPS_FILE, "utf8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
  });

  const stops = [];
  const byAtco = new Map();

  for (const r of rows) {
    const atcoCode = String(
      pick(r, ["ATCOCode", "AtcoCode", "atcoCode", "StopPointRef"])
    ).trim();
    if (!atcoCode) continue;

    const commonName = String(
      pick(r, ["CommonName", "commonName", "StopName", "DescriptorCommonName"])
    ).trim();

    const indicator = String(
      pick(r, ["Indicator", "indicator", "StopIndicator", "DescriptorIndicator"])
    ).trim();

    const localityName = String(
      pick(r, ["LocalityName", "localityName", "NptgLocalityName", "Locality"])
    ).trim();

    const latStr = pick(r, ["Latitude", "latitude", "Lat", "lat"]);
    const lonStr = pick(r, ["Longitude", "longitude", "Lon", "lon", "Lng", "lng"]);

    const lat = Number(latStr);
    const lon = Number(lonStr);

    const stop = {
      atcoCode,
      commonName: commonName || atcoCode,
      indicator,
      localityName,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
    };

    stops.push(stop);
    byAtco.set(atcoCode, stop);
  }

  return { stops, byAtco };
}

function getStopCache() {
  if (!STOP_CACHE) STOP_CACHE = loadStops();
  return STOP_CACHE;
}

/* =============================
   HELPERS
============================= */
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function dueTextFromMins(mins) {
  if (!Number.isFinite(mins)) return "—";
  if (mins <= 0) return "DUE";
  return `${mins}m`;
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/* =============================
   BODS GTFS-RT FEED
============================= */
async function fetchGtfsRtFeed() {
  if (!BODS_API_KEY) throw new Error("Missing BODS_API_KEY in src/server/.env");

  const url =
    `https://data.bus-data.dft.gov.uk/api/v1/gtfsrtdatafeed/` +
    `?boundingBox=${encodeURIComponent(PETERBOROUGH_BBOX)}` +
    `&api_key=${encodeURIComponent(BODS_API_KEY)}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(
      `BODS request failed: ${resp.status} ${resp.statusText} :: ${txt.slice(
        0,
        200
      )}`
    );
  }

  const ab = await resp.arrayBuffer();
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    new Uint8Array(ab)
  );
}

/* =============================
   ROUTES
============================= */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * ✅ Debug: stops file loads
 */
app.get("/api/debug/stops-health", (req, res) => {
  try {
    const { stops } = getStopCache();
    res.json({
      ok: true,
      file: STOPS_FILE,
      count: stops.length,
      sample: stops.slice(0, 3),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e), file: STOPS_FILE });
  }
});

/**
 * ✅ Debug: count TripUpdates / StopTimeUpdates in the RT feed
 */
app.get("/api/debug/tu-count", async (req, res) => {
  try {
    const feed = await fetchGtfsRtFeed();
    let tripUpdates = 0;
    let stopTimeUpdates = 0;

    for (const e of feed.entity) {
      if (e.tripUpdate) {
        tripUpdates++;
        stopTimeUpdates += e.tripUpdate.stopTimeUpdate?.length || 0;
      }
    }

    res.json({ ok: true, tripUpdates, stopTimeUpdates });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * ✅ Stops search
 * GET /api/stops?q=queensgate
 */
app.get("/api/stops", (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    if (!q) return res.json([]);

    const { stops } = getStopCache();

    function score(s) {
      const name = (s.commonName || "").toLowerCase();
      const loc = (s.localityName || "").toLowerCase();
      const ind = (s.indicator || "").toLowerCase();
      const atco = (s.atcoCode || "").toLowerCase();

      const hit =
        name.includes(q) || loc.includes(q) || ind.includes(q) || atco.includes(q);
      if (!hit) return 0;

      let sc = 1;
      if (name === q) sc += 100;
      if (name.startsWith(q)) sc += 50;
      if (loc.includes("peterborough")) sc += 20;

      if (q.includes("queensgate") && name.includes("queensgate")) sc += 200;
      if (q === "queens" && name.includes("queensgate")) sc += 100;

      return sc;
    }

    const results = stops
      .map((s) => ({ s, sc: score(s) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 120)
      .map(({ s }) => ({
        atcoCode: s.atcoCode,
        commonName: s.commonName,
        indicator: s.indicator,
        localityName: s.localityName,
      }));

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: "Stops API failed", details: e.message || String(e) });
  }
});

/**
 * ✅ Live buses for map (limited)
 * GET /api/live-buses
 */
app.get("/api/live-buses", async (req, res) => {
  try {
    const feed = await fetchGtfsRtFeed();

    const buses = [];

    for (const entity of feed.entity) {
      const v = entity.vehicle;
      if (!v || !v.position) continue;

      const lat = v.position.latitude;
      const lon = v.position.longitude;
      if (typeof lat !== "number" || typeof lon !== "number") continue;

      const d = distanceMeters(lat, lon, CENTRE_LAT, CENTRE_LON);

      buses.push({
        vehicleId: v.vehicle?.id || entity.id || null,
        lat,
        lon,
        bearing: typeof v.position.bearing === "number" ? v.position.bearing : null,
        speed: typeof v.position.speed === "number" ? v.position.speed : null,
        timestamp: v.timestamp ? Number(v.timestamp) : null,
        routeId: v.trip?.routeId || null,
        tripId: v.trip?.tripId || null,
        _distance: d,
      });
    }

    buses.sort((a, b) => a._distance - b._distance);
    const limited = buses.slice(0, MAX_BUSES).map(({ _distance, ...rest }) => rest);

    res.json({
      ok: true,
      bbox: PETERBOROUGH_BBOX,
      count: limited.length,
      buses: limited,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * ✅ LED board live times
 * GET /api/next?atco=XXXX
 *
 * 1) TripUpdates (real ETAs if present)
 * 2) Fallback estimate using VehiclePositions + distance/speed
 */
app.get("/api/next", async (req, res) => {
  try {
    const atco = (req.query.atco || "").toString().trim();
    if (!atco) return res.status(400).json({ error: "Missing atco" });

    const feed = await fetchGtfsRtFeed();
    const { byAtco } = getStopCache();
    const nowMs = Date.now();

    // ------------------ 1) TripUpdates ------------------
    const rows = [];

    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu || !tu.stopTimeUpdate || tu.stopTimeUpdate.length === 0) continue;

      const lastStu = tu.stopTimeUpdate[tu.stopTimeUpdate.length - 1];
      const lastStopId = lastStu?.stopId;

      const destStop = lastStopId ? byAtco.get(lastStopId) : null;
      const destination =
        destStop?.commonName || destStop?.localityName || lastStopId || "—";

      for (const stu of tu.stopTimeUpdate) {
        if (stu.stopId !== atco) continue;

        const rawT = stu.arrival?.time || stu.departure?.time;
        if (!rawT) continue;

        // ✅ FIX: protobuf Long -> number conversion
        const sec =
          typeof rawT === "number"
            ? rawT
            : rawT?.toNumber
            ? rawT.toNumber()
            : Number(rawT);

        if (!Number.isFinite(sec)) continue;

        const mins = Math.round((sec * 1000 - nowMs) / 60000);

        rows.push({
          line: tu.trip?.routeId || "—",
          destination,
          dueText: dueTextFromMins(mins),
          _mins: mins,
        });
      }
    }

    if (rows.length > 0) {
      rows.sort((a, b) => (a._mins ?? 9999) - (b._mins ?? 9999));
      return res.json(rows.slice(0, 8).map(({ _mins, ...r }) => r));
    }

    // ------------------ 2) Fallback estimate ------------------
    const stop = byAtco.get(atco);
    if (!stop || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
      return res.json([]);
    }

    const est = [];

    for (const entity of feed.entity) {
      const v = entity.vehicle;
      if (!v || !v.position) continue;

      const lat = v.position.latitude;
      const lon = v.position.longitude;
      if (typeof lat !== "number" || typeof lon !== "number") continue;

      const d = distanceMeters(lat, lon, stop.lat, stop.lon);
      if (d > 2000) continue;

      const speed = safeNum(v.position.speed) ?? 7;
      const mins = Math.round(d / speed / 60);

      est.push({
        line: v.trip?.routeId || "—",
        destination: "—",
        dueText: dueTextFromMins(mins),
        _mins: mins,
      });
    }

    est.sort((a, b) => (a._mins ?? 9999) - (b._mins ?? 9999));
    res.json(est.slice(0, 8).map(({ _mins, ...r }) => r));
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ✅ Always JSON for unknown /api routes (prevents HTML breaking fetch)
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  console.log(`Stops file: ${STOPS_FILE}`);
  console.log(`Bbox: ${PETERBOROUGH_BBOX}`);
  console.log(`Live bus limit: ${MAX_BUSES}`);
});



