/* eslint-disable */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const app = express();
app.use(cors());

// IMPORTANT: this resolves to: bus-times-app/src/server/data
const DATA_DIR = path.join(__dirname, "data");
const NAPTAN_FILE = path.join(DATA_DIR, "naptan_peterborough.csv");

/** ---------------- HEALTH ---------------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** ---------------- DEBUG: CONFIRM FILE + HEADERS ---------------- */
app.get("/api/debug-naptan", (req, res) => {
  try {
    const exists = fs.existsSync(NAPTAN_FILE);
    let firstLine = null;

    if (exists) {
      const content = fs.readFileSync(NAPTAN_FILE, "utf8");
      firstLine = content.split(/\r?\n/)[0] || null;
    }

    res.json({
      naptanFile: NAPTAN_FILE,
      exists,
      firstLine,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "debug failed" });
  }
});

/** ---------------- NaPTAN STOP SEARCH ---------------- */
let stopsCache = null;

function loadStops() {
  if (stopsCache) return stopsCache;

  // If file missing, return empty but also log clearly
  if (!fs.existsSync(NAPTAN_FILE)) {
    console.error("❌ NaPTAN CSV not found at:", NAPTAN_FILE);
    stopsCache = [];
    return stopsCache;
  }

  const csv = fs.readFileSync(NAPTAN_FILE, "utf8");

  // parse with headers
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  // safe getter for different header names
  const get = (row, keys) =>
    keys.map((k) => row[k]).find((v) => v !== undefined && v !== null && String(v).trim() !== "") ??
    "";

  // Build stop objects
  const stops = rows.map((r) => {
    const atco = get(r, [
      "AtcoCode",
      "ATCOCode",
      "ATCO",
      "StopPointRef",
      "StopPoint",
      "stop_id",
    ]);

    const commonName =
      get(r, ["CommonName", "Name", "DescriptorCommonName", "StopName"]) || "Stop";

    const indicator = get(r, ["Indicator", "StopIndicator"]) || "";
    const localityName = get(r, ["LocalityName", "Locality", "Town"]) || "";

    const latRaw = get(r, ["Latitude", "Lat", "StopLatitude"]);
    const lonRaw = get(r, ["Longitude", "Lon", "StopLongitude"]);

    const lat = Number(latRaw);
    const lon = Number(lonRaw);

    return {
      atcoCode: String(atco).trim(),
      commonName: String(commonName).trim(),
      indicator: String(indicator).trim(),
      localityName: String(localityName).trim(),
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
    };
  });

  // Keep anything that has an ATCO code (don’t require lat/lon to exist)
  stopsCache = stops.filter((s) => s.atcoCode);

  console.log(
    `✅ Loaded NaPTAN stops: ${stopsCache.length} (from ${path.basename(NAPTAN_FILE)})`
  );

  return stopsCache;
}

// Search endpoint
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

/** ---------------- START SERVER ---------------- */
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ API running on http://localhost:${PORT}`);
  console.log(`🔎 Debug NaPTAN: http://localhost:${PORT}/api/debug-naptan`);
});