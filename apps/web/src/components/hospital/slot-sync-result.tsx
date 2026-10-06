import { formatDateTime } from "@/lib/format";
import type { SlotSyncSummary } from "@/lib/types";
import { Alert } from "../ui";

/** Explains what a schedule/leave change did to the generated slots. */
export function SlotSyncResult({ summary }: { summary: SlotSyncSummary | null | undefined }) {
  if (!summary) return null;
  const { created, removed, updated, conflicts } = summary;
  const changed = created + removed + updated > 0;
  return (
    <div className="space-y-2">
      <Alert tone="success">
        Saved.{" "}
        {changed
          ? `Slots: ${created} added, ${removed} removed${updated ? `, ${updated} updated` : ""}.`
          : "Slots were already up to date."}
      </Alert>
      {conflicts.length > 0 && (
        <Alert>
          {conflicts.length} slot{conflicts.length === 1 ? "" : "s"} already{" "}
          {conflicts.length === 1 ? "has" : "have"} bookings and{" "}
          {conflicts.length === 1 ? "was" : "were"} kept. Contact those patients to reschedule:
          <ul className="mt-1 list-disc pl-5">
            {conflicts.slice(0, 5).map((c) => (
              <li key={c.slotId}>
                {formatDateTime(c.startAt)} ({c.bookedCount} booked)
              </li>
            ))}
            {conflicts.length > 5 && <li>…and {conflicts.length - 5} more</li>}
          </ul>
        </Alert>
      )}
    </div>
  );
}
