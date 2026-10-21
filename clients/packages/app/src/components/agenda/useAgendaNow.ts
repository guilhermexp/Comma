import { useSyncExternalStore } from "react";

// One clock for every Agenda view: it ticks on the minute boundary, sleeps
// while the window is hidden, and catches up on focus.

let now = new Date();
let timeout: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function schedule() {
  clearTimeout(timeout);
  timeout = undefined;
  if (listeners.size === 0 || document.visibilityState === "hidden") return;
  const remainder = Date.now() % 60_000;
  timeout = setTimeout(tick, remainder === 0 ? 60_000 : 60_000 - remainder);
}

function tick() {
  now = new Date();
  listeners.forEach((listener) => listener());
  schedule();
}

function onVisibility() {
  if (document.visibilityState === "visible") tick();
  else schedule();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisibility);
  }
  listeners.add(listener);
  tick();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    schedule();
    window.removeEventListener("focus", tick);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

const snapshot = () => now;

export function useAgendaNow() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
