/* eslint-disable */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { parse } = require("csv-parse/sync");
const { XMLParser } = require("fast-xml-parser");

// Load .env
require("dotenv").config();

const app = express();
app.use(cors());

/** ---------------- PATHS ---------------- */
const DATA_DIR = path.join(__dirname, "data");
const GTFS_DIR = path.join(DATA_DIR, "gtfs");
const STOPS_FILE = path.join(DATA_DIR, "naptan_peterborough.csv");

/** ---------------- ENV ---------------- */
const PORT = Number(process.env.PORT || 3001);

const BODS_API_KEY = process.env.BODS_API_KEY || "";
const BODS_VM_FEED_ID = process.env.BODS_VM_FEED_ID || "";

// You can either set BODS_SIRI_VM_URL directly, OR set BODS_API_KEY + BODS_VM_FEED_ID
const BODS_SIRI_VM_URL =
  process.env.BODS_SIRI_VM_URL ||
  (BODS_VM_FEED_ID && BODS_API_KEY
    ? `https://data.bus-data.dft.gov.uk/api/v1/datafeed/${encodeURIComponent(
        BODS_VM_FEED_ID
      )}/?api_key=${encodeURIComponent(BODS_API_KEY)}`
    : "");

/** ---------------- XML PARSER ---------------- */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

/** ---------------- HELPERS ---------------- */
function readTextSmart(filePath) {
  const buf = fs.readFileSync(filePath);
  let text = buf.toString("utf8");
  const nullCount = [...buf.slice(0, 200)].filter((b) => b === 0).length;
  if (nullCount > 20) text = buf.toString("utf16le");
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseCsvSmart(filePath) {
  const txt = readTextSmart(filePath);
  return parse(txt, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    bom: true,
  });
}

function yyyymmdd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function timeToSeconds(t) {
  if (!t || typeof t !== "string") return NaN;
  const parts = t.split(":");
  if (parts.length < 2) return NaN;
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  const ss = Number(parts[2] || 0);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return NaN;
  return hh * 3600 + mm * 60 + ss;
}

function secondsToDueText(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds <= 60) return "DUE";
  const mins = Math.round(seconds / 60);
  return `${mins}m`;
}

/** ---------------- LOAD NaPTAN STOPS ---------------- */
let NAPTAN_STOPS = [];

function loadNaPTAN() {
  if (!fs.existsSync(STOPS_FILE)) {
    console.warn("NaPTAN file not found:", STOPS_FILE);
    NAPTAN_STOPS = [];
    return;
  }

  const rows = parseCsvSmart(STOPS_FILE);

  NAPTAN_STOPS = rows
    .map((r) => ({
      atcoCode:
        r.ATCOCode ||
        r.atcocode ||
        r.AtcoCode ||
        r.atcoCode ||
        r.ATCO ||
        r.atco ||
        "",
      commonName: r.CommonName || r.commonname || r.Common || r.commonName || "",
      indicator: r.Indicator || r.indicator || "",
      localityName:
        r.LocalityName || r.localityname || r.Locality || r.localityName || "",
      lat: Number(r.Latitude || r.latitude || r.Lat || r.lat || NaN),
      lon: Number(r.Longitude || r.longitude || r.Lon || r.lon || NaN),
    }))
    .filter((s) => s.atcoCode);

  console.log(`NaPTAN loaded: ${NAPTAN_STOPS.length} stops`);
}

/** ---------------- LOAD GTFS INTO SQLITE ---------------- */
const db = new Database(":memory:");

function createTables() {
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;

    DROP TABLE IF EXISTS stops;
    DROP TABLE IF EXISTS routes;
    DROP TABLE IF EXISTS trips;
    DROP TABLE IF EXISTS stop_times;
    DROP TABLE IF EXISTS calendar;
    DROP TABLE IF EXISTS calendar_dates;

    CREATE TABLE stops (
      stop_id TEXT,
      stop_code TEXT,
      stop_name TEXT,
      stop_lat REAL,
      stop_lon REAL
    );

    CREATE TABLE routes (
      route_id TEXT,
      route_short_name TEXT,
      route_long_name TEXT
    );

    CREATE TABLE trips (
      route_id TEXT,
      service_id TEXT,
      trip_id TEXT,
      trip_headsign TEXT
    );

    CREATE TABLE stop_times (
      trip_id TEXT,
      arrival_time TEXT,
      departure_time TEXT,
      stop_id TEXT,
      stop_sequence INTEGER
    );

    CREATE TABLE calendar (
      service_id TEXT,
      monday INTEGER,
      tuesday INTEGER,
      wednesday INTEGER,
      thursday INTEGER,
      friday INTEGER,
      saturday INTEGER,
      sunday INTEGER,
      start_date TEXT,
      end_date TEXT
    );

    CREATE TABLE calendar_dates (
      service_id TEXT,
      date TEXT,
      exception_type INTEGER
    );

    CREATE INDEX idx_stop_times_stop ON stop_times(stop_id, departure_time);
    CREATE INDEX idx_trips_trip ON trips(trip_id);
    CREATE INDEX idx_trips_service ON trips(service_id);
  `);
}

let calendarByService = new Map();
let exceptionsByService = new Map();

function loadCalendarMaps() {
  calendarByService = new Map();
  exceptionsByService = new Map();

  const calRows = db.prepare("SELECT * FROM calendar").all();
  for (const r of calRows) calendarByService.set(r.service_id, r);

  const exRows = db.prepare("SELECT * FROM calendar_dates").all();
  for (const r of exRows) {
    if (!exceptionsByService.has(r.service_id)) exceptionsByService.set(r.service_id, new Map());
    exceptionsByService.get(r.service_id).set(r.date, r.exception_type);
  }
}

function serviceRunsOn(service_id, dateYYYYMMDD) {
  const ex = exceptionsByService.get(service_id)?.get(dateYYYYMMDD);
  if (ex === 1) return true;
  if (ex === 2) return false;

  const cal = calendarByService.get(service_id);
  if (!cal) return false;

  if (dateYYYYMMDD < cal.start_date || dateYYYYMMDD > cal.end_date) return false;

  const y = Number(dateYYYYMMDD.slice(0, 4));
  const m = Number(dateYYYYMMDD.slice(4, 6)) - 1;
  const d = Number(dateYYYYMMDD.slice(6, 8));
  const dt = new Date(y, m, d);
  const dow = dt.getDay();

  const flags = {
    0: cal.sunday,
    1: cal.monday,
    2: cal.tuesday,
    3: cal.wednesday,
    4: cal.thursday,
    5: cal.friday,
    6: cal.saturday,
  };

  return Number(flags[dow]) === 1;
}

/** --- GTFS stop lookup sets (hide stops with no timetable) --- */
let GTFS_STOP_IDS = new Set();
let GTFS_STOP_CODES = new Set();

function rebuildGtfsStopSets() {
  GTFS_STOP_IDS = new Set();
  GTFS_STOP_CODES = new Set();

  const rows = db.prepare("SELECT stop_id, stop_code FROM stops").all();
  for (const r of rows) {
    if (r.stop_id) GTFS_STOP_IDS.add(String(r.stop_id).trim());
    if (r.stop_code) GTFS_STOP_CODES.add(String(r.stop_code).trim());
  }

  console.log(
    `GTFS stop sets ready: ids=${GTFS_STOP_IDS.size}, codes=${GTFS_STOP_CODES.size}`
  );
}

function hasTimetableForAtco(atco) {
  if (!atco) return false;
  const key = String(atco).trim();
  return GTFS_STOP_IDS.has(key) || GTFS_STOP_CODES.has(key);
}

function loadGtfs() {
  createTables();

  const must = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"];
  for (const f of must) {
    const fp = path.join(GTFS_DIR, f);
    if (!fs.existsSync(fp)) console.warn("Missing GTFS file:", fp);
  }

  // stops
  const stopsFp = path.join(GTFS_DIR, "stops.txt");
  if (fs.existsSync(stopsFp)) {
    const rows = parseCsvSmart(stopsFp);
    const stmt = db.prepare(
      "INSERT INTO stops(stop_id, stop_code, stop_name, stop_lat, stop_lon) VALUES (?,?,?,?,?)"
    );
    const ins = db.transaction((rs) => {
      for (const r of rs) {
        stmt.run(
          r.stop_id || "",
          r.stop_code || "",
          r.stop_name || "",
          Number(r.stop_lat || NaN),
          Number(r.stop_lon || NaN)
        );
      }
    });
    ins(rows);
  }

  // routes
  const routesFp = path.join(GTFS_DIR, "routes.txt");
  if (fs.existsSync(routesFp)) {
    const rows = parseCsvSmart(routesFp);
    const stmt = db.prepare(
      "INSERT INTO routes(route_id, route_short_name, route_long_name) VALUES (?,?,?)"
    );
    const ins = db.transaction((rs) => {
      for (const r of rs) {
        stmt.run(r.route_id || "", r.route_short_name || "", r.route_long_name || "");
      }
    });
    ins(rows);
  }

  // trips
  const tripsFp = path.join(GTFS_DIR, "trips.txt");
  if (fs.existsSync(tripsFp)) {
    const rows = parseCsvSmart(tripsFp);
    const stmt = db.prepare(
      "INSERT INTO trips(route_id, service_id, trip_id, trip_headsign) VALUES (?,?,?,?)"
    );
    const ins = db.transaction((rs) => {
      for (const r of rs) {
        stmt.run(r.route_id || "", r.service_id || "", r.trip_id || "", r.trip_headsign || "");
      }
    });
    ins(rows);
  }

  // stop_times
  const stFp = path.join(GTFS_DIR, "stop_times.txt");
  if (fs.existsSync(stFp)) {
    const rows = parseCsvSmart(stFp);
    const stmt = db.prepare(
      "INSERT INTO stop_times(trip_id, arrival_time, departure_time, stop_id, stop_sequence) VALUES (?,?,?,?,?)"
    );
    const ins = db.transaction((rs) => {
      for (const r of rs) {
        stmt.run(
          r.trip_id || "",
          r.arrival_time || "",
          r.departure_time || "",
          r.stop_id || "",
          Number(r.stop_sequence || 0)
        );
      }
    });
    ins(rows);
  }

  // calendar (optional)
  const calFp = path.join(GTFS_DIR, "calendar.txt");
  if (fs.existsSync(calFp)) {
    const rows = parseCsvSmart(calFp);
    const stmt = db.prepare(
      `INSERT INTO calendar(service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    const ins = db.transaction((rs) => {
      for (const r of rs) {
        stmt.run(
          r.service_id || "",
          Number(r.monday || 0),
          Number(r.tuesday || 0),
          Number(r.wednesday || 0),
          Number(r.thursday || 0),
          Number(r.friday || 0),
          Number(r.saturday || 0),
          Number(r.sunday || 0),
          r.start_date || "",
          r.end_date || ""
        );
      }
    });
    ins(rows);
  }

  // calendar_dates (optional)
  const caldFp = path.join(GTFS_DIR, "calendar_dates.txt");
  if (fs.existsSync(caldFp)) {
    const rows = parseCsvSmart(caldFp);
    const stmt = db.prepare(
      "INSERT INTO calendar_dates(service_id, date, exception_type) VALUES (?,?,?)"
    );
    const ins = db.transaction((rs) => {
      for (const r of rs) {
        stmt.run(r.service_id || "", r.date || "", Number(r.exception_type || 0));
      }
    });
    ins(rows);
  }

  loadCalendarMaps();
  rebuildGtfsStopSets();

  const counts = {
    stops: db.prepare("SELECT COUNT(*) c FROM stops").get().c,
    routes: db.prepare("SELECT COUNT(*) c FROM routes").get().c,
    trips: db.prepare("SELECT COUNT(*) c FROM trips").get().c,
    stop_times: db.prepare("SELECT COUNT(*) c FROM stop_times").get().c,
  };
  console.log("GTFS loaded:", counts);
}

loadNaPTAN();
loadGtfs();

/** ---------------- HEALTH ---------------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** ---------------- STOPS SEARCH (NaPTAN) ----------------
 * default: timetabled only (timetabled=1)
 */
app.get("/api/stops", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json([]);

  const timetabledOnly = String(req.query.timetabled ?? "1") === "1";

  const out = NAPTAN_STOPS.filter((s) => {
    const hay = `${s.commonName} ${s.indicator} ${s.localityName} ${s.atcoCode}`.toLowerCase();
    if (!hay.includes(q)) return false;
    if (timetabledOnly) return hasTimetableForAtco(s.atcoCode);
    return true;
  }).slice(0, 100);

  res.json(out);
});

/** ---------------- LIVE BUSES (SIRI-VM) ---------------- */
app.get("/api/live-buses", async (req, res) => {
  try {
    if (!BODS_SIRI_VM_URL) {
      return res.status(500).json({ error: "Missing BODS_SIRI_VM_URL (or BODS_API_KEY + BODS_VM_FEED_ID) in .env" });
    }

    const bboxStr = String(req.query.bbox || "52.50,52.65,-0.40,-0.10");
    const limit = Math.max(1, Math.min(300, Number(req.query.limit || 80)));

    const parts = bboxStr.split(",").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return res.status(400).json({ error: "bbox must be minLat,maxLat,minLon,maxLon" });
    }
    const [minLat, maxLat, minLon, maxLon] = parts;

    const response = await fetch(BODS_SIRI_VM_URL);
    if (!response.ok) {
      return res.status(500).json({ error: `Failed to fetch BODS SIRI-VM feed (HTTP ${response.status})` });
    }

    const xml = await response.text();
    const json = xmlParser.parse(xml);

    const vehicles =
      json?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.VehicleActivity || [];

    const buses = vehicles
      .map((v) => {
        const journey = v.MonitoredVehicleJourney || {};
        return {
          vehicleId: journey.VehicleRef || null,
          routeId: journey.LineRef || null,
          tripId: journey.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || null,
          lat: Number(journey.VehicleLocation?.Latitude),
          lon: Number(journey.VehicleLocation?.Longitude),
          bearing: Number(journey.Bearing ?? 0),
          speed: Number(journey.Velocity ?? 0),
          timestamp: Math.floor(Date.now() / 1000),
        };
      })
      .filter(
        (b) =>
          Number.isFinite(b.lat) &&
          Number.isFinite(b.lon) &&
          b.lat >= minLat &&
          b.lat <= maxLat &&
          b.lon >= minLon &&
          b.lon <= maxLon
      )
      .slice(0, limit);

    res.json({
      ok: true,
      bbox: { minLat, maxLat, minLon, maxLon },
      count: buses.length,
      buses,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || "live-buses failed" });
  }
});

/** ---------------- NEXT DEPARTURES (GTFS STATIC TIMETABLE) ----------------
 * Returns: [{ line, destination, dueText, depTime }]
 */
app.get("/api/next", (req, res) => {
  try {
    const atco = String(req.query.atco || "").trim();
    const limit = Math.max(1, Math.min(20, Number(req.query.limit || 6)));
    if (!atco) return res.status(400).json({ error: "Missing atco" });

    // Find matching GTFS stop_ids for this ATCO (stop_id or stop_code often matches)
    const stopRows = db
      .prepare(
        `
        SELECT stop_id, stop_code, stop_name
        FROM stops
        WHERE stop_id = ?
           OR stop_code = ?
           OR stop_id LIKE ?
           OR stop_code LIKE ?
        LIMIT 50
      `
      )
      .all(atco, atco, `%${atco}%`, `%${atco}%`);

    const stopIds = [...new Set(stopRows.map((r) => r.stop_id).filter(Boolean))];
    if (!stopIds.length) return res.json([]);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayKey = yyyymmdd(today);

    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yesterdayKey = yyyymmdd(yesterday);

    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    // Handle GTFS times like 25:10:00 (after midnight, still in service day)
    const contexts =
      nowSec < 4 * 3600
        ? [
            { serviceDate: yesterdayKey, nowAbs: 86400 + nowSec },
            { serviceDate: todayKey, nowAbs: nowSec },
          ]
        : [{ serviceDate: todayKey, nowAbs: nowSec }];

    const stmt = db.prepare(
      `
      SELECT
        st.trip_id,
        st.departure_time,
        t.service_id,
        t.trip_headsign,
        r.route_short_name,
        r.route_long_name,
        r.route_id
      FROM stop_times st
      JOIN trips t ON t.trip_id = st.trip_id
      LEFT JOIN routes r ON r.route_id = t.route_id
      WHERE st.stop_id = ?
      LIMIT 2000
    `
    );

    let candidates = [];
    for (const stopId of stopIds) {
      const rows = stmt.all(stopId);
      for (const row of rows) {
        const depSec = timeToSeconds(row.departure_time);
        if (!Number.isFinite(depSec)) continue;

        candidates.push({
          depSec,
          depTime: row.departure_time,
          service_id: row.service_id,
          line: row.route_short_name || row.route_long_name || row.route_id || "—",
          destination: row.trip_headsign || "—",
        });
      }
    }

    let upcoming = [];
    for (const c of candidates) {
      for (const ctx of contexts) {
        if (!serviceRunsOn(c.service_id, ctx.serviceDate)) continue;

        const dueSeconds = c.depSec - ctx.nowAbs;
        if (dueSeconds < 0) continue;

        upcoming.push({
          line: c.line,
          destination: c.destination,
          dueSeconds,
          depTime: c.depTime,
        });
        break;
      }
    }

    upcoming.sort((a, b) => a.dueSeconds - b.dueSeconds);

    const out = upcoming.slice(0, limit).map((x) => ({
      line: x.line,
      destination: x.destination,
      dueText: secondsToDueText(x.dueSeconds),
      depTime: x.depTime,
    }));

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err?.message || "next failed" });
  }
});

/** ---------------- 404 JSON ---------------- */
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

/** ---------------- START ---------------- */
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  console.log(`Stops CSV: ${STOPS_FILE} ${fs.existsSync(STOPS_FILE) ? "(found)" : "(missing)"}`);
  console.log(`GTFS dir: ${GTFS_DIR} ${fs.existsSync(GTFS_DIR) ? "(found)" : "(missing)"}`);
  console.log(`BODS_SIRI_VM_URL: ${BODS_SIRI_VM_URL ? "(set)" : "(missing)"}`);
});