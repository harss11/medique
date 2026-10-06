"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DoctorAvatar } from "@/components/hospital/doctor-avatar";
import { RatingLine } from "@/components/reviews/stars";
import { SitePage } from "@/components/site-header";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  LoadingBlock,
  PageHeader,
  Pagination,
  Select,
} from "@/components/ui";
import { formatDate, formatMoney, formatTime, toMinor, todayIn } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { DoctorSearchResponse } from "@/lib/types";
import { useApi } from "@/lib/use-api";

const SORTS = ["recommended", "soonest", "rating", "fee_asc", "fee_desc", "experience"] as const;

interface Filters {
  city: string;
  specialization: string;
  language: string;
  gender: string;
  minRating: string;
  maxFee: string;
  availableOn: string;
  sort: string;
}

const NO_FILTERS: Filters = {
  city: "",
  specialization: "",
  language: "",
  gender: "",
  minRating: "",
  maxFee: "",
  availableOn: "",
  sort: "recommended",
};

/** Find a doctor by words, place, speciality, language, rating, fee and availability. */
export default function SearchPage() {
  const t = useT();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(text.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);

  const qs = new URLSearchParams({ page: String(page), limit: "12", sort: filters.sort });
  if (q) qs.set("q", q);
  for (const key of [
    "city",
    "specialization",
    "language",
    "gender",
    "minRating",
    "availableOn",
  ] as const) {
    if (filters[key]) qs.set(key, filters[key]);
  }
  const maxFee = filters.maxFee ? toMinor(filters.maxFee) : Number.NaN;
  if (!Number.isNaN(maxFee)) qs.set("maxFee", String(maxFee));

  const { data, error, loading } = useApi<DoctorSearchResponse>(`/public/search/doctors?${qs}`, {
    auth: false,
  });

  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const active = (Object.keys(NO_FILTERS) as Array<keyof Filters>).some(
    (k) => k !== "sort" && filters[k] !== "",
  );

  return (
    <SitePage>
      <PageHeader title={t("search.title")} subtitle={t("search.subtitle")} />
      <input
        type="search"
        autoFocus
        aria-label={t("search.aria")}
        placeholder={t("search.placeholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:ring-2 focus:ring-brand-500"
      />

      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label={t("search.speciality")}
          value={filters.specialization}
          onChange={(e) => set({ specialization: e.target.value })}
        >
          <option value="">{t("common.any")}</option>
          {(data?.facets.specializations ?? []).map((f) => (
            <option key={f.value} value={f.value}>
              {f.value} ({f.count})
            </option>
          ))}
        </Select>
        <Select
          label={t("search.city")}
          value={filters.city}
          onChange={(e) => set({ city: e.target.value })}
        >
          <option value="">{t("common.any")}</option>
          {(data?.facets.cities ?? []).map((f) => (
            <option key={f.value} value={f.value}>
              {f.value} ({f.count})
            </option>
          ))}
        </Select>
        <Select
          label={t("search.language")}
          value={filters.language}
          onChange={(e) => set({ language: e.target.value })}
        >
          <option value="">{t("common.any")}</option>
          {(data?.facets.languages ?? []).map((f) => (
            <option key={f.value} value={f.value}>
              {f.value} ({f.count})
            </option>
          ))}
        </Select>
        <Select
          label={t("search.doctor")}
          value={filters.gender}
          onChange={(e) => set({ gender: e.target.value })}
        >
          <option value="">{t("common.any")}</option>
          <option value="FEMALE">{t("search.female")}</option>
          <option value="MALE">{t("search.male")}</option>
        </Select>
        <Select
          label={t("search.rating")}
          value={filters.minRating}
          onChange={(e) => set({ minRating: e.target.value })}
        >
          <option value="">{t("common.any")}</option>
          <option value="4.5">{t("search.rating45")}</option>
          <option value="4">{t("search.rating4")}</option>
          <option value="3">{t("search.rating3")}</option>
        </Select>
        <Field
          label={t("search.maxFee")}
          name="maxFee"
          inputMode="numeric"
          placeholder={t("common.any")}
          value={filters.maxFee}
          onChange={(e) => set({ maxFee: e.target.value.replace(/[^\d.]/g, "") })}
        />
        <Field
          label={t("search.availableOn")}
          name="availableOn"
          type="date"
          min={todayIn()}
          value={filters.availableOn}
          onChange={(e) => set({ availableOn: e.target.value })}
        />
        <Select
          label={t("search.sortBy")}
          value={filters.sort}
          onChange={(e) => set({ sort: e.target.value })}
        >
          {SORTS.map((value) => (
            <option key={value} value={value}>
              {t(`search.sort.${value}`)}
            </option>
          ))}
        </Select>
        {active && (
          <div className="sm:col-span-2 lg:col-span-4">
            <Button
              variant="ghost"
              className="h-9 px-3"
              onClick={() => set({ ...NO_FILTERS, sort: filters.sort })}
            >
              {t("search.clear")}
            </Button>
          </div>
        )}
      </Card>

      {error && <Alert>{error}</Alert>}
      {loading && !data && <LoadingBlock />}
      {data && data.capped && <Alert tone="info">{t("search.capped")}</Alert>}
      {data && data.items.length === 0 && (
        <EmptyState title={t("search.emptyTitle")}>{t("search.emptyText")}</EmptyState>
      )}
      {data && data.items.length > 0 && (
        <>
          <ul className={loading ? "grid gap-3 opacity-60" : "grid gap-3"}>
            {data.items.map((d) => (
              <li key={d.id}>
                <Link href={`/doctors/${d.id}`} className="block">
                  <Card className="flex flex-col gap-3 p-4 transition hover:border-brand-400 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 items-center gap-4">
                      <DoctorAvatar doctor={d} />
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900">{d.name}</div>
                        <div className="truncate text-sm text-slate-600">
                          {[d.specialization ?? d.department.name, d.qualification]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                        <div className="truncate text-sm text-slate-600">
                          {d.hospital.name}
                          {d.hospital.city ? `, ${d.hospital.city}` : ""}
                        </div>
                        <RatingLine rating={d.rating} className="mt-0.5" />
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end sm:justify-center">
                      <div className="font-semibold text-slate-900">
                        {formatMoney(d.consultationFee, d.hospital.currency)}
                      </div>
                      {d.hospital.acceptingBookings === false ? (
                        <div className="text-xs font-medium text-red-700">
                          {t("booking.pausedShort")}
                        </div>
                      ) : d.nextAvailable ? (
                        <div className="text-xs font-medium text-emerald-700">
                          {t("search.next", {
                            date: formatDate(d.nextAvailable.date),
                            time: formatTime(d.nextAvailable.startAt),
                          })}
                        </div>
                      ) : (
                        <div className="text-xs font-medium text-amber-700">
                          {t("search.noSeats")}
                        </div>
                      )}
                    </div>
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
