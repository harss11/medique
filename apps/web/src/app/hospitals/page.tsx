"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RatingLine } from "@/components/reviews/stars";
import { SitePage } from "@/components/site-header";
import { Alert, Card, EmptyState, LoadingBlock, PageHeader, Pagination } from "@/components/ui";
import { useT } from "@/lib/i18n";
import type { Paginated, PublicHospitalListItem } from "@/lib/types";
import { useApi } from "@/lib/use-api";

export default function HospitalsPage() {
  const t = useT();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const qs = new URLSearchParams({ page: String(page), limit: "20" });
  if (debounced) qs.set("search", debounced);
  const { data, error, loading } = useApi<Paginated<PublicHospitalListItem>>(
    `/public/hospitals?${qs}`,
  );

  return (
    <SitePage>
      <PageHeader title="Find a hospital" subtitle="Choose a hospital, then a doctor and a time." />
      <input
        type="search"
        autoFocus
        aria-label="Search hospitals"
        placeholder="Search by hospital name or city"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:ring-2 focus:ring-brand-500"
      />
      {error && <Alert>{error}</Alert>}
      {loading && !data && <LoadingBlock />}
      {data && data.items.length === 0 && (
        <EmptyState title="No hospitals found">
          {debounced ? "Try a different name or city." : "No hospitals are open for booking yet."}
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <>
          <ul className="grid gap-3 sm:grid-cols-2">
            {data.items.map((h) => (
              <li key={h.id}>
                <Link href={`/h/${h.slug}`} className="block h-full">
                  <Card className="h-full transition hover:border-brand-400">
                    <h2 className="font-semibold text-slate-900">{h.name}</h2>
                    <p className="mt-0.5 text-sm text-slate-600">
                      {[h.addressLine1, h.city, h.state].filter(Boolean).join(", ")}
                    </p>
                    <RatingLine rating={h.rating} className="mt-1" />
                    {h.acceptingBookings === false && (
                      <p className="mt-1 text-xs font-medium text-red-700">
                        {t("booking.pausedShort")}
                      </p>
                    )}
                    <p className="mt-2 text-sm text-brand-800">
                      {h.doctorCount} {h.doctorCount === 1 ? "doctor" : "doctors"}
                    </p>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination {...data.pagination} onPage={setPage} />
        </>
      )}
    </SitePage>
  );
}
