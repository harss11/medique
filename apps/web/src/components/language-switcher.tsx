"use client";

import { LANGUAGES, useLanguage } from "@/lib/i18n";
import { cx } from "./ui";

/** English | हिन्दी. Two buttons: the choice is one tap away on every screen. */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { language, setLanguage, t } = useLanguage();
  return (
    <div
      role="group"
      aria-label={t("lang.label")}
      className={cx(
        "inline-flex overflow-hidden rounded-xl border border-slate-300 text-xs font-semibold",
        className,
      )}
    >
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          aria-pressed={language === l.code}
          onClick={() => setLanguage(l.code)}
          className={cx(
            "px-2.5 py-1.5",
            language === l.code
              ? "bg-brand-700 text-white"
              : "bg-white text-slate-700 hover:bg-slate-50",
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
