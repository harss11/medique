"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { en, type MessageKey } from "./messages.en";
import { hi } from "./messages.hi";

export type Language = "en" | "hi";
export const LANGUAGES: ReadonlyArray<{ code: Language; label: string }> = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी" },
];

const TEXTS: Record<Language, Record<MessageKey, string>> = { en, hi };
const STORAGE_KEY = "mediq-language";

// ----- the choice, kept in the browser so a visitor without an account has one too -----

const listeners = new Set<() => void>();
/** The choice when browser storage is blocked: lasts until the page is closed. */
let memory: Language | null = null;

function readStored(): Language | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "hi" || v === "en" ? v : null;
  } catch {
    return null;
  }
}

function writeStored(lang: Language) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    memory = lang;
  }
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

const getSnapshot = (): Language => readStored() ?? memory ?? "en";
// The server and the first client render are English; the saved choice applies right after.
const getServerSnapshot = (): Language => "en";

// ----- context -----

type Vars = Record<string, string | number>;

interface LanguageValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: MessageKey, vars?: Vars) => string;
}

const LanguageContext = createContext<LanguageValue | null>(null);

function format(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** Texts in the visitor's language. A patient's choice is also saved on their account (for SMS). */
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const language = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { user } = useAuth();

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // Somebody who chose Hindi on another device and has not chosen here yet gets their choice.
  const accountLanguage = user?.language;
  useEffect(() => {
    if (accountLanguage && readStored() === null && memory === null) writeStored(accountLanguage);
  }, [accountLanguage]);

  const patient = user?.role === "PATIENT";
  const setLanguage = useCallback(
    (lang: Language) => {
      writeStored(lang);
      if (patient) {
        // Best effort: the page is already in the new language either way.
        api.patch("/patient/account/language", { language: lang }).catch(() => undefined);
      }
    },
    [patient],
  );

  const value = useMemo<LanguageValue>(
    () => ({
      language,
      setLanguage,
      t: (key, vars) => format(TEXTS[language][key] ?? en[key], vars),
    }),
    [language, setLanguage],
  );
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used inside <LanguageProvider>");
  return ctx;
}

/** `const t = useT(); t("nav.doctors")` */
export function useT() {
  return useLanguage().t;
}

export type { MessageKey };
