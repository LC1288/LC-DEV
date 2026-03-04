/* eslint-disable */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { parse } = require("csv-parse/sync");
require("dotenv").config();

const GTFS_DIR = path.resolve(process.env.GTFS_DIR || "./data/gtfs");
const DB_PATH = path.resolve(process.env.DB_PATH || "./db/gtfs.sqlite");

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return parse(text, { columns: true, skip_empty_lines: true, bom: true });
}

function mustExist(p) {
  if (!fs.existsSync(p)) throw new Error(`Missing file: ${p}`);
}

function loadSchema(db) {
  const schema = fs.readFileSync(path.join(__dirname, "gtfs_schema.sql"), "utf8");
  db.exec(schema);
}

function insertMany(db, sql, rows) {
  const stmt = db.prepare(sql);
  const tx = db.transaction((rows) => {
    for (const r of rows) stmt.run(r);
  });
  tx(rows);
}

(function main() {
  if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const required = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"];
  for (const f of required) mustExist(path.join(GTFS_DIR, f));

  const db = new Database(DB_PATH);
  console.log("DB:", DB_PATH);
  console.log("GTFS:", GTFS_DIR);

  loadSchema(db);

  const stops = readCsv(path.join(GTFS_DIR, "stops.txt")).map((r) => ({
    stop_id: r.stop_id,
    stop_code: r.stop_code || null,
    stop_name: r.stop_name || null,
    stop_lat: r.stop_lat ? Number(r.stop_lat) : null,
    stop_lon: r.stop_lon ? Number(r.stop_lon) : null,
    parent_station: r.parent_station || null
  }));

  const routes = readCsv(path.join(GTFS_DIR, "routes.txt")).map((r) => ({
    route_id: r.route_id,
    agency_id: r.agency_id || null,
    route_short_name: r.route_short_name || null,
    route_long_name: r.route_long_name || null,
    route_type: r.route_type ? Number(r.route_type) : null
  }));

  const trips = readCsv(path.join(GTFS_DIR, "trips.txt")).map((r) => ({
    trip_id: r.trip_id,
    route_id: r.route_id,
    service_id: r.service_id,
    trip_headsign: r.trip_headsign || null,
    direction_id: r.direction_id !== undefined && r.direction_id !== "" ? Number(r.direction_id) : null
  }));

  // stop_times can be huge; stream-like chunking
  const stopTimesRows = readCsv(path.join(GTFS_DIR, "stop_times.txt")).map((r) => ({
    trip_id: r.trip_id,
    arrival_time: r.arrival_time || null,
    departure_time: r.departure_time || null,
    stop_id: r.stop_id,
    stop_sequence: r.stop_sequence ? Number(r.stop_sequence) : null
  }));

  const calPath = path.join(GTFS_DIR, "calendar.txt");
  const calDatesPath = path.join(GTFS_DIR, "calendar_dates.txt");

  const calendar = fs.existsSync(calPath)
    ? readCsv(calPath).map((r) => ({
        service_id: r.service_id,
        monday: Number(r.monday || 0),
        tuesday: Number(r.tuesday || 0),
        wednesday: Number(r.wednesday || 0),
        thursday: Number(r.thursday || 0),
        friday: Number(r.friday || 0),
        saturday: Number(r.saturday || 0),
        sunday: Number(r.sunday || 0),
        start_date: r.start_date || null,
        end_date: r.end_date || null
      }))
    : [];

  const calendar_dates = fs.existsSync(calDatesPath)
    ? readCsv(calDatesPath).map((r) => ({
        service_id: r.service_id,
        date: r.date,
        exception_type: Number(r.exception_type)
      }))
    : [];

  console.log("Importing stops:", stops.length);
  insertMany(
    db,
    `INSERT INTO stops(stop_id, stop_code, stop_name, stop_lat, stop_lon, parent_station)
     VALUES (@stop_id,@stop_code,@stop_name,@stop_lat,@stop_lon,@parent_station)`,
    stops
  );

  console.log("Importing routes:", routes.length);
  insertMany(
    db,
    `INSERT INTO routes(route_id, agency_id, route_short_name, route_long_name, route_type)
     VALUES (@route_id,@agency_id,@route_short_name,@route_long_name,@route_type)`,
    routes
  );

  console.log("Importing trips:", trips.length);
  insertMany(
    db,
    `INSERT INTO trips(trip_id, route_id, service_id, trip_headsign, direction_id)
     VALUES (@trip_id,@route_id,@service_id,@trip_headsign,@direction_id)`,
    trips
  );

  console.log("Importing stop_times:", stopTimesRows.length);
  // chunk insert to avoid huge transactions
  const chunkSize = 50000;
  const stmt = db.prepare(
    `INSERT INTO stop_times(trip_id, arrival_time, departure_time, stop_id, stop_sequence)
     VALUES (@trip_id,@arrival_time,@departure_time,@stop_id,@stop_sequence)`
  );
  for (let i = 0; i < stopTimesRows.length; i += chunkSize) {
    const chunk = stopTimesRows.slice(i, i + chunkSize);
    db.transaction((rows) => rows.forEach((r) => stmt.run(r)))(chunk);
    console.log(`  stop_times ${Math.min(i + chunkSize, stopTimesRows.length)} / ${stopTimesRows.length}`);
  }

  if (calendar.length) {
    console.log("Importing calendar:", calendar.length);
    insertMany(
      db,
      `INSERT INTO calendar(service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date)
       VALUES (@service_id,@monday,@tuesday,@wednesday,@thursday,@friday,@saturday,@sunday,@start_date,@end_date)`,
      calendar
    );
  } else {
    console.log("No calendar.txt found (that's OK if your feed uses calendar_dates only).");
  }

  if (calendar_dates.length) {
    console.log("Importing calendar_dates:", calendar_dates.length);
    insertMany(
      db,
      `INSERT INTO calendar_dates(service_id,date,exception_type)
       VALUES (@service_id,@date,@exception_type)`,
      calendar_dates
    );
  }

  console.log("Done.");
  db.close();
})();