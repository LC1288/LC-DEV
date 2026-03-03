/* eslint-disable */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { XMLParser } = require("fast-xml-parser");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(cors());

const PORT = Number(process.env.PORT || 3001);

// -------- Paths --------
const DATA_DIR = path.join(__dirname, "data");
const NAPTAN_FILE = path.join(DATA_DIR, "naptan_peterborough.csv");

const GTFS_DIR = path.join(DATA_DIR, "gtfs");
const GTFS_STOPS = path.join(GTFS_DIR, "stops.txt");
const GTFS_STOP_TIMES = path.join(GTFS_DIR, "stop_times.txt");
const GTFS_TRIPS = path.join(GTFS_DIR, "trips.txt");
const GTFS_ROUTES = path.join(GTFS_DIR, "routes.txt");
const GTFS_CALENDAR = path.join(GTFS_DIR, "calendar.txt");
const GTFS_CAL_DATES = path.join(GTFS_DIR, "calendar_dates.txt");

// -------- BODS (live buses) --------
const BODS_API_KEY = process.env.BODS_API_KEY || "";
const BODS_VM_FEED_ID = process.env.BODS_VM_FEED_ID || "";
const BODS_SIRI_VM_URL =
  process.env.BODS_SIRI_VM_URL ||
  (BODS_API_KEY && BODS_VM_FEED_ID
    ? `https://data.bus-data.dft.gov.uk/api/v1/datafeed/${encodeURIComponent(
        BODS_VM_FEED_ID
      )}/?api_key=${encodeURIComponent(BODS_API_KEY)}`
    : "");

// -------- Helpers --------
function readTextSmart(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.slice(3).toString("utf8");
  return buf.toString("utf8");
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function norm(x) {
  return String(x || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pick(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function timeToSeconds(hms) {
  const [h, m, s] = String(hms || "0:0:0").split(":").map((x) => Number(x));
  if (![h, m, s].every((n) => Number.isFinite(n))) return null;
  return h * 3600 + m * 60 + s;
}

function getUkNowParts() {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;

  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  const weekday = get("weekday"); // Mon/Tue...

  const yyyymmdd = `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
  const secondsSinceMidnight = hour * 3600 + minute * 60 + second;

  return { yyyymmdd, secondsSinceMidnight, weekday };
}

// -------- Stop cache (NaPTAN) --------
let STOP_CACHE = null;
let STOP_CACHE_MTIME = 0;

function loadStops() {
  if (!fs.existsSync(NAPTAN_FILE)) throw new Error(`NaPTAN CSV not found: ${NAPTAN_FILE}`);

  const stat = fs.statSync(NAPTAN_FILE);
  const mtime = stat.mtimeMs;
  if (STOP_CACHE && STOP_CACHE_MTIME === mtime) return STOP_CACHE;

  const csv = readTextSmart(NAPTAN_FILE);
  const records = parse(csv, { columns: true, skip_empty_lines: true });

  const stops = records
    .map((row) => {
      const id = String(pick(row, ["ATCOCode", "AtcoCode", "StopPointRef", "StopPointRef (ATCO)"])).trim();
      const name = String(pick(row, ["CommonName", "StopName", "Common Name", "Stop Name"])).trim();
      const locality = String(pick(row, ["LocalityName", "Locality", "NptgLocalityName"])).trim();
      const indicator = String(pick(row, ["Indicator", "StopIndicator"])).trim();

      const lat = Number(pick(row, ["Latitude", "Lat"]));
      const lon = Number(pick(row, ["Longitude", "Lon", "Lng"]));

      const street = String(pick(row, ["Street", "StreetName", "Street Name"])).trim();
      const landmark = String(pick(row, ["Landmark", "LandmarkName", "Landmark Name"])).trim();
      const nptg = String(pick(row, ["NptgLocalityName", "Nptg Locality", "NPTG Locality Name"])).trim();

      if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      return { id, name, locality, indicator, lat, lon, street, landmark, nptg };
    })
    .filter(Boolean);

  STOP_CACHE = stops;
  STOP_CACHE_MTIME = mtime;
  return stops;
}

function findNaptanStopById(id) {
  const stops = loadStops();
  const m = stops.find((s) => s.id === id);
  return m || null;
}

// -------- GTFS cache (departures) --------
let GTFS_CACHE = null;
let GTFS_MTIME = 0;

function fileMtimeSafe(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function parseGtfsCsv(filePath) {
  const txt = readTextSmart(filePath);
  return parse(txt, { columns: true, skip_empty_lines: true });
}

function loadGtfs() {
  const needed = [GTFS_STOPS, GTFS_STOP_TIMES, GTFS_TRIPS, GTFS_ROUTES];
  for (const p of needed) {
    if (!fs.existsSync(p)) return null;
  }

  const newest =
    Math.max(
      fileMtimeSafe(GTFS_STOPS),
      fileMtimeSafe(GTFS_STOP_TIMES),
      fileMtimeSafe(GTFS_TRIPS),
      fileMtimeSafe(GTFS_ROUTES),
      fileMtimeSafe(GTFS_CALENDAR),
      fileMtimeSafe(GTFS_CAL_DATES)
    ) || 0;

  if (GTFS_CACHE && GTFS_MTIME === newest) return GTFS_CACHE;

  const stops = parseGtfsCsv(GTFS_STOPS);
  const stopTimes = parseGtfsCsv(GTFS_STOP_TIMES);
  const trips = parseGtfsCsv(GTFS_TRIPS);
  const routes = parseGtfsCsv(GTFS_ROUTES);

  const calendar = fs.existsSync(GTFS_CALENDAR) ? parseGtfsCsv(GTFS_CALENDAR) : [];
  const calendarDates = fs.existsSync(GTFS_CAL_DATES) ? parseGtfsCsv(GTFS_CAL_DATES) : [];

  const tripById = new Map(trips.map((t) => [t.trip_id, t]));
  const routeById = new Map(routes.map((r) => [r.route_id, r]));

  const stopTimesByStopId = new Map();
  for (const st of stopTimes) {
    const stopId = st.stop_id;
    if (!stopId) continue;
    if (!stopTimesByStopId.has(stopId)) stopTimesByStopId.set(stopId, []);
    stopTimesByStopId.get(stopId).push(st);
  }

  const calendarByServiceId = new Map(calendar.map((c) => [c.service_id, c]));
  const calDatesByServiceId = new Map();
  for (const cd of calendarDates) {
    if (!cd.service_id) continue;
    if (!calDatesByServiceId.has(cd.service_id)) calDatesByServiceId.set(cd.service_id, []);
    calDatesByServiceId.get(cd.service_id).push(cd);
  }

  // Precompute GTFS stop positions
  const gtfsStops = stops
    .map((s) => ({
      stop_id: s.stop_id,
      stop_name: s.stop_name,
      lat: Number(s.stop_lat),
      lon: Number(s.stop_lon),
    }))
    .filter((s) => s.stop_id && Number.isFinite(s.lat) && Number.isFinite(s.lon));

  GTFS_CACHE = {
    gtfsStops,
    stopTimesByStopId,
    tripById,
    routeById,
    calendarByServiceId,
    calDatesByServiceId,
  };
  GTFS_MTIME = newest;
  return GTFS_CACHE;
}

function serviceRunsToday(serviceId, yyyymmdd, weekdayShort, calendarByServiceId, calDatesByServiceId) {
  const cds = calDatesByServiceId.get(serviceId) || [];
  for (const cd of cds) {
    if (cd.date === yyyymmdd) {
      return String(cd.exception_type) === "1";
    }
  }

  const cal = calendarByServiceId.get(serviceId);
  if (!cal) return true;

  if (cal.start_date && yyyymmdd < cal.start_date) return false;
  if (cal.end_date && yyyymmdd > cal.end_date) return false;

  const map = { Mon: "monday", Tue: "tuesday", Wed: "wednesday", Thu: "thursday", Fri: "friday", Sat: "saturday", Sun: "sunday" };
  const key = map[weekdayShort];
  if (!key) return true;

  return String(cal[key]) === "1";
}

function findNearestGtfsStop(gtfsStops, lat, lon, maxKm = 0.8) {
  // Find nearest GTFS stop within maxKm (800m default)
  let best = null;
  let bestD = Infinity;

  for (const s of gtfsStops) {
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }

  if (!best || bestD > maxKm) return { best: null, km: bestD };
  return { best, km: bestD };
}

// -------- Routes --------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    env: {
      port: PORT,
      hasBods: !!BODS_SIRI_VM_URL,
      hasGtfs: fs.existsSync(GTFS_DIR),
    },
  });
});

// STOP SEARCH
app.get("/api/stops", (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    const q = norm(qRaw);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    const stops = loadStops();

    // Try local filter, but never break search if it’s empty
    const PB = { lat: 52.5726, lon: -0.2427 };
    const RADIUS_KM = 25;

    const localStops = stops.filter((s) => haversineKm(PB.lat, PB.lon, s.lat, s.lon) <= RADIUS_KM);
    const base = localStops.length >= 50 ? localStops : stops;

    const items = !q
      ? []
      : base
          .filter((s) => {
            const hay = [s.name, s.id, s.locality, s.indicator, s.street, s.landmark, s.nptg].map(norm).join(" | ");
            return hay.includes(q);
          })
          .slice(0, limit);

    res.json({
      ok: true,
      q: qRaw,
      total: items.length,
      items,
      meta: {
        usedLocalFilter: localStops.length >= 50,
        localStopsCount: localStops.length,
        totalStops: stops.length,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// DEPARTURES (auto map NaPTAN stop -> nearest GTFS stop)
app.get("/api/departures", (req, res) => {
  try {
    const naptanStopId = String(req.query.stopId || "").trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));

    if (!naptanStopId) return res.status(400).json({ ok: false, error: "Missing stopId" });

    const nStop = findNaptanStopById(naptanStopId);
    if (!nStop) return res.status(404).json({ ok: false, error: `Unknown NaPTAN stopId: ${naptanStopId}` });

    const gtfs = loadGtfs();
    if (!gtfs) {
      return res.status(400).json({
        ok: false,
        error: "GTFS not found in src/server/data/gtfs (need stops.txt, stop_times.txt, trips.txt, routes.txt).",
      });
    }

    // 1) try direct match first
    let gtfsStopId = null;
    if (gtfs.stopTimesByStopId.has(naptanStopId)) {
      gtfsStopId = naptanStopId;
    }

    // 2) otherwise map by nearest GTFS stop
    let mapped = null;
    let mappedKm = null;
    if (!gtfsStopId) {
      const found = findNearestGtfsStop(gtfs.gtfsStops, nStop.lat, nStop.lon, 0.8);
      if (found.best) {
        mapped = found.best;
        mappedKm = found.km;
        gtfsStopId = found.best.stop_id;
      }
    }

    if (!gtfsStopId) {
      return res.json({
        ok: true,
        stopId: naptanStopId,
        mappedStopId: null,
        count: 0,
        items: [],
        debug: {
          reason: "No GTFS stop match found within 800m of this NaPTAN stop.",
          naptan: { id: nStop.id, name: nStop.name, lat: nStop.lat, lon: nStop.lon },
        },
      });
    }

    const { yyyymmdd, secondsSinceMidnight, weekday } = getUkNowParts();
    const stopTimes = gtfs.stopTimesByStopId.get(gtfsStopId) || [];

    const upcoming = [];
    for (const st of stopTimes) {
      const depSec = timeToSeconds(st.departure_time);
      if (depSec == null) continue;

      if (depSec < secondsSinceMidnight) continue;
      if (depSec > secondsSinceMidnight + 6 * 3600) continue;

      const trip = gtfs.tripById.get(st.trip_id);
      if (!trip) continue;

      const serviceId = trip.service_id;
      if (serviceId && !serviceRunsToday(serviceId, yyyymmdd, weekday, gtfs.calendarByServiceId, gtfs.calDatesByServiceId)) {
        continue;
      }

      const route = gtfs.routeById.get(trip.route_id);

      upcoming.push({
        departure_time: st.departure_time,
        arrival_time: st.arrival_time,
        trip_id: st.trip_id,
        route_id: trip.route_id,
        route_short_name: route?.route_short_name || route?.route_id || "",
        route_long_name: route?.route_long_name || "",
        headsign: trip.trip_headsign || "",
      });
    }

    upcoming.sort((a, b) => timeToSeconds(a.departure_time) - timeToSeconds(b.departure_time));

    res.json({
      ok: true,
      stopId: naptanStopId,
      mappedStopId: gtfsStopId,
      mappedKm,
      mappedStopName: mapped?.stop_name || null,
      now: { yyyymmdd, secondsSinceMidnight, weekday },
      count: Math.min(limit, upcoming.length),
      items: upcoming.slice(0, limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// LIVE BUSES
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

function extractVehicleActivities(parsed) {
  const siri = parsed?.Siri || parsed?.siri || parsed?.SIRI || parsed;
  const serviceDelivery = siri?.ServiceDelivery || siri?.serviceDelivery || siri?.Service_Delivery;
  const vm = serviceDelivery?.VehicleMonitoringDelivery || serviceDelivery?.vehicleMonitoringDelivery;
  const vmDelivery = Array.isArray(vm) ? vm[0] : vm;
  const activities = vmDelivery?.VehicleActivity || vmDelivery?.vehicleActivity;
  return asArray(activities);
}

function safeGetJourney(act) {
  return act?.MonitoredVehicleJourney || act?.monitoredVehicleJourney || null;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normaliseBusesFromSiriXml(xmlText) {
  const parsed = xmlParser.parse(xmlText);
  const activities = extractVehicleActivities(parsed);

  const buses = [];
  for (const act of activities) {
    const j = safeGetJourney(act);
    if (!j) continue;

    const loc = j?.VehicleLocation || j?.vehicleLocation || {};
    const lat = toNumber(loc?.Latitude ?? loc?.latitude);
    const lon = toNumber(loc?.Longitude ?? loc?.longitude);
    if (lat == null || lon == null) continue;

    const lineRef = String(j?.LineRef ?? j?.lineRef ?? "").trim();
    const publishedLineName = String(j?.PublishedLineName ?? j?.publishedLineName ?? "").trim();
    const destinationName = String(j?.DestinationName ?? j?.destinationName ?? "").trim();
    const vehicleRef = String(j?.VehicleRef ?? j?.vehicleRef ?? "").trim();
    const recordedAtTime = String(act?.RecordedAtTime ?? act?.recordedAtTime ?? "").trim();

    buses.push({
      id: vehicleRef || `${lineRef}-${lat}-${lon}`,
      line: publishedLineName || lineRef || "Unknown",
      destination: destinationName || "",
      lat,
      lon,
      recordedAtTime,
    });
  }
  return buses;
}

app.get("/api/live-buses", async (req, res) => {
  try {
    if (!BODS_SIRI_VM_URL) {
      return res.status(400).json({
        ok: false,
        error: "Missing BODS config. Set BODS_API_KEY and BODS_VM_FEED_ID in src/server/.env",
      });
    }

    const r = await fetch(BODS_SIRI_VM_URL, {
      headers: { Accept: "application/xml,text/xml,*/*" },
    });

    const text = await r.text();

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: `BODS request failed: ${r.status} ${r.statusText}`,
        bodyPreview: text.slice(0, 250),
      });
    }

    const items = normaliseBusesFromSiriXml(text);
    res.json({ ok: true, count: items.length, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  console.log(`Stops:      http://localhost:${PORT}/api/stops?q=queensgate`);
  console.log(`Departures: http://localhost:${PORT}/api/departures?stopId=0590BCE01L`);
  console.log(`Live:       http://localhost:${PORT}/api/live-buses`);
});