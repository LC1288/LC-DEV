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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** ---------- STOP DATA (NaPTAN CSV) ---------- **/
let stopsCache = null;

function loadStops() {
  if (stopsCache) return stopsCache;

  const csv = fs.readFileSync(NAPTAN_FILE, "utf8");
  const rows = parse(csv, { columns: true, skip_empty_lines: true });

  // Helper: safely read a value from different possible CSV header names
  const get = (row, keys) =>
    keys.map((k) => row[k]).find((v) => v !== undefined && v !== "") ?? "";

  // NOTE: we removed the startsWith("059") filter because your CSV is already Peterborough-only,
  // and some NaPTAN exports use different header names.
  stopsCache = rows
    .map((r) => ({
      atcoCode: get(r, ["AtcoCode", "ATCOCode", "atcocode", "StopPointRef", "stop_id"]),
      commonName:
        get(r, ["CommonName", "common_name", "Name", "DescriptorCommonName"]) || "Stop",
      indicator: get(r, ["Indicator", "indicator"]) || "",
      localityName: get(r, ["LocalityName", "locality_name", "Locality"]) || "",
      lat: Number(get(r, ["Latitude", "lat", "StopLatitude"])),
      lon: Number(get(r, ["Longitude", "lon", "StopLongitude"])),
    }))
    .filter((s) => s.atcoCode)
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));

  return stopsCache;
}

app.get("/api/stops", (req, res) => {
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
});

/** ---------- GTFS -> SQLite ---------- **/
const db = new Database(":memory:");

function readGTFS(filename) {
  const filePath = path.join(GTFS_DIR, filename);
  const txt = fs.readFileSync(filePath, "utf8");
  return parse(txt, { columns: true, skip_empty_lines: true });
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
      insStopTime.run(
        st.trip_id,
        st.arrival_time,
        st.departure_time,
        st.stop_id,
        Number(st.stop_sequence)
      );
  });
  tx();
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

app.listen(3001, () => console.log("API running on http://localhost:3001"));