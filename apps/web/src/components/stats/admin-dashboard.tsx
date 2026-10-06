"use client";

import { useState } from "react";
import { Alert, Card, LoadingBlock } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import type { AdminStats } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { BarChart, HBars } from "./charts";
import { MoneyBlock, OutstandingRefunds, StatCard, pct } from "./bits";
import { PeriodPicker, periodQuery, type Period } from "./period-picker";

const short = (date: string) => date.slice(8) + "/" + date.slice(5, 7);

/** Revenue and booking statistics across the whole platform. */
export function AdminDashboard() {
  const [period, setPeriod] = useState<Period>({ days: 30 });
  const { data, error, loading } = useApi<AdminStats>("/admin/stats?" + periodQuery(period));

  return (
    <section className="space-y-4" aria-labelledby="stats-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="stats-heading" className="text-lg font-semibold text-slate-900">
            Bookings and revenue
          </h2>
          {data && (
            <p className="text-sm text-slate-600">
              {formatDate(data.range.from)} to {formatDate(data.range.to)} ({data.range.days} days,{" "}
              {data.range.timezone})
            </p>
          )}
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      {error && <Alert>{error}</Alert>}
      {!data && !error && <LoadingBlock />}
      {data && (
        <div className={loading ? "space-y-4 opacity-60 transition-opacity" : "space-y-4"}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Bookings"
              value={data.bookings.total}
              hint={data.bookings.online + " online · " + data.bookings.walkIn + " walk-in"}
            />
            <StatCard
              label="Seen"
              value={data.bookings.completed}
              hint={data.bookings.active + " still to come"}
            />
            <StatCard
              label="Cancelled"
              value={pct(data.bookings.cancellationRate)}
              hint={data.bookings.cancelled + " bookings"}
            />
            <StatCard
              label="No-shows"
              value={pct(data.bookings.noShowRate)}
              hint="of patients whose visit is decided"
            />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Active hospitals"
              value={data.totals.hospitals.active}
              hint={
                data.totals.hospitals.pending +
                " pending · " +
                data.totals.hospitals.blocked +
                " blocked"
              }
            />
            <StatCard label="Active doctors" value={data.totals.activeDoctors} />
            <StatCard
              label="Patients"
              value={data.totals.patients}
              hint={data.totals.newPatients + " joined in this period"}
            />
          </div>

          <OutstandingRefunds rows={data.refundsOutstanding} />

          <Card className="grid gap-6 lg:grid-cols-2">
            <BarChart
              title="Bookings per day (by visit date)"
              bars={data.daily.map((d) => ({
                label: short(d.date),
                value: d.booked,
                text:
                  formatDate(d.date) + ": " + d.booked + " booked, " + d.cancelled + " cancelled",
              }))}
            />
            <BarChart
              title={"Online payments per day (" + data.revenueCurrency + ")"}
              tone="bg-emerald-600"
              format={(n) => formatMoney(n, data.revenueCurrency)}
              bars={data.daily.map((d) => ({ label: short(d.date), value: d.onlineGross }))}
            />
          </Card>

          <div className="space-y-4">
            <h3 className="font-semibold text-slate-900">Money</h3>
            {data.money.length === 0 && (
              <p className="text-sm text-slate-500">No payments in this period.</p>
            )}
            {data.money.map((m) => (
              <div key={m.currency} className="space-y-2">
                {data.money.length > 1 && (
                  <h4 className="text-sm font-medium text-slate-700">{m.currency}</h4>
                )}
                <MoneyBlock m={m} />
              </div>
            ))}
            <p className="text-xs text-slate-500">
              Online payments count on the day they were paid and refunds on the day they were
              processed. Commission is MediQ&apos;s fee on the money kept after refunds. Cash taken
              at the desk carries no commission.
            </p>
          </div>

          <Card>
            <HBars
              title="Busiest hospitals (bookings)"
              rows={data.topHospitals.map((h) => ({
                label: h.name,
                value: h.bookings,
                note: formatMoney(h.onlineGross, data.revenueCurrency) + " online",
              }))}
            />
          </Card>
        </div>
      )}
    </section>
  );
}
