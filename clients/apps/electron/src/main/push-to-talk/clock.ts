/** Time source of the push-to-talk turn, injected so tests control it. */
export interface PushToTalkClock {
  now(): number;
  /** Returns a function that cancels the timer. */
  setTimeout(callback: () => void, ms: number): () => void;
}

export const systemClock: PushToTalkClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
