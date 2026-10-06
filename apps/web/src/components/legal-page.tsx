import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "./ui";

export function LegalPage({
  title,
  version,
  children,
}: {
  title: string;
  version: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-white">
      <header className="mx-auto max-w-3xl px-4 py-4">
        <Logo />
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-16">
        <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Draft for development. This text must be reviewed by a qualified lawyer before launch.
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">Version {version}</p>
        <div className="mt-8 space-y-6 text-slate-700 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-900 [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
          {children}
        </div>
        <p className="mt-12 text-sm">
          <Link href="/" className="font-medium text-brand-700 hover:underline">
            Back to home
          </Link>
        </p>
      </main>
    </div>
  );
}
