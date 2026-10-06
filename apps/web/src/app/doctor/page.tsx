"use client";

import { SummaryChips, ageGender } from "@/components/desk/bits";
import { DeskRow } from "@/components/desk/desk-row";
import { DoctorFrame } from "@/components/desk/frame";
import { useDeskActions } from "@/components/desk/use-desk-actions";
import { ConfirmDialog } from "@/components/modal";
import { Alert, Button, Card, EmptyState, LoadingBlock, PageHeader } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { formatDate, formatTime } from "@/lib/format";
import type { DayList, StaffAppointment } from "@/lib/types";
import { useApi } from "@/lib/use-api";
import { useAutoRefresh } from "@/lib/use-auto-refresh";

export default function DoctorPage() {
  return (
    <DoctorFrame>
      <Queue />
    </DoctorFrame>
  );
}

function Section({
  title,
  items,
  children,
}: {
  title: string;
  items: StaffAppointment[];
  children: (a: StaffAppointment) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
        {title} ({items.length})
      </h2>
      <Card className="p-0">
        <ul className="divide-y divide-slate-100">{items.map(children)}</ul>
      </Card>
    </section>
  );
}

function Queue() {
  const { user } = useAuth();
  const list = useApi<DayList>("/desk/appointments?status=all&limit=100");
  useAutoRefresh(list.reload, 8_000);
  const actions = useDeskActions(list.reload);
  const data = list.data;
  const zone = data?.timezone ?? "Asia/Kolkata";
  const items = data?.items ?? [];

  const inRoom = items.find((a) => a.status === "IN_PROGRESS") ?? null;
  const waiting = items.filter((a) => a.status === "CHECKED_IN");
  const booked = items.filter((a) => a.status === "CONFIRMED");
  const finished = items.filter((a) => a.status === "COMPLETED" || a.status === "NO_SHOW");
  const next = waiting[0] ?? null;
  const conflictWith = actions.conflict
    ? items.find((a) => a.id === actions.conflict?.id)
    : undefined;

  const rowActions = {
    onStart: (a: StaffAppointment) => void actions.start(a.id),
    onComplete: (a: StaffAppointment) => void actions.complete(a.id),
    onNoShow: (a: StaffAppointment) => void actions.noShow(a.id),
    onSlip: (a: StaffAppointment) => void actions.printSlip(a),
  };
  const renderRow = (a: StaffAppointment) => (
    <DeskRow
      key={a.id}
      a={a}
      timezone={zone}
      busy={actions.busyId === a.id}
      showDoctor={false}
      actions={rowActions}
    />
  );

  return (
    <>
      <PageHeader
        title={"Hello, " + (user?.name ?? "")}
        subtitle={data ? formatDate(data.date) + " · your queue" : "Your queue"}
      />
      {data && <SummaryChips summary={data.summary} />}
      {actions.error && <Alert>{actions.error}</Alert>}
      {list.error && !data && <Alert>{list.error}</Alert>}
      {!data && !list.error && <LoadingBlock />}

      {data && (
        <Card className="space-y-4">
          {inRoom ? (
            <>
              <div className="flex items-center gap-4">
                <div className="flex size-20 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-4xl font-bold text-white tabular-nums">
                  {inRoom.tokenNumber}
                </div>
                <div className="min-w-0">
                  <div className="text-sm text-slate-500">With you now</div>
                  <div className="truncate text-xl font-semibold text-slate-900">
                    {inRoom.patient.fullName}
                  </div>
                  <div className="text-sm text-slate-600">
                    {[ageGender(inRoom.patient), inRoom.reasonForVisit].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  loading={actions.busyId === inRoom.id}
                  onClick={() => actions.complete(inRoom.id)}
                >
                  Complete
                </Button>
                {next && (
                  <Button
                    variant="secondary"
                    disabled={actions.busyId !== null}
                    onClick={() => actions.start(next.id, true)}
                  >
                    Complete and call token {next.tokenNumber}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">
                  {next
                    ? "Next: token " + next.tokenNumber + " · " + next.patient.fullName
                    : "Nobody is waiting"}
                </div>
                <p className="text-sm text-slate-600">
                  {next
                    ? "Checked in at " + formatTime(next.checkedInAt ?? next.slotStart, zone)
                    : booked.length > 0
                      ? booked.length + " booked but not yet at the hospital."
                      : "New arrivals appear here as reception checks them in."}
                </p>
              </div>
              <Button
                disabled={!next || actions.busyId !== null}
                onClick={() => next && actions.start(next.id)}
              >
                Call next patient
              </Button>
            </div>
          )}
        </Card>
      )}

      {data && items.length === 0 && (
        <EmptyState title="No patients today">Bookings for today will appear here.</EmptyState>
      )}

      <Section title="Waiting" items={waiting}>
        {renderRow}
      </Section>
      <Section title="Booked, not arrived" items={booked}>
        {renderRow}
      </Section>
      <Section title="Finished" items={finished}>
        {renderRow}
      </Section>
      {data && data.pagination.total > items.length && (
        <p className="text-xs text-slate-500">Showing the first {items.length} patients.</p>
      )}

      <ConfirmDialog
        open={!!actions.conflict}
        title="Finish the current patient?"
        message={
          "Token " +
          (actions.conflict?.currentToken ?? "?") +
          " is still with you. Complete that consultation and start " +
          (conflictWith
            ? conflictWith.patient.fullName + " (token " + conflictWith.tokenNumber + ")"
            : "this patient") +
          "?"
        }
        confirmLabel="Complete and start"
        onConfirm={async () => {
          const id = actions.conflict?.id;
          if (id) await actions.start(id, true);
        }}
        onClose={actions.clearConflict}
      />
    </>
  );
}
