"use client";

import { useCallback, useState } from "react";
import { ApiError, api, errorMessage } from "@/lib/api";
import { showPdf } from "@/lib/pdf";
import type { CheckInResult, StaffAppointment } from "@/lib/types";

/** The desk and doctor actions, each reporting one busy row and one error line. */
export function useDeskActions(onChanged: () => void, templateId?: string) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when "start" is refused because another patient is still with the doctor. */
  const [conflict, setConflict] = useState<{ id: string; currentToken: number | null } | null>(
    null,
  );

  const run = useCallback(
    async <T>(id: string, work: () => Promise<T>): Promise<T | null> => {
      setBusyId(id);
      setError(null);
      try {
        const result = await work();
        onChanged();
        return result;
      } catch (err) {
        if (err instanceof ApiError && err.code === "IN_PROGRESS_EXISTS") {
          const details = err.details as { currentToken?: number } | undefined;
          setConflict({ id, currentToken: details?.currentToken ?? null });
        } else {
          setError(errorMessage(err));
        }
        return null;
      } finally {
        setBusyId(null);
      }
    },
    [onChanged],
  );

  const post = useCallback(
    <T = StaffAppointment>(id: string, action: string, body?: unknown) =>
      run(id, () => api.post<T>(`/desk/appointments/${id}/${action}`, body)),
    [run],
  );

  const printSlip = useCallback(
    async (a: StaffAppointment) => {
      setBusyId(a.id);
      setError(null);
      try {
        const qs = templateId ? `?templateId=${templateId}` : "";
        const blob = await api.download(`/desk/appointments/${a.id}/slip${qs}`);
        const problem = showPdf(blob, `slip-token-${a.tokenNumber ?? "x"}.pdf`);
        if (problem) setError(problem);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [templateId],
  );

  return {
    busyId,
    error,
    setError,
    conflict,
    clearConflict: () => setConflict(null),
    checkIn: (id: string) => post<CheckInResult>(id, "check-in"),
    start: (id: string, completeCurrent = false) => post(id, "start", { completeCurrent }),
    complete: (id: string) => post(id, "complete"),
    noShow: (id: string) => post(id, "no-show"),
    recordCash: (id: string) => post(id, "cash"),
    printSlip,
  };
}
