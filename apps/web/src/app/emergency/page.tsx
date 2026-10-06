"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { HospitalMap } from "@/components/emergency/hospital-map";
import { SitePage } from "@/components/site-header";
import { Alert, Badge, Button, Card, EmptyState, Field, LoadingBlock } from "@/components/ui";
import { directionsUrl, formatDateTime } from "@/lib/format";
import type { EmergencyHospital } from "@/lib/types";
import { useApi } from "@/lib/use-api";

interface EmergencyResponse {
  located: boolean;
  items: EmergencyHospital[];
}

type Place = { lat: number; lng: number } | null;

export default function EmergencyPage() {
  const [here, setHere] = useState<Place>(null);
  const [city, setCity] = useState("");
  const [cityInput, setCityInput] = useState("");
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const path = useMemo(() => {
    if (!here && !city) return null;
    const q = new URLSearchParams({ limit: "15" });
    if (here) {
      q.set("lat", String(here.lat));
      q.set("lng", String(here.lng));
    }
    if (city) q.set("city", city);
    return "/public/emergency?" + q;
  }, [here, city]);
  const result = useApi<EmergencyResponse>(path);

  function locate() {
    setLocateError(null);
    if (!navigator.geolocation) {
      setLocateError("This browser cannot share your location. Enter your city below.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        // About 100 m is plenty for finding a hospital, and shares less than the exact spot.
        setHere({
          lat: Math.round(pos.coords.latitude * 1000) / 1000,
          lng: Math.round(pos.coords.longitude * 1000) / 1000,
        });
      },
      () => {
        setLocating(false);
        setLocateError(
          "We could not get your location. Allow it in the browser, or enter your city below.",
        );
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  }

  const items = result.data?.items ?? [];
  return (
    <SitePage>
      <Card className="space-y-4 border-red-200 bg-red-50">
        <h1 className="text-2xl font-bold text-red-900">Emergency help</h1>
        <p className="text-red-900">
          If someone is in danger, call the national emergency number first.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <a
            href="tel:112"
            className="inline-flex h-14 items-center justify-center rounded-xl bg-red-600 px-8 text-lg font-bold text-white hover:bg-red-700"
          >
            Call 112
          </a>
          <Button
            variant="secondary"
            className="h-14 border-red-300 px-8 text-base text-red-900"
            loading={locating}
            onClick={locate}
          >
            Find hospitals near me
          </Button>
        </div>
        {locateError && <Alert>{locateError}</Alert>}
        <p className="text-sm text-red-900">
          Need blood?{" "}
          <Link href="/blood" className="font-semibold underline">
            Find a blood bank or ask for blood
          </Link>
        </p>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setCity(cityInput.trim());
          }}
        >
          <Field
            className="flex-1"
            label="Or search by city"
            name="city"
            placeholder="e.g. New Delhi"
            value={cityInput}
            onChange={(e) => setCityInput(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={!cityInput.trim()}>
            Search
          </Button>
        </form>
      </Card>

      {result.error && <Alert>{result.error}</Alert>}
      {path && result.loading && !result.data && <LoadingBlock />}

      {result.data && items.length === 0 && (
        <EmptyState title="No hospitals found">Try another city, or call 112.</EmptyState>
      )}

      {items.length > 0 && (
        <>
          <HospitalMap hospitals={items} here={here} />
          <ul className="space-y-3">
            {items.map((h) => (
              <HospitalCard key={h.id} h={h} />
            ))}
          </ul>
        </>
      )}
    </SitePage>
  );
}

function HospitalCard({ h }: { h: EmergencyHospital }) {
  const place = [h.addressLine1, h.city].filter(Boolean).join(", ");
  const beds =
    h.availableBeds != null && h.totalBeds != null
      ? h.availableBeds + " of " + h.totalBeds + " beds free"
      : null;
  return (
    <li>
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-semibold text-slate-900">{h.name}</h2>
            {place && <p className="text-sm text-slate-600">{place}</p>}
          </div>
          {h.distanceKm != null && <Badge tone="blue">{h.distanceKm.toFixed(1)} km away</Badge>}
        </div>
        {beds && (
          <p className="text-sm text-slate-700">
            {beds}
            {h.bedsStale && (
              <span className="text-amber-700">
                {" "}
                · not updated recently
                {h.bedsUpdatedAt ? " (last " + formatDateTime(h.bedsUpdatedAt) + ")" : ""}, call to
                confirm
              </span>
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {h.callNumber && (
            <a
              href={"tel:" + h.callNumber}
              className="inline-flex h-11 items-center rounded-xl bg-red-600 px-5 text-sm font-semibold text-white hover:bg-red-700"
            >
              Call {h.hasEmergencyLine ? "emergency line" : "hospital"}
            </a>
          )}
          <a
            href={directionsUrl(h)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center rounded-xl border border-slate-300 bg-white px-5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          >
            Directions
          </a>
        </div>
      </Card>
    </li>
  );
}
