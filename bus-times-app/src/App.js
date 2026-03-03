import React, { useEffect, useMemo, useState } from "react";
import { SafeAreaView, View, Text, TextInput, FlatList, Pressable, ActivityIndicator, Platform } from "react-native";

const API_BASE =
  Platform.OS === "android"
    ? "http://10.0.2.2:3001" // Android emulator talks to your PC localhost via 10.0.2.2
    : "http://localhost:3001"; // iOS simulator + web

export default function App() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");

  // Debounce typing so it doesn’t spam requests
  const debouncedQuery = useDebounce(query, 250);

  useEffect(() => {
    const q = debouncedQuery.trim();

    // If empty, show nothing (or you could show top stops)
    if (!q) {
      setItems([]);
      setError("");
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError("");

        const res = await fetch(`${API_BASE}/api/stops?q=${encodeURIComponent(q)}&limit=25`);
        const data = await res.json();

        if (!res.ok || !data.ok) {
          throw new Error(data?.error || `Request failed (${res.status})`);
        }

        if (!cancelled) setItems(data.items || []);
      } catch (e) {
        if (!cancelled) setError(String(e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const placeholder = useMemo(
    () => "Search stop name, ATCO code, locality…",
    []
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0b0f14" }}>
      <View style={{ padding: 16 }}>
        <Text style={{ color: "white", fontSize: 22, fontWeight: "700" }}>
          Bus Stops
        </Text>
        <Text style={{ color: "#9aa4b2", marginTop: 6 }}>
          Type to search (e.g. “Station”, “Queensgate”, ATCO code…)
        </Text>

        <View
          style={{
            marginTop: 14,
            borderRadius: 12,
            backgroundColor: "#121926",
            borderWidth: 1,
            borderColor: "#1f2a3a",
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={placeholder}
            placeholderTextColor="#6b7686"
            style={{ color: "white", fontSize: 16 }}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>

        {!!error && (
          <Text style={{ color: "#ff6b6b", marginTop: 10 }}>
            {error}
          </Text>
        )}

        {loading && (
          <View style={{ marginTop: 12 }}>
            <ActivityIndicator />
          </View>
        )}

        {!!selected && (
          <View
            style={{
              marginTop: 14,
              padding: 12,
              borderRadius: 12,
              backgroundColor: "#0f1724",
              borderWidth: 1,
              borderColor: "#1f2a3a",
            }}
          >
            <Text style={{ color: "white", fontSize: 16, fontWeight: "700" }}>
              Selected stop
            </Text>
            <Text style={{ color: "#cbd5e1", marginTop: 6 }}>
              {selected.name}
            </Text>
            <Text style={{ color: "#9aa4b2", marginTop: 4 }}>
              {selected.id} • {selected.locality || "Unknown locality"}
            </Text>
          </View>
        )}
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        ListEmptyComponent={
          query.trim() ? (
            <Text style={{ color: "#9aa4b2", paddingHorizontal: 16 }}>
              No stops found.
            </Text>
          ) : (
            <Text style={{ color: "#9aa4b2", paddingHorizontal: 16 }}>
              Start typing to search for stops.
            </Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => setSelected(item)}
            style={{
              padding: 12,
              borderRadius: 14,
              backgroundColor: "#121926",
              borderWidth: 1,
              borderColor: "#1f2a3a",
              marginBottom: 10,
            }}
          >
            <Text style={{ color: "white", fontSize: 16, fontWeight: "700" }}>
              {item.name}
            </Text>

            <Text style={{ color: "#9aa4b2", marginTop: 4 }}>
              {item.id}
              {item.indicator ? ` • ${item.indicator}` : ""}
              {item.locality ? ` • ${item.locality}` : ""}
            </Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

// Simple debounce hook
function useDebounce(value, delayMs) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}