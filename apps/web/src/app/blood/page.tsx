"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  BloodDisclaimer,
  BloodGroupSelect,
  FreshnessNote,
  StockGrid,
} from "@/components/blood/blood-bits";
import { SitePage } from "@/components/site-header";
import { Alert, Badge, Button, Card, EmptyState, Field, LoadingBlock } from "@/components/ui";
import { directionsUrl } from "@/lib/format";
import type { BloodGroup, Paginated, PublicBloodBank } from "@/lib/types";
import { useApi } from "@/lib/use-api";

interface BanksResponse extends Paginated<PublicBloodBank> {
  located: boolean;
}

export default function BloodPage() {
  const [city, setCity] = useState("");
  const [group, setGroup] = useState<BloodGroup | "">("");
  const [inStock, setInStock] = useState(false);
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const path = useMemo(() => {
    const q = new URLSearchParams({ limit: "20" });
    if (city.trim()) q.set("city", city.trim());
    if (group) q.set("bloodGroup", group);
    if (group && inStock) q.set("inStock", "true");
    if (here) {
      q.set("lat", String(here.lat));
      q.set("lng", String(here.lng));
    }
    return "/public/blood-banks?" + q;
  }, [city, group, inStock, here]);
  const { data, error, loading } = useApi<BanksResponse>(path);

  function locate() {
    setLocateError(null);
    if (!navigator.geolocation) {
      setLocateError("This browser cannot share your location. Enter your city instead.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setHere({
          lat: Math.round(pos.coords.latitude * 1000) / 1000,
          lng: Math.round(pos.coords.longitude * 1000) / 1000,
        });
      },
      () => {
        setLocating(false);
        setLocateError("We could not get your location. Enter your city instead.");
      },
      { timeout: 12_000, maximumAge: 60_000 },
    );
  }

  return (
    <SitePage>
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">Blood</h1>
        <p className="mt-1 max-w-2xl text-slate-600">
          Find a verified blood bank, ask for blood in an emergency, or sign up to help someone
          nearby.
        </p>
      </div>

      <BloodDisclaimer />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link
          href="/blood/request"
          className="rounded-2xl bg-red-600 p-5 text-white shadow-sm hover:bg-red-700"
        >
          <div className="text-lg font-bold">I need blood now</div>
          <div className="mt-1 text-sm opacity-90">
            Alerts donors and blood banks near the hospital.
          </div>
        </Link>
        <Link
          href="/patient/donor"
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:border-brand-300"
        >
          <div className="font-semibold text-slate-900">Become a donor</div>
          <div className="mt-1 text-sm text-slate-600">
            Get asked only when it matters, and only when you are eligible.
          </div>
        </Link>
        <Link
          href="/blood/request/find"
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:border-brand-300"
        >
          <div className="font-semibold text-slate-900">Find my request</div>
          <div className="mt-1 text-sm text-slate-600">Get back into a request you made.</div>
        </Link>
        <Link
          href="/blood/register-bank"
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:border-brand-300"
        >
          <div className="font-semibold text-slate-900">Register a blood bank</div>
          <div className="mt-1 text-sm text-slate-600">
            Licensed blood banks only. We check the licence.
          </div>
        </Link>
      </div>

      <Card className="space-y-4">
        <h2 className="font-semibold text-slate-900">Find a blood bank</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="City"
            name="city"
            placeholder="e.g. New Delhi"
            value={city}
            onChange={(e) => setCity(e.target.value)}
          />
          <BloodGroupSelect label="Blood group" includeAny value={group} onChange={setGroup} />
          <div className="flex items-end gap-2">
            <Button variant="secondary" loading={locating} onClick={locate}>
              {here ? "Near me ✓" : "Near me"}
            </Button>
            {here && (
              <Button variant="ghost" onClick={() => setHere(null)}>
                Clear
              </Button>
            )}
          </div>
        </div>
        {group && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="size-4 accent-brand-700"
              checked={inStock}
              onChange={(e) => setInStock(e.target.checked)}
            />
            Only blood banks that report this group in stock
          </label>
        )}
        {locateError && <Alert>{locateError}</Alert>}
      </Card>

      {error && <Alert>{error}</Alert>}
      {!data && !error && <LoadingBlock />}
      {data && data.items.length === 0 && (
        <EmptyState title="No blood banks found">
          Try another city or blood group. In an emergency, ask for blood and we will alert donors
          and blood banks near the hospital.
        </EmptyState>
      )}
      <ul className={loading ? "space-y-3 opacity-60" : "space-y-3"}>
        {data?.items.map((b) => (
          <li key={b.id}>
            <BankCard bank={b} group={group || undefined} />
          </li>
        ))}
      </ul>
    </SitePage>
  );
}

function BankCard({ bank: b, group }: { bank: PublicBloodBank; group?: BloodGroup }) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900">{b.name}</h3>
          <p className="text-sm text-slate-600">
            {b.addressLine1}, {b.city}
          </p>
          <p className="text-xs text-slate-500">
            {b.is24x7 ? "Open 24 hours" : (b.operatingHours ?? "Call for opening hours")} · Licence{" "}
            {b.licenseNumber}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="green">Verified by MediQ</Badge>
          {b.distanceKm != null && <Badge tone="blue">{b.distanceKm.toFixed(1)} km</Badge>}
        </div>
      </div>
      <StockGrid stock={b.stock} highlight={group} />
      <FreshnessNote updatedAt={b.stockUpdatedAt} stale={b.stockStale} />
      <div className="flex flex-wrap gap-2">
        <a
          href={"tel:" + b.phone}
          className="inline-flex h-11 items-center rounded-xl bg-brand-700 px-5 text-sm font-semibold text-white hover:bg-brand-800"
        >
          Call
        </a>
        <a
          href={directionsUrl(b)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-11 items-center rounded-xl border border-slate-300 bg-white px-5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          Directions
        </a>
      </div>
    </Card>
  );
}
