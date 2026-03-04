/* eslint-disable */
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const FEED_URL = process.env.GTFS_RT_TRIPUPDATES_URL || "";
const API_KEY = process.env.GTFS_RT_API_KEY || "";
const API_KEY_HEADER = process.env.GTFS_RT_API_KEY_HEADER || "";

let cache = {
  fetchedAt: 0,
  // key: `${trip_id}::${stop_id}` -> { epoch: number, uncertainty?: number }
  byTripStop: new Map()
};

function buildHeaders() {
  const headers = {};
  if (API_KEY && API_KEY_HEADER) {
    headers[API_KEY_HEADER] = API_KEY;
  }
  return headers;
}

/**
 * Fetch + decode GTFS-RT TripUpdates, cached for `ttlMs`.
 * Returns Map keyed by "trip_id::stop_id" -> { epoch, uncertainty }
 */
async function getTripUpdatesMap(ttlMs = 15000) {
  if (!FEED_URL) return cache.byTripStop;

  const now = Date.now();
  if (now - cache.fetchedAt < ttlMs && cache.byTripStop.size > 0) {
    return cache.byTripStop;
  }

  try {
    const res = await fetch(FEED_URL, { headers: buildHeaders() });
    if (!res.ok) {
      // keep old cache if present
      return cache.byTripStop;
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);

    const map = new Map();

    for (const ent of feed.entity || []) {
      if (!ent.tripUpdate) continue;

      const tripId = ent.tripUpdate.trip?.tripId;
      if (!tripId) continue;

      for (const stu of ent.tripUpdate.stopTimeUpdate || []) {
        const stopId = stu.stopId;
        if (!stopId) continue;

        // Prefer departure.time, fallback to arrival.time
        const dep = stu.departure?.time;
        const arr = stu.arrival?.time;
        const t = dep ?? arr;
        if (!t) continue;

        const uncertainty = stu.departure?.uncertainty ?? stu.arrival?.uncertainty;
        map.set(`${tripId}::${stopId}`, { epoch: Number(t), uncertainty });
      }
    }

    cache = { fetchedAt: now, byTripStop: map };
    return map;
  } catch {
    // keep old cache if fetch/decode fails
    return cache.byTripStop;
  }
}

module.exports = { getTripUpdatesMap };