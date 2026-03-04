PRAGMA journal_mode = WAL;

DROP TABLE IF EXISTS stops;
DROP TABLE IF EXISTS routes;
DROP TABLE IF EXISTS trips;
DROP TABLE IF EXISTS stop_times;
DROP TABLE IF EXISTS calendar;
DROP TABLE IF EXISTS calendar_dates;

CREATE TABLE stops (
  stop_id TEXT PRIMARY KEY,
  stop_code TEXT,
  stop_name TEXT,
  stop_lat REAL,
  stop_lon REAL,
  parent_station TEXT
);
CREATE INDEX idx_stops_latlon ON stops(stop_lat, stop_lon);

CREATE TABLE routes (
  route_id TEXT PRIMARY KEY,
  agency_id TEXT,
  route_short_name TEXT,
  route_long_name TEXT,
  route_type INTEGER
);

CREATE TABLE trips (
  trip_id TEXT PRIMARY KEY,
  route_id TEXT,
  service_id TEXT,
  trip_headsign TEXT,
  direction_id INTEGER
);
CREATE INDEX idx_trips_route ON trips(route_id);
CREATE INDEX idx_trips_service ON trips(service_id);

CREATE TABLE stop_times (
  trip_id TEXT,
  arrival_time TEXT,
  departure_time TEXT,
  stop_id TEXT,
  stop_sequence INTEGER
);
CREATE INDEX idx_stop_times_stop ON stop_times(stop_id);
CREATE INDEX idx_stop_times_trip ON stop_times(trip_id);

CREATE TABLE calendar (
  service_id TEXT PRIMARY KEY,
  monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER, friday INTEGER, saturday INTEGER, sunday INTEGER,
  start_date TEXT,
  end_date TEXT
);

CREATE TABLE calendar_dates (
  service_id TEXT,
  date TEXT,
  exception_type INTEGER
);
CREATE INDEX idx_calendar_dates_date ON calendar_dates(date);