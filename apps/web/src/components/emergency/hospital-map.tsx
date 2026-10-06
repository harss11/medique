"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EmergencyHospital } from "@/lib/types";

/** The small part of the Google Maps JavaScript API used here. */
interface LatLng {
  lat: number;
  lng: number;
}
interface GoogleMapsApi {
  Map: new (el: HTMLElement, opts: object) => { fitBounds(b: unknown, padding?: number): void };
  Marker: new (opts: object) => { addListener(event: string, fn: () => void): void };
  LatLngBounds: new () => { extend(p: LatLng): void };
  InfoWindow: new (opts: object) => {
    open(opts: object): void;
    close(): void;
    setContent(content: Node | string): void;
  };
  SymbolPath: { CIRCLE: unknown };
}
declare global {
  interface Window {
    google?: { maps?: GoogleMapsApi };
  }
}

export const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";

let loading: Promise<GoogleMapsApi> | null = null;

/** Loads the Maps script once. Rejects (so the page falls back to the list) if it cannot load. */
function loadGoogleMaps(): Promise<GoogleMapsApi> {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  loading ??= new Promise<GoogleMapsApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(MAPS_KEY);
    script.async = true;
    script.onload = () =>
      window.google?.maps?.Map ? resolve(window.google.maps) : reject(new Error("Maps failed"));
    script.onerror = () => reject(new Error("Maps failed"));
    document.head.appendChild(script);
  }).catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/**
 * Map of the listed hospitals (and the visitor, when known). Renders nothing when no Google
 * Maps key is configured or the script cannot load: the list below it stays fully usable.
 */
export function HospitalMap({
  hospitals,
  here,
}: {
  hospitals: EmergencyHospital[];
  here: LatLng | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const points = useMemo(
    () => hospitals.filter((h) => h.latitude != null && h.longitude != null),
    [hospitals],
  );

  useEffect(() => {
    if (!MAPS_KEY || points.length === 0) return;
    let cancelled = false;
    loadGoogleMaps()
      .then((maps) => {
        const el = box.current;
        if (cancelled || !el) return;
        const map = new maps.Map(el, {
          center: here ?? { lat: points[0]!.latitude!, lng: points[0]!.longitude! },
          zoom: 12,
          mapTypeControl: false,
          streetViewControl: false,
        });
        const bounds = new maps.LatLngBounds();
        const info = new maps.InfoWindow({});
        if (here) {
          bounds.extend(here);
          new maps.Marker({
            map,
            position: here,
            title: "You are here",
            icon: {
              path: maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: "#2563eb",
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 2,
            },
          });
        }
        for (const h of points) {
          const position = { lat: h.latitude!, lng: h.longitude! };
          bounds.extend(position);
          const marker = new maps.Marker({ map, position, title: h.name });
          marker.addListener("click", () => {
            // textContent, never innerHTML: hospital names are data.
            const node = document.createElement("div");
            node.textContent = h.name;
            node.style.fontWeight = "600";
            info.close();
            info.setContent(node);
            info.open({ map, anchor: marker });
          });
        }
        if (points.length > 1 || here) map.fitBounds(bounds, 48);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [points, here]);

  if (!MAPS_KEY || failed || points.length === 0) return null;
  return (
    <div
      ref={box}
      role="img"
      aria-label="Map of nearby hospitals"
      className="h-72 w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-100"
    />
  );
}
