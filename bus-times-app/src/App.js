import React, { useEffect, useState } from "react";
import { SafeAreaView, Text, View, ActivityIndicator } from "react-native";
import MapView, { Marker } from "react-native-maps";

const API_BASE = "http://10.0.2.2:3001"; 
// Android emulator -> your PC localhost
// If using a real phone on same Wi-Fi, use: http://YOUR_PC_IP:3001

export default function App() {
  const [stops, setStops] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);

  async function fetchStops() {
    const r = await fetch(`${API_BASE}/api/stops?limit=500`);
    const data = await r.json();
    setStops(Array.isArray(data) ? data : data.stops || []);
  }

  async function fetchVehicles() {
    const r = await fetch(`${API_BASE}/api/vehicles`);
    const data = await r.json();
    setVehicles(Array.isArray(data) ? data : data.vehicles || []);
  }

  useEffect(() => {
    (async () => {
      try {
        await fetchStops();
        await fetchVehicles();
      } finally {
        setLoading(false);
      }
    })();

    const id = setInterval(fetchVehicles, 7000); // poll live buses
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return (
      <SafeAreaView style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
        <Text style={{ marginTop: 8 }}>Loading…</Text>
      </SafeAreaView>
    );
  }

  // Center Peterborough-ish by default (tweak later)
  const initialRegion = {
    latitude: 52.573,
    longitude: -0.247,
    latitudeDelta: 0.12,
    longitudeDelta: 0.12,
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <MapView style={{ flex: 1 }} initialRegion={initialRegion}>
        {stops.map((s) => (
          <Marker
            key={s.atcoCode || s.naptanCode || s.id || `${s.lat},${s.lon}`}
            coordinate={{ latitude: Number(s.lat), longitude: Number(s.lon) }}
            title={s.commonName || s.name || "Stop"}
            description={s.atcoCode || s.naptanCode || ""}
          />
        ))}

        {vehicles.map((v, idx) => (
          <Marker
            key={v.vehicleRef || v.id || idx}
            coordinate={{ latitude: Number(v.lat), longitude: Number(v.lon) }}
            title={v.lineRef ? `Line ${v.lineRef}` : "Bus"}
            description={v.destinationName || v.operatorRef || ""}
          />
        ))}
      </MapView>

      <View style={{ position: "absolute", top: 12, left: 12, right: 12, padding: 10, backgroundColor: "white", borderRadius: 12 }}>
        <Text>Stops: {stops.length} • Live buses: {vehicles.length}</Text>
      </View>
    </SafeAreaView>
  );
}