import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import type { LocalePreference } from "../../shared/ipc";
import { messages as activity } from "./activity";
import { messages as btw } from "./btw";
import { messages as common } from "./common";
import { messages as composer } from "./composer";
import { messages as conversation } from "./conversation";
import { messages as shell } from "./shell";
import { messages as wizard } from "./wizard";

export type Locale = "en" | "ko";

type Dictionary = { readonly en: Record<string, string>; readonly ko: Record<string, string> };

/** Compile-time check that a dictionary's `ko` object has exactly the keys of its `en` object. */
type Aligned<D extends Dictionary> = keyof D["en"] extends keyof D["ko"]
  ? keyof D["ko"] extends keyof D["en"]
    ? D
    : never
  : never;

function aligned<D extends Dictionary>(dictionary: Aligned<D>): D {
  return dictionary;
}

const DICTIONARIES = [aligned(common), aligned(shell), aligned(conversation), aligned(composer), aligned(activity), aligned(btw), aligned(wizard)] as const;

const EN = { ...common.en, ...shell.en, ...conversation.en, ...composer.en, ...activity.en, ...btw.en, ...wizard.en } as const;
const KO = { ...common.ko, ...shell.ko, ...conversation.ko, ...composer.ko, ...activity.ko, ...btw.ko, ...wizard.ko } as const;

export type MessageKey = keyof typeof EN;

const TABLES: Record<Locale, Record<MessageKey, string>> = { en: EN, ko: KO };

/** Resolves the stored preference to a concrete locale; "system" picks Korean for a `ko*` navigator language. */
export function resolveLocale(pref: LocalePreference, navigatorLanguage: string): Locale {
  if (pref === "en" || pref === "ko") return pref;
  return navigatorLanguage.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export type Vars = Record<string, string | number>;

function interpolate(template: string, vars: Vars | undefined): string {
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** Looks up `key` in `locale` and substitutes `{name}` placeholders from `vars`. */
export function t(locale: Locale, key: MessageKey, vars?: Vars): string {
  return interpolate(TABLES[locale][key], vars);
}

export type Translate = (key: MessageKey, vars?: Vars) => string;

export interface I18nValue {
  locale: Locale;
  t: Translate;
}

export const I18nContext = createContext<I18nValue>({ locale: "en", t: (key, vars) => t("en", key, vars) });

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<I18nValue>(() => ({ locale, t: (key, vars) => t(locale, key, vars) }), [locale]);
  return createElement(I18nContext.Provider, { value }, children);
}

export function useT(): Translate {
  return useContext(I18nContext).t;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}

void DICTIONARIES;
