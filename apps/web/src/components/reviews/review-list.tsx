"use client";

import { useState } from "react";
import { RatingLine, Stars } from "@/components/reviews/stars";
import { Alert, Button, Card, LoadingBlock } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { PublicReviewList } from "@/lib/types";
import { useApi } from "@/lib/use-api";

/** The public reviews of a doctor or a hospital: the average, the star counts and what people wrote. */
export function ReviewList({ path, showDoctor = false }: { path: string; showDoctor?: boolean }) {
  const t = useT();
  const [page, setPage] = useState(1);
  const { data, error, loading } = useApi<PublicReviewList>(`${path}?page=${page}&limit=5`, {
    auth: false,
  });

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <LoadingBlock />;
  const { summary, items, pagination } = data;
  if (summary.count === 0) {
    return <p className="text-sm text-slate-600">{t("reviews.empty")}</p>;
  }
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-6 p-4">
        <div className="text-center">
          <div className="text-4xl font-bold text-slate-900">{summary.average?.toFixed(1)}</div>
          <Stars value={summary.average ?? 0} className="text-lg" />
          <div className="text-xs text-slate-500">
            {summary.count === 1
              ? t("reviews.summaryOne")
              : t("reviews.summaryMany", { count: summary.count })}
          </div>
        </div>
        <ul
          className="min-w-48 flex-1 space-y-1 text-xs text-slate-600"
          aria-label={t("reviews.byStars")}
        >
          {[5, 4, 3, 2, 1].map((n) => {
            const count = summary.distribution[n as 1 | 2 | 3 | 4 | 5];
            return (
              <li key={n} className="flex items-center gap-2">
                <span className="w-14">{t("reviews.stars", { n })}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full bg-amber-500"
                    style={{ width: `${(count / summary.count) * 100}%` }}
                  />
                </span>
                <span className="w-6 text-right tabular-nums">{count}</span>
              </li>
            );
          })}
        </ul>
      </Card>

      <ul className={loading ? "space-y-3 opacity-60" : "space-y-3"}>
        {items.map((r, i) => (
          <li key={`${page}-${i}`} className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <RatingLine rating={{ average: r.rating, count: 1 }} single />
              <span className="text-xs text-slate-500">{formatDate(r.createdAt.slice(0, 10))}</span>
            </div>
            {r.comment && <p className="mt-2 whitespace-pre-line text-slate-800">{r.comment}</p>}
            <p className="mt-2 text-xs text-slate-500">
              {r.reviewer}
              {showDoctor ? ` · ${t("reviews.about", { doctor: r.doctor })}` : ""}
            </p>
          </li>
        ))}
      </ul>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">
            {t("reviews.page", { page: pagination.page, pages: pagination.totalPages })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="h-9 px-3"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              {t("reviews.newer")}
            </Button>
            <Button
              variant="secondary"
              className="h-9 px-3"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage(page + 1)}
            >
              {t("reviews.older")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
