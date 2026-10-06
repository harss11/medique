import { Badge, Button } from "@/components/ui";
import { formatTime } from "@/lib/format";
import type { StaffAppointment } from "@/lib/types";
import { PaymentBadge, QueueStatusBadge, TokenBubble, ageGender } from "./bits";

export interface RowActions {
  onCheckIn?: (a: StaffAppointment) => void;
  onCash?: (a: StaffAppointment) => void;
  onSlip?: (a: StaffAppointment) => void;
  onCancel?: (a: StaffAppointment) => void;
  onNoShow?: (a: StaffAppointment) => void;
  onStart?: (a: StaffAppointment) => void;
  onComplete?: (a: StaffAppointment) => void;
}

const LIVE = new Set(["CONFIRMED", "CHECKED_IN", "IN_PROGRESS"]);

/**
 * One patient on the desk or doctor list. Buttons appear only for actions that make sense in
 * the patient's current status; the API enforces the same rules.
 */
export function DeskRow({
  a,
  timezone,
  busy,
  showDoctor,
  actions,
}: {
  a: StaffAppointment;
  timezone: string;
  busy: boolean;
  showDoctor: boolean;
  actions: RowActions;
}) {
  const live = LIVE.has(a.status);
  const owes = !a.paid && a.feeAmount > 0 && live;
  const small = "h-9 px-3";
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <TokenBubble token={a.tokenNumber} active={a.status === "IN_PROGRESS"} />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-slate-900">{a.patient.fullName}</span>
            <span className="text-sm text-slate-500">{ageGender(a.patient)}</span>
          </div>
          <div className="text-sm text-slate-600">
            {formatTime(a.slotStart, timezone)}
            {showDoctor && ` · ${a.doctor.name}`}
            {a.patient.phone && ` · ${a.patient.phone}`}
          </div>
          {a.reasonForVisit && <div className="text-sm text-slate-500">{a.reasonForVisit}</div>}
          <div className="flex flex-wrap items-center gap-1.5">
            <QueueStatusBadge status={a.status} />
            {a.source === "WALK_IN" && <Badge tone="slate">Walk-in</Badge>}
            <PaymentBadge a={a} />
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 sm:justify-end">
        {actions.onStart && (a.status === "CHECKED_IN" || a.status === "CONFIRMED") && (
          <Button className={small} loading={busy} onClick={() => actions.onStart?.(a)}>
            Start
          </Button>
        )}
        {actions.onComplete && a.status === "IN_PROGRESS" && (
          <Button className={small} loading={busy} onClick={() => actions.onComplete?.(a)}>
            Complete
          </Button>
        )}
        {actions.onCheckIn && a.status === "CONFIRMED" && (
          <Button className={small} loading={busy} onClick={() => actions.onCheckIn?.(a)}>
            Check in
          </Button>
        )}
        {actions.onCash && owes && (
          <Button
            variant="secondary"
            className={small}
            disabled={busy}
            onClick={() => actions.onCash?.(a)}
          >
            Record cash
          </Button>
        )}
        {actions.onSlip && a.status !== "CANCELLED" && (
          <Button
            variant="secondary"
            className={small}
            disabled={busy}
            onClick={() => actions.onSlip?.(a)}
          >
            Print slip
          </Button>
        )}
        {actions.onNoShow && (a.status === "CONFIRMED" || a.status === "CHECKED_IN") && (
          <Button
            variant="ghost"
            className={small}
            disabled={busy}
            onClick={() => actions.onNoShow?.(a)}
          >
            No-show
          </Button>
        )}
        {actions.onCancel && (a.status === "CONFIRMED" || a.status === "CHECKED_IN") && (
          <Button
            variant="ghost"
            className={`${small} text-red-700 hover:bg-red-50`}
            disabled={busy}
            onClick={() => actions.onCancel?.(a)}
          >
            Cancel
          </Button>
        )}
      </div>
    </li>
  );
}
