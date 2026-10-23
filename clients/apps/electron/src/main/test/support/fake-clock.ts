import type { PushToTalkClock } from "../../push-to-talk/clock";

/** A manual clock: timers fire only when a test advances it. */
export class FakeClock implements PushToTalkClock {
  #now = 0;
  #timers: { at: number; callback: () => void }[] = [];

  now() {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number) {
    const timer = { at: this.#now + ms, callback };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((entry) => entry !== timer);
    };
  }

  /** Moves time forward and fires the timers that came due, in order. */
  advance(ms: number) {
    const until = this.#now + ms;
    for (;;) {
      const next = this.#timers
        .filter((timer) => timer.at <= until)
        .toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((timer) => timer !== next);
      this.#now = next.at;
      next.callback();
    }
    this.#now = until;
  }

  pending() {
    return this.#timers.length;
  }
}
