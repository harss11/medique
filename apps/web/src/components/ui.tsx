import Link from "next/link";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useT } from "@/lib/i18n";

/** Small set of presentational primitives. No business logic here. */

export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={cx("inline-flex items-center gap-2 font-semibold", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" width={28} height={28} className="rounded-md" />
      <span className="text-lg tracking-tight text-slate-900">MediQ</span>
    </Link>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  // Default padding unless the caller sets its own (p-0 for edge-to-edge lists).
  const customPadding = /(^|\s)p-\d/.test(className ?? "");
  return (
    <div
      className={cx(
        "rounded-2xl border border-slate-200 bg-white shadow-sm",
        !customPadding && "p-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
};

export function Button({
  variant = "primary",
  loading,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cx(
        "inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
        variant === "primary" && "bg-brand-700 text-white hover:bg-brand-800",
        variant === "secondary" &&
          "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50",
        variant === "ghost" && "text-slate-700 hover:bg-slate-100",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        className,
      )}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
  prefix?: string;
  trailing?: ReactNode;
};

export function Field({
  label,
  hint,
  error,
  prefix,
  trailing,
  id,
  className,
  ...props
}: FieldProps) {
  const inputId = id ?? props.name;
  return (
    <div className={className}>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <div
        className={cx(
          "flex h-11 items-center rounded-xl border bg-white focus-within:ring-2 focus-within:ring-brand-500",
          error ? "border-red-400" : "border-slate-300",
        )}
      >
        {prefix && <span className="pl-3 text-sm text-slate-500">{prefix}</span>}
        <input
          id={inputId}
          {...props}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${inputId}-help` : undefined}
          className="h-full w-full min-w-0 rounded-xl bg-transparent px-3 text-base text-slate-900 outline-none placeholder:text-slate-400 sm:text-sm"
        />
        {trailing}
      </div>
      {(error || hint) && (
        <p
          id={`${inputId}-help`}
          className={cx("mt-1.5 text-xs", error ? "text-red-600" : "text-slate-500")}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function Alert({
  children,
  tone = "error",
}: {
  children: ReactNode;
  tone?: "error" | "info" | "success";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "rounded-xl border px-4 py-3 text-sm",
        tone === "error" && "border-red-200 bg-red-50 text-red-800",
        tone === "info" && "border-sky-200 bg-sky-50 text-sky-900",
        tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-900",
      )}
    >
      {children}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx("animate-spin", className ?? "size-6")}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function FullPageSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-brand-700">
      <Spinner className="size-8" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

const controlClass =
  "w-full rounded-xl border bg-white px-3 text-base text-slate-900 outline-none focus:ring-2 focus:ring-brand-500 sm:text-sm";

function FieldShell({
  label,
  id,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  id?: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {(error || hint) && (
        <p className={cx("mt-1.5 text-xs", error ? "text-red-600" : "text-slate-500")}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: string;
  error?: string;
};

export function Select({ label, hint, error, id, className, children, ...props }: SelectProps) {
  const selectId = id ?? props.name;
  return (
    <FieldShell label={label} id={selectId} hint={hint} error={error} className={className}>
      <select
        id={selectId}
        {...props}
        aria-invalid={error ? true : undefined}
        className={cx(controlClass, "h-11", error ? "border-red-400" : "border-slate-300")}
      >
        {children}
      </select>
    </FieldShell>
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: string;
  error?: string;
};

export function Textarea({ label, hint, error, id, className, ...props }: TextareaProps) {
  const areaId = id ?? props.name;
  return (
    <FieldShell label={label} id={areaId} hint={hint} error={error} className={className}>
      <textarea
        id={areaId}
        rows={3}
        {...props}
        aria-invalid={error ? true : undefined}
        className={cx(controlClass, "py-2.5", error ? "border-red-400" : "border-slate-300")}
      />
    </FieldShell>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-3 text-sm text-slate-700">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-brand-700"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

type BadgeTone = "green" | "amber" | "red" | "slate" | "blue";

export function Badge({ tone = "slate", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap",
        tone === "green" && "bg-emerald-100 text-emerald-800",
        tone === "amber" && "bg-amber-100 text-amber-800",
        tone === "red" && "bg-red-100 text-red-800",
        tone === "slate" && "bg-slate-100 text-slate-700",
        tone === "blue" && "bg-sky-100 text-sky-800",
      )}
    >
      {children}
    </span>
  );
}

const HOSPITAL_STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  PENDING_APPROVAL: { tone: "amber", label: "Pending approval" },
  ACTIVE: { tone: "green", label: "Active" },
  BLOCKED: { tone: "red", label: "Blocked" },
};

export function HospitalStatusBadge({ status }: { status: string }) {
  const s = HOSPITAL_STATUS[status] ?? { tone: "slate" as const, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <div>
      {back && (
        <Link
          href={back.href}
          className="mb-2 inline-block text-sm text-slate-600 hover:text-slate-900"
        >
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          {subtitle && <div className="mt-0.5 text-slate-600">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center">
      <p className="font-medium text-slate-900">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-600">{children}</div>}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const t = useT();
  if (totalPages <= 1) {
    return <p className="text-xs text-slate-500">{t("common.total", { count: total })}</p>;
  }
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-slate-500">
        {t("common.pageOf", { page, pages: totalPages, count: total })}
      </span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          className="h-9 px-3"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          {t("common.previous")}
        </Button>
        <Button
          variant="secondary"
          className="h-9 px-3"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          {t("common.next")}
        </Button>
      </div>
    </div>
  );
}

export function LoadingBlock() {
  return (
    <div className="flex justify-center p-10 text-brand-700">
      <Spinner />
      <span className="sr-only">Loading</span>
    </div>
  );
}
