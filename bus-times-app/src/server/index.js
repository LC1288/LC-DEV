/* eslint-disable */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { XMLParser } = require("fast-xml-parser");

// ---------------- ENV (load .env from same folder as this file) ----------------
require("dotenv").config({ path: path.join(__dirname, ".env") });

const PORT = Number(process.env.PORT || 3001);

const BODS_API_KEY = process.env.BODS_API_KEY || "";
const BODS_VM_FEED_ID = process.env.BODS_VM_FEED_ID || "";

// Prefer full URL if provided, otherwise build from key + feed id
const BODS_SIRI_VM_URL =
  process.env.BODS_SIRI_VM_URL ||
  (BODS_API_KEY && BODS_VM_FEED_ID
    ? `https://data.bus-data.dft.gov.uk/api/v1/datafeed/${encodeURIComponent(
        BODS_VM_FEED_ID
      )}/?api_key=${encodeURIComponent(BODS_API_KEY)}`
    : "");

// ---------------- APP ----------------
const app = express();
app.use(cors());

// ---------------- PATHS ----------------
const DATA_DIR = path.join(__dirname, "data");
const NAPTAN_FILE = path.join(DATA_DIR, "naptan_peterborough.csv");

// ---------------- HEALTH ----------------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    env: {
      port: PORT,
      hasApiKey: !!BODS_API_KEY,
      feedId: BODS_VM_FEED_ID || null,
      hasVmUrl: !!BODS_SIRI_VM_URL
    }
  });
});

// ---------------- READ FILE SAFELY (UTF8/UTF16) ----------------
function readTextSmart(filePath) {
  const buf = fs.readFileSync(filePath);

  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le");
  }
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  return buf.toString("utf8");
}

// ---------------- STOP CACHE ----------------
let STOP_CACHE = null;
let STOP_CACHE_MTIME = 0;

function loadStops() {
  if (!fs.existsSync(NAPTAN_FILE)) {
    throw new Error(`NaPTAN CSV not found: ${NAPTAN_FILE}`);
  }

  const stat = fs.statSync(NAPTAN_FILE);
  const mtime = stat.mtimeMs;
  if (STOP_CACHE && STOP_CACHE_MTIME === mtime) return STOP_CACHE;

  const csv = readTextSmart(NAPTAN_FILE);
  const records = parse(csv, { columns: true, skip_empty_lines: true });

  const pick = (row, keys) => {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    return "";
  };

  const stops = records
    .map((row) => {
      const id = String(
        pick(row, ["ATCOCode", "AtcoCode", "StopPointRef", "StopPointRef (ATCO)"])
      ).trim();

      const name = String(
        pick(row, ["CommonName", "Common Name", "StopName", "Stop Name"])
      ).trim();

      const locality = String(pick(row, ["LocalityName", "Locality", "NptgLocalityName"])).trim();
      const indicator = String(pick(row, ["Indicator", "StopIndicator"])).trim();

      const lat = Number(pick(row, ["Latitude", "Lat"]));
      const lon = Number(pick(row, ["Longitude", "Lon", "Lng"]));

      if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      return { id, name, locality, indicator, lat, lon };
    })
    .filter(Boolean);

  STOP_CACHE = stops;
  STOP_CACHE_MTIME = mtime;
  return stops;
}

// ---------------- STOPS (search) ----------------
// GET /api/stops?q=queensgate&limit=50
app.get("/api/stops", (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    const stops = loadStops();

    const items = !q
      ? []
      : stops
          .filter((s) => {
            return (
              s.name.toLowerCase().includes(q) ||
              s.id.toLowerCase().includes(q) ||
              (s.locality && s.locality.toLowerCase().includes(q))
            );
          })
          .slice(0, limit);

    res.json({ ok: true, q, total: items.length, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ---------------- LIVE BUSES (SIRI-VM XML -> JSON) ----------------
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_"
});

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
      recordedAtTime
    });
  }

  return buses;
}

// GET /api/live-buses
app.get("/api/live-buses", async (req, res) => {
  try {
    if (!BODS_SIRI_VM_URL) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing BODS config. Set BODS_SIRI_VM_URL OR set both BODS_API_KEY and BODS_VM_FEED_ID in src/server/.env"
      });
    }

    const r = await fetch(BODS_SIRI_VM_URL, {
      headers: { Accept: "application/xml,text/xml,*/*" }
    });

    const text = await r.text();

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: `BODS request failed: ${r.status} ${r.statusText}`,
        bodyPreview: text.slice(0, 250)
      });
    }

    const items = normaliseBusesFromSiriXml(text);
    res.json({ ok: true, count: items.length, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
  console.log(`Stops:  http://localhost:${PORT}/api/stops?q=queensgate`);
  console.log(`Live:   http://localhost:${PORT}/api/live-buses`);
});