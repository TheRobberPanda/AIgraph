/**
 * The app's own words, in the languages people actually use it in.
 *
 * This is separate from the language setting that steers the model — that one
 * decides what the model writes into your notes and ideas; this one decides
 * what the app's own buttons and labels say. They share one dropdown in
 * Settings because most people want both to agree, but a Polish speaker
 * reading a Spanish idea is a real and reasonable choice, so the two stay
 * independently readable in code even though the UI sets them together.
 *
 * English is the source text and the fallback: a key with no Polish or
 * Spanish entry yet still reads correctly in English rather than showing a
 * key name or a blank space. Add entries as they come up rather than trying
 * to translate every string in the app in one pass — a stale translation
 * sitting unnoticed next to a live one is worse than an English string in a
 * Polish screen, which is at least legible.
 */

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSettings, type Language } from "./settings";

type Key = keyof typeof en;

const en = {
  tab_chat: "Think",
  tab_map: "Map",
  tab_ideas: "Ideas",
  tab_settings: "Settings",
  chat_placeholder_ready: "Start anywhere",
  chat_placeholder_connecting: "Connecting…",
  chat_send_tip: "Send (Enter)",
  call_button_off: "Call mode — short answers, read aloud",
  call_button_on: "Call mode on — short answers, read aloud",
  voice_button_on: "Replies are read aloud — click to stop",
  voice_button_off: "Read replies aloud",
  queue_loading: "Loading…",
  queue_empty: "Nothing waiting.",
  queue_count: "{n} waiting to be read",
  back: "← Back",
  delete: "Delete",
  cancel: "Cancel",
} as const;

const pl: Partial<Record<Key, string>> = {
  tab_chat: "Myśl",
  tab_map: "Mapa",
  tab_ideas: "Pomysły",
  tab_settings: "Ustawienia",
  chat_placeholder_ready: "Zacznij od czegokolwiek",
  chat_placeholder_connecting: "Łączenie…",
  chat_send_tip: "Wyślij (Enter)",
  call_button_off: "Tryb rozmowy — krótkie odpowiedzi, czytane na głos",
  call_button_on: "Tryb rozmowy włączony — krótkie odpowiedzi, czytane na głos",
  voice_button_on: "Odpowiedzi są czytane na głos — kliknij, aby zatrzymać",
  voice_button_off: "Czytaj odpowiedzi na głos",
  queue_loading: "Wczytywanie…",
  queue_empty: "Nic nie czeka.",
  queue_count: "{n} czeka na przeczytanie",
  back: "← Wstecz",
  delete: "Usuń",
  cancel: "Anuluj",
};

const es: Partial<Record<Key, string>> = {
  tab_chat: "Pensar",
  tab_map: "Mapa",
  tab_ideas: "Ideas",
  tab_settings: "Ajustes",
  chat_placeholder_ready: "Empieza por donde quieras",
  chat_placeholder_connecting: "Conectando…",
  chat_send_tip: "Enviar (Intro)",
  call_button_off: "Modo llamada — respuestas breves, leídas en voz alta",
  call_button_on: "Modo llamada activado — respuestas breves, leídas en voz alta",
  voice_button_on: "Las respuestas se leen en voz alta — haz clic para detener",
  voice_button_off: "Leer las respuestas en voz alta",
  queue_loading: "Cargando…",
  queue_empty: "Nada pendiente.",
  queue_count: "{n} pendientes de leer",
  back: "← Atrás",
  delete: "Eliminar",
  cancel: "Cancelar",
};

const TABLES: Record<Exclude<Language, "auto">, Partial<Record<Key, string>>> = {
  english: en,
  polish: pl,
  spanish: es,
};

let current: Language = "auto";
const listeners = new Set<(lang: Language) => void>();

function setCurrent(lang: Language) {
  current = lang;
  for (const cb of listeners) cb(lang);
}

// Loaded once, at module scope, so every screen agrees on the language from
// the moment it mounts rather than flashing English until its own effect runs.
void getSettings()
  .then((s) => setCurrent(s.language))
  .catch(() => {});
void listen<{ language?: Language }>("settings:changed", (e) => {
  if (e.payload.language) setCurrent(e.payload.language);
});

/** The app's own text, in the language currently chosen. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const table = current === "auto" ? undefined : TABLES[current];
  let out = table?.[key] ?? en[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
  }
  return out;
}

/** Re-render whenever the app language changes. Call once per component. */
export function useLang(): Language {
  const [lang, setLang] = useState(current);
  useEffect(() => {
    setLang(current);
    listeners.add(setLang);
    return () => {
      listeners.delete(setLang);
    };
  }, []);
  return lang;
}
