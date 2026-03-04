/* eslint-disable */
const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");
const { XMLParser } = require("fast-xml-parser");
require("dotenv").config();

const { getTripUpdatesMap } = require("./realtime_tripupdates");

const app = express();
app.use(cors());

const PORT = Number(process.env.PORT || 3001);
const DB_PATH = path.resolve(process.env.DB_PATH || "./db/gtfs.sqlite");
const NEAREST_RADIUS_METERS = Number(process.env.NEAREST_RADIUS_METERS || 900);
const LOOKAHEAD_MINUTES = Number(process.env.LOOKAHEAD_MINUTES || 180);

// BODS SIRI-VM AVL feed (vehicle locations)
const BODS_SIRIVM_URL = process.env.BODS_SIRIVM_URL || process.env.GTFS_RT_TRIPUPDATES_URL || "";

let db = null;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (e) {
  console.warn("GTFS DB not available yet:", e.message);
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

/** ---------- helpers ---------- */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function secondsFromHMS(hms) {
  const [h, m, s] = hms.split(":").map((x) => Number(x));
  return h * 3600 + m * 60 + (s || 0);
}

function nowSecondsSinceMidnight(now) {
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

function minsLabelFromDelta(deltaSeconds) {
  const mins = Math.round(deltaSeconds / 60);
  if (mins <= 1) return "Due";
  return `${mins} min`;
}

function formatHHMMFromEpoch(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function weekdayKey(d) {
  return ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][d.getDay()];
}

function activeServiceIds(dateStr, dateObj) {
  if (!db) return new Set();

  const wd = weekdayKey(dateObj);
  const hasCalendar = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='calendar'`)
    .get();

  let base = [];
  if (hasCalendar) {
    base = db.prepare(
      `SELECT service_id
       FROM calendar
       WHERE start_date <= ? AND end_date >= ? AND ${wd} = 1`
    ).all(dateStr, dateStr).map(r => r.service_id);
  }

  const ex = db.prepare(
    `SELECT service_id, exception_type FROM calendar_dates WHERE date = ?`
  ).all(dateStr);

  const set = new Set(base);
  for (const e of ex) {
    if (e.exception_type === 1) set.add(e.service_id);
    if (e.exception_type === 2) set.delete(e.service_id);
  }

  if (base.length === 0 && ex.length > 0) {
    const onlyAdded = ex.filter(e => e.exception_type === 1).map(e => e.service_id);
    return new Set(onlyAdded);
  }

  return set;
}

function nearestStop(lat, lon, radiusMeters) {
  if (!db) return null;

  const latDelta = radiusMeters / 111000;
  const lonDelta = radiusMeters / (111000 * Math.cos((lat * Math.PI) / 180));

  const candidates = db.prepare(
    `SELECT stop_id, stop_name, stop_lat, stop_lon, parent_station
     FROM stops
     WHERE stop_lat BETWEEN ? AND ?
       AND stop_lon BETWEEN ? AND ?`
  ).all(lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta);

  let best = null;
  for (const s of candidates) {
    if (s.stop_lat == null || s.stop_lon == null) continue;
    const d = haversineMeters(lat, lon, s.stop_lat, s.stop_lon);
    if (d <= radiusMeters && (!best || d < best.distance_m)) {
      best = { ...s, distance_m: d };
    }
  }
  return best;
}

function computeExpected({ nowEpoch, scheduledHms, rtEpochOrNull }) {
  const scheduledSec = secondsFromHMS(scheduledHms);
  const now = new Date(nowEpoch * 1000);
  const nowSec = nowSecondsSinceMidnight(now);

  const [h, m] = scheduledHms.split(":");
  const scheduledHHMM = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  if (!rtEpochOrNull) {
    const delta = scheduledSec - nowSec;
    return {
      expected: scheduledHHMM,
      mins: minsLabelFromDelta(delta),
      status: "scheduled"
    };
  }

  const expectedHHMM = formatHHMMFromEpoch(rtEpochOrNull);
  const deltaLive = rtEpochOrNull - nowEpoch;
  const scheduledEpochApprox = nowEpoch - nowSec + scheduledSec;
  const diff = rtEpochOrNull - scheduledEpochApprox;

  if (deltaLive <= 60) return { expected: "Due", mins: "Due", status: "due" };
  if (Math.abs(diff) <= 60) return { expected: "On time", mins: minsLabelFromDelta(deltaLive), status: "on_time" };
  if (diff > 60) return { expected: expectedHHMM, mins: minsLabelFromDelta(deltaLive), status: "delayed" };
  return { expected: expectedHHMM, mins: minsLabelFromDelta(deltaLive), status: "early" };
}

/** ---------- routes ---------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * LIVE VEHICLES from BODS SIRI-VM feed
 * GET /api/vehicles?lat=52.57&lon=-0.24&radius_km=15&limit=80
 */
app.get("/api/vehicles", async (req, res) => {
  if (!BODS_SIRIVM_URL) {
    return res.status(400).json({
      error:
        "Missing BODS_SIRIVM_URL in server/.env. Paste the BODS 'Use this data feed in your code' URL here."
    });
  }

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radiusKm = Number(req.query.radius_km || 15);
  const limit = Number(req.query.limit || 200);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "Provide lat and lon query params" });
  }

  try {
    const r = await fetch(BODS_SIRIVM_URL);
    if (!r.ok) {
      return res.status(502).json({ error: `BODS feed HTTP ${r.status}` });
    }

    const text = await r.text();
    const parsed = xml.parse(text);

    // SIRI structure varies a bit by operator/version.
    // We'll try multiple paths safely.
    const delivery =
      parsed?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery ||
      parsed?.Siri?.ServiceDelivery?.VehicleMonitoringDeliveries ||
      parsed?.Siri?.ServiceDelivery?.VehicleMonitoring ||
      null;

    let activities =
      delivery?.VehicleActivity ||
      delivery?.VehicleActivities ||
      parsed?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.VehicleActivity ||
      [];

    if (!Array.isArray(activities)) activities = [activities].filter(Boolean);

    const vehicles = [];
    for (const a of activities) {
      const mvj = a?.MonitoredVehicleJourney || a?.MonitoredVehicleJourneys;
      if (!mvj) continue;

      const loc = mvj?.VehicleLocation;
      const vlat = Number(loc?.Latitude);
      const vlon = Number(loc?.Longitude);
      if (!Number.isFinite(vlat) || !Number.isFinite(vlon)) continue;

      const distM = haversineMeters(lat, lon, vlat, vlon);
      if (distM > radiusKm * 1000) continue;

      const vehicleId = mvj?.VehicleRef || mvj?.Vehicle?.VehicleRef || mvj?.Vehicle?.Ref || null;
      const routeId = mvj?.LineRef || null;
      const tripId = mvj?.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || null;

      const timestampRaw = a?.RecordedAtTime || mvj?.RecordedAtTime || null;
      const timestamp = timestampRaw ? Math.floor(new Date(timestampRaw).getTime() / 1000) : null;

      vehicles.push({
        vehicleId,
        routeId,
        tripId,
        lat: vlat,
        lon: vlon,
        bearing: mvj?.Bearing != null ? Number(mvj.Bearing) : null,
        speed: mvj?.Velocity != null ? Number(mvj.Velocity) : null,
        timestamp
      });

      if (vehicles.length >= limit) break;
    }

    res.json({ ok: true, count: vehicles.length, vehicles });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to load vehicles" });
  }
});

/**
 * DEPARTURES (GTFS schedule + realtime fallback)
 * GET /api/departures?lat=...&lon=...
 */
app.get("/api/departures", async (req, res) => {
  if (!db) return res.status(500).json({ error: "GTFS DB not found. Run npm run import:gtfs" });

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "Provide lat and lon query params" });
  }

  const stop = nearestStop(lat, lon, NEAREST_RADIUS_METERS);
  if (!stop) {
    return res.json({ stop: null, departures: [], message: `No stops found within ${NEAREST_RADIUS_METERS}m` });
  }

  const now = new Date();
  const dateStr = yyyymmdd(now);
  const active = activeServiceIds(dateStr, now);
  const nowSec = nowSecondsSinceMidnight(now);
  const maxSec = nowSec + LOOKAHEAD_MINUTES * 60;
  const nowEpoch = Math.floor(now.getTime() / 1000);

  const rtMap = await getTripUpdatesMap(15000);

  const rows = db.prepare(
    `SELECT st.trip_id, st.departure_time, t.route_id, t.service_id, t.trip_headsign,
            r.route_short_name, r.route_long_name
     FROM stop_times st
     JOIN trips t ON t.trip_id = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     WHERE st.stop_id = ?
     LIMIT 4000`
  ).all(stop.stop_id);

  const departures = [];
  for (const r of rows) {
    if (!r.departure_time) continue;
    if (active.size && !active.has(r.service_id)) continue;

    const depSec = secondsFromHMS(r.departure_time);
    const inWindow =
      (depSec >= nowSec && depSec <= maxSec) ||
      (depSec >= nowSec + 86400 && depSec <= maxSec + 86400);
    if (!inWindow) continue;

    const rt = rtMap.get(`${r.trip_id}::${stop.stop_id}`);
    const rtEpoch = rt?.epoch ?? null;

    const expected = computeExpected({
      nowEpoch,
      scheduledHms: r.departure_time,
      rtEpochOrNull: rtEpoch
    });

    const [hh, mm] = r.departure_time.split(":");
    departures.push({
      route: r.route_short_name || r.route_long_name || "Bus",
      destination: r.trip_headsign || "",
      scheduled_time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      expected: expected.expected,
      mins: expected.mins,
      status: expected.status
    });
  }

  const toSortKey = (d) => {
    if (d.mins === "Due") return -1;
    const m = Number(String(d.mins).replace(" min", ""));
    if (Number.isFinite(m)) return m;
    return 9999;
  };

  departures.sort((a, b) => toSortKey(a) - toSortKey(b));

  res.json({
    stop: {
      stop_id: stop.stop_id,
      stop_name: stop.stop_name,
      distance_m: Math.round(stop.distance_m)
    },
    departures: departures.slice(0, 5),
    message: null
  });
});

/**
 * STOP SEARCH (from GTFS stops table)
 * GET /api/stops?q=queen&limit=20
 */
app.get("/api/stops", (req, res) => {
  if (!db) return res.status(500).json({ error: "GTFS DB not found. Run npm run import:gtfs" });

  const q = String(req.query.q || "").trim();
  const limit = Math.min(Number(req.query.limit || 25), 50);

  if (!q) return res.json({ ok: true, stops: [] });

  const like = `%${q.toLowerCase()}%`;

  const rows = db.prepare(
    `SELECT stop_id, stop_name, stop_lat, stop_lon
     FROM stops
     WHERE LOWER(stop_name) LIKE ?
        OR LOWER(stop_id) LIKE ?
     LIMIT ?`
  ).all(like, like, limit);

  res.json({
    ok: true,
    stops: rows.map(r => ({
      stop_id: r.stop_id,
      stop_name: r.stop_name,
      lat: r.stop_lat,
      lon: r.stop_lon
    }))
  });
});

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});