/* eslint-disable */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { parse } = require("csv-parse/sync");

const app = express();
app.use(cors());

const DATA_DIR = path.join(__dirname, "data");
const GTFS_DIR = path.join(DATA_DIR, "gtfs");
const NAPTAN_FILE = path.join(DATA_DIR, "naptan_peterborough.csv");

/** ---------------- HEALTH ---------------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** ---------------- READ FILE SAFELY (UTF8/UTF16 + skip blank lines) ---------------- */
function readTextSmart(filePath) {
  const buf = fs.readFileSync(filePath);

  // If there are lots of 0x00 bytes, it's probably UTF-16LE
  let nullCount = 0;
  for (let i = 0; i < Math.min(buf.length, 2000); i++) {
    if (buf[i] === 0) nullCount++;
  }
  const looksUtf16 = nullCount > 10;

  let text = looksUtf16 ? buf.toString("utf16le") : buf.toString("utf8");

  // Remove BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  return { text, looksUtf16, size: buf.length };
}

function firstNonEmptyLine(text) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line && line.trim() !== "") return line;
  }
  return null;
}

/** ---------------- DEBUG: CONFIRM FILE + HEADER + SAMPLE ---------------- */
app.get("/api/debug-naptan", (req, res) => {
  try {
    const exists = fs.existsSync(NAPTAN_FILE);
    if (!exists) {
      return res.json({ naptanFile: NAPTAN_FILE, exists: false });
    }

    const { text, looksUtf16, size } = readTextSmart(NAPTAN_FILE);

    const firstLine = firstNonEmptyLine(text);
    const sample = text.slice(0, 300);

    res.json({
      naptanFile: NAPTAN_FILE,
      exists: true,
      sizeBytes: size,
      looksUtf16,
      firstLine,
      sampleFirst300Chars: sample,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "debug failed" });
  }
});

/** ---------------- NaPTAN STOP SEARCH ---------------- */
let stopsCache = null;

function loadStops() {
  if (stopsCache) return stopsCache;

  if (!fs.existsSync(NAPTAN_FILE)) {
    console.error("❌ NaPTAN CSV not found at:", NAPTAN_FILE);
    stopsCache = [];
    return stopsCache;
  }

  const { text, looksUtf16, size } = readTextSmart(NAPTAN_FILE);

  if (!text || text.trim() === "") {
    console.error("❌ NaPTAN CSV is empty/blank:", NAPTAN_FILE, "size:", size);
    stopsCache = [];
    return stopsCache;
  }

  // Parse CSV with headers; handle weird exports safely
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });

  // safe getter for different possible header names
  const get = (row, keys) =>
    keys
      .map((k) => row[k])
      .find((v) => v !== undefined && v !== null && String(v).trim() !== "") ?? "";

  const stops = rows.map((r) => {
    const atco = get(r, [
      "AtcoCode",
      "ATCOCode",
      "ATCO",
      "StopPointRef",
      "StopPoint",
      "StopPointRef (ATCO)",
      "stop_id",
    ]);

    const commonName =
      get(r, ["CommonName", "Name", "DescriptorCommonName", "StopName"]) || "Stop";

    const indicator = get(r, ["Indicator", "StopIndicator"]) || "";
    const localityName = get(r, ["LocalityName", "Locality", "Town"]) || "";

    const latRaw = get(r, ["Latitude", "Lat", "StopLatitude"]);
    const lonRaw = get(r, ["Longitude", "Lon", "StopLongitude"]);

    const lat = Number(String(latRaw).trim());
    const lon = Number(String(lonRaw).trim());

    return {
      atcoCode: String(atco).trim(),
      commonName: String(commonName).trim(),
      indicator: String(indicator).trim(),
      localityName: String(localityName).trim(),
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
    };
  });

  // Keep anything with an ATCO code
  stopsCache = stops.filter((s) => s.atcoCode);

  console.log(
    `✅ Loaded NaPTAN stops: ${stopsCache.length} (from ${path.basename(
      NAPTAN_FILE
    )}) utf16=${looksUtf16}`
  );

  return stopsCache;
}

app.get("/api/stops", (req, res) => {
  try {
    const q = String(req.query.q || "").toLowerCase().trim();
    const stops = loadStops();

    if (!q) return res.json(stops.slice(0, 200));

    const filtered = stops
      .filter((s) =>
        `${s.commonName} ${s.indicator} ${s.localityName} ${s.atcoCode}`
          .toLowerCase()
          .includes(q)
      )
      .slice(0, 50);

    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to search stops" });
  }
});

/** ---------------- (OPTIONAL) GTFS NEXT BUSES (scheduled) ---------------- */
const db = new Database(":memory:");

function readGTFS(filename) {
  const filePath = path.join(GTFS_DIR, filename);
  const txt = fs.readFileSync(filePath, "utf8");
  return parse(txt, { columns: true, skip_empty_lines: true, bom: true });
}

function ensureGtfsLoaded() {
  const has = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stop_times'")
    .get();
  if (has) return;

  db.exec(`
    CREATE TABLE routes(route_id TEXT, route_short_name TEXT, route_long_name TEXT);
    CREATE TABLE trips(trip_id TEXT, route_id TEXT, service_id TEXT, trip_headsign TEXT);
    CREATE TABLE stop_times(trip_id TEXT, arrival_time TEXT, departure_time TEXT, stop_id TEXT, stop_sequence INTEGER);
    CREATE TABLE stops(stop_id TEXT, stop_name TEXT, stop_lat REAL, stop_lon REAL);

    CREATE INDEX idx_stop_times_stop_id ON stop_times(stop_id);
    CREATE INDEX idx_stop_times_trip_id ON stop_times(trip_id);
    CREATE INDEX idx_trips_trip_id ON trips(trip_id);
  `);

  const routes = readGTFS("routes.txt");
  const trips = readGTFS("trips.txt");
  const stopTimes = readGTFS("stop_times.txt");
  const stops = readGTFS("stops.txt");

  const insRoute = db.prepare(
    "INSERT INTO routes(route_id, route_short_name, route_long_name) VALUES (?,?,?)"
  );
  const insTrip = db.prepare(
    "INSERT INTO trips(trip_id, route_id, service_id, trip_headsign) VALUES (?,?,?,?)"
  );
  const insStopTime = db.prepare(
    "INSERT INTO stop_times(trip_id, arrival_time, departure_time, stop_id, stop_sequence) VALUES (?,?,?,?,?)"
  );
  const insStop = db.prepare(
    "INSERT INTO stops(stop_id, stop_name, stop_lat, stop_lon) VALUES (?,?,?,?)"
  );

  const tx = db.transaction(() => {
    for (const r of routes) insRoute.run(r.route_id, r.route_short_name, r.route_long_name);
    for (const t of trips) insTrip.run(t.trip_id, t.route_id, t.service_id, t.trip_headsign);
    for (const s of stops) insStop.run(s.stop_id, s.stop_name, Number(s.stop_lat), Number(s.stop_lon));
    for (const st of stopTimes)
      insStopTime.run(st.trip_id, st.arrival_time, st.departure_time, st.stop_id, Number(st.stop_sequence));
  });
  tx();

  console.log("✅ GTFS loaded into memory");
}

function timeToSeconds(t) {
  const [h, m, s] = String(t).split(":").map(Number);
  if (![h, m, s].every(Number.isFinite)) return null;
  return h * 3600 + m * 60 + s;
}

function nowSeconds() {
  const d = new Date();
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

app.get("/api/next", (req, res) => {
  try {
    ensureGtfsLoaded();

    const stopId = String(req.query.stopId || "").trim();
    if (!stopId) return res.status(400).json({ error: "Missing ?stopId=" });

    const limit = Math.min(Number(req.query.limit || 10), 25);
    const now = nowSeconds();

    const rows = db
      .prepare(
        `
        SELECT st.trip_id, st.departure_time, t.route_id, t.trip_headsign,
               r.route_short_name, r.route_long_name
        FROM stop_times st
        JOIN trips t ON t.trip_id = st.trip_id
        JOIN routes r ON r.route_id = t.route_id
        WHERE st.stop_id = ?
        `
      )
      .all(stopId);

    const next = rows
      .map((x) => {
        const depSec = timeToSeconds(x.departure_time);
        if (depSec == null) return null;
        return {
          route: x.route_short_name || x.route_id,
          destination: x.trip_headsign || x.route_long_name || "",
          departureTime: x.departure_time,
          dueMin: Math.max(0, Math.round((depSec - now) / 60)),
          depSec,
        };
      })
      .filter((x) => x && x.depSec >= now)
      .sort((a, b) => a.depSec - b.depSec)
      .slice(0, limit);

    res.json({ stopId, source: "gtfs-scheduled", next });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

/** ---------------- START SERVER ---------------- */
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ API running on http://localhost:${PORT}`);
  console.log(`🔎 Debug NaPTAN: http://localhost:${PORT}/api/debug-naptan`);
});