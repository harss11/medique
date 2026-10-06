"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CancelDialog } from "@/components/desk/cancel-dialog";
import { CheckInBox } from "@/components/desk/check-in-box";
import { SummaryChips } from "@/components/desk/bits";
import { DeskRow } from "@/components/desk/desk-row";
import { ReceptionFrame } from "@/components/desk/frame";
import { useDeskActions } from "@/components/desk/use-desk-actions";
import { ConfirmDialog } from "@/components/modal";
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
import { api } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
import { showPdf } from "@/lib/pdf";
import type { DayList, DeskDoctor, SlipTemplateSummary, StaffAppointment } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { useAutoRefresh } from "@/lib/use-auto-refresh";

export default function ReceptionPage() {
  return (
    <ReceptionFrame>
      <Board />
    </ReceptionFrame>
  );
}

const STATUS_TABS = [
  ["all", "Everyone"],
  ["active", "Still to be seen"],
  ["done", "Seen / no-show"],
  ["cancelled", "Cancelled"],
] as const;

function Board() {
  const [date, setDate] = useState(""); // empty = today at this hospital
  const [doctorId, setDoctorId] = useState("");
  const [status, setStatus] = useState<(typeof STATUS_TABS)[number][0]>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [live, setLive] = useState(true);
  const [templateId, setTemplateId] = useState("");
  const [cashFor, setCashFor] = useState<StaffAppointment | null>(null);
  const [cancelFor, setCancelFor] = useState<StaffAppointment | null>(null);
  const [printAll, setPrintAll] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const params = new URLSearchParams({ status, page: String(page), limit: "50" });
  if (date) params.set("date", date);
  if (doctorId) params.set("doctorId", doctorId);
  if (search) params.set("search", search);

  const doctors = useApi<{ items: DeskDoctor[] }>("/desk/doctors");
  const templates = useApi<{ items: SlipTemplateSummary[] }>("/desk/slip-templates");
  const list = useApi<DayList>(`/desk/appointments?${params}`);
  useAutoRefresh(list.reload, 10_000, live);

  const actions = useDeskActions(list.reload, templateId || undefined);
  const data = list.data;
  const timezone = data?.timezone ?? "Asia/Kolkata";
  const shownDate = date || data?.date || "";
  const doctorOptions = doctors.data?.items ?? [];
  const slipTemplates = templates.data?.items ?? [];
  const toPrint = data ? data.summary.booked + data.summary.waiting + data.summary.inProgress : 0;

  const doctorName = doctorOptions.find((d) => d.id === doctorId)?.name;
  const forWhom = doctorId ? (doctorName ?? "this doctor") : "all doctors";
  const printAllMessage =
    "Print " +
    toPrint +
    (toPrint === 1 ? " slip" : " slips") +
    " for " +
    forWhom +
    "? Load the pre-printed paper first. Cancelled and already-seen patients are skipped.";

  async function printEverything() {
    const blob = await api.post<Blob>(
      "/desk/slips",
      {
        ...(doctorId ? { doctorId } : {}),
        ...(date ? { date } : {}),
        ...(templateId ? { templateId } : {}),
      },
      { blob: true },
    );
    const problem = showPdf(blob, "slips.pdf");
    if (problem) throw new Error(problem);
  }

  return (
    <>
      <PageHeader
        title="Reception"
        subtitle={shownDate ? formatDate(shownDate) : undefined}
        actions={
          <Link
            href="/reception/walk-in"
            className="inline-flex h-11 items-center rounded-xl bg-brand-700 px-5 text-sm font-semibold text-white hover:bg-brand-800"
          >
            New walk-in
          </Link>
        }
      />

      <CheckInBox onCheckedIn={list.reload} />

      {data && <SummaryChips summary={data.summary} />}

      <Card className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Doctor"
            value={doctorId}
            onChange={(e) => {
              setDoctorId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All doctors</option>
            {doctorOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.department.name}
              </option>
            ))}
          </Select>
          <Field
            label="Date"
            type="date"
            name="day"
            value={shownDate}
            onChange={(e) => {
              setDate(e.target.value);
              setPage(1);
            }}
          />
          <Field
            label="Find a patient"
            name="search"
            placeholder="Name, phone or token"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {slipTemplates.length > 1 && (
            <Select
              label="Slip paper"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">Default template</option>
              {slipTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.paperWidthMm}×{t.paperHeightMm} mm)
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-1">
            {STATUS_TABS.map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={status === value}
                onClick={() => {
                  setStatus(value);
                  setPage(1);
                }}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                  status === value
                    ? "bg-brand-700 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-brand-700"
                checked={live}
                onChange={(e) => setLive(e.target.checked)}
              />
              Refresh automatically
            </label>
            <Button
              variant="secondary"
              className="h-9 px-3"
              disabled={toPrint === 0}
              onClick={() => setPrintAll(true)}
            >
              Print all slips ({toPrint})
            </Button>
          </div>
        </div>
      </Card>

      {actions.error && <Alert>{actions.error}</Alert>}
      {list.error && !data && <Alert>{list.error}</Alert>}
      {!data && !list.error && <LoadingBlock />}

      {data && data.items.length === 0 && (
        <EmptyState title="No patients here">
          {search || status !== "all"
            ? "Try a different filter or search."
            : "Bookings and walk-ins for this day will appear here."}
        </EmptyState>
      )}

      {data && data.items.length > 0 && (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100">
            {data.items.map((a) => (
              <DeskRow
                key={a.id}
                a={a}
                timezone={timezone}
                busy={actions.busyId === a.id}
                showDoctor={!doctorId}
                actions={{
                  onCheckIn: (x) => void actions.checkIn(x.id),
                  onCash: setCashFor,
                  onSlip: (x) => void actions.printSlip(x),
                  onCancel: setCancelFor,
                  onNoShow: (x) => void actions.noShow(x.id),
                }}
              />
            ))}
          </ul>
        </Card>
      )}
      {data && (
        <Pagination
          page={data.pagination.page}
          totalPages={data.pagination.totalPages}
          total={data.pagination.total}
          onPage={setPage}
        />
      )}

      <ConfirmDialog
        open={!!cashFor}
        title="Record cash payment"
        message={
          cashFor && (
            <>
              Confirm you have received{" "}
              <strong>{formatMoney(cashFor.feeAmount, cashFor.currency)}</strong> in cash from{" "}
              {cashFor.patient.fullName} (token {cashFor.tokenNumber}).
            </>
          )
        }
        confirmLabel="Cash received"
        onConfirm={async () => {
          if (cashFor && (await actions.recordCash(cashFor.id)) === null) {
            throw new Error("Could not record the payment. See the message above.");
          }
        }}
        onClose={() => setCashFor(null)}
      />

      <ConfirmDialog
        open={printAll}
        title="Print all slips"
        message={printAllMessage}
        confirmLabel="Open PDF to print"
        onConfirm={printEverything}
        onClose={() => setPrintAll(false)}
      />

      <CancelDialog
        appointment={cancelFor}
        onClose={() => setCancelFor(null)}
        onDone={list.reload}
      />
    </>
  );
}
