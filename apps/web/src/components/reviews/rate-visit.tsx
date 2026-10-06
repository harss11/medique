"use client";

import { useState } from "react";
import { RatingLine, StarInput } from "@/components/reviews/stars";
import { Alert, Button, Card, Textarea } from "@/components/ui";
import { ConfirmDialog } from "@/components/modal";
import { api, errorMessage } from "@/lib/api";
import { formatDate, textOrNull } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Appointment } from "@/lib/types";

/** On a completed visit: rate it, see what you wrote, change it for a few days, or take it back. */
export function RateVisit({
  appointment: a,
  onChanged,
}: {
  appointment: Appointment;
  onChanged: (next: Appointment) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(a.review?.rating ?? 0);
  const [comment, setComment] = useState(a.review?.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  if (a.status !== "COMPLETED" || a.source !== "ONLINE") return null;
  if (!a.review && !a.canReview) return null;

  async function save() {
    if (rating < 1) {
      setError(t("rate.needStars"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = { rating, comment: textOrNull(comment) };
      const next = a.review
        ? await api.patch<Appointment>(`/appointments/${a.id}/review`, body)
        : await api.post<Appointment>(`/appointments/${a.id}/review`, body);
      onChanged(next);
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const showForm = editing || !a.review;
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold text-slate-900">
        {a.review ? t("rate.yourReview") : t("rate.title", { doctor: a.doctor.name })}
      </h2>

      {a.review && !showForm && (
        <>
          <RatingLine rating={{ average: a.review.rating, count: 1 }} single />
          {a.review.comment && (
            <p className="whitespace-pre-line text-slate-800">{a.review.comment}</p>
          )}
          <p className="text-xs text-slate-500">
            {t("rate.written", { date: formatDate(a.review.createdAt.slice(0, 10)) })}
          </p>
          {a.review.hidden && <Alert tone="info">{t("rate.hidden")}</Alert>}
          <div className="flex flex-wrap gap-2">
            {a.review.canEdit && (
              <Button variant="secondary" className="h-9 px-3" onClick={() => setEditing(true)}>
                {t("rate.change")}
              </Button>
            )}
            <Button
              variant="ghost"
              className="h-9 px-3 text-red-700"
              onClick={() => setWithdrawing(true)}
            >
              {t("rate.delete")}
            </Button>
          </div>
        </>
      )}

      {showForm && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <StarInput value={rating} onChange={setRating} />
          <Textarea
            label={t("rate.comment")}
            name="comment"
            maxLength={500}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            hint={t("rate.commentHint")}
          />
          {error && <Alert>{error}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>
              {a.review ? t("rate.save") : t("rate.post")}
            </Button>
            {a.review && (
              <Button variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
                {t("common.cancel")}
              </Button>
            )}
          </div>
        </form>
      )}

      <ConfirmDialog
        open={withdrawing}
        title={t("rate.confirmTitle")}
        message={t("rate.confirmText")}
        danger
        confirmLabel={t("rate.confirmButton")}
        onClose={() => setWithdrawing(false)}
        onConfirm={async () => {
          onChanged(await api.delete<Appointment>(`/appointments/${a.id}/review`));
          setRating(0);
          setComment("");
        }}
      />
    </Card>
  );
}
