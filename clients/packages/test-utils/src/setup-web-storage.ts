/**
 * Node 25+ defines its own `localStorage` and `sessionStorage` globals (without
 * `--localstorage-file`, they are unusable). Vitest's jsdom environment copies
 * only window keys the global does not already have, so these keep Node's
 * values. Point both at the jsdom window's storage, the instances that
 * `Storage.prototype` and `storage` events belong to. Outside jsdom this does
 * nothing.
 */
const domWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;

if (domWindow) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      get: () => domWindow[key],
    });
  }
}
