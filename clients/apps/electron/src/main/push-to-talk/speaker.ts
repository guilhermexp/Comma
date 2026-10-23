import { spawn as nodeSpawn } from "node:child_process";

/** The subset of a child process the speaker drives. */
export interface SpeakerProcess {
  stdin: { end(text: string): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface PushToTalkSpeaker {
  /** Resolves when the voice ends: finished, stopped or failed. */
  speak(text: string): Promise<void>;
  stop(): void;
}

const sayPath = "/usr/bin/say";

/**
 * Reads reply sentences with the system voice (`/usr/bin/say`, D7). The text
 * goes on stdin, never argv. One voice at a time: a new sentence or `stop()`
 * kills the running one.
 */
export class SaySpeaker implements PushToTalkSpeaker {
  readonly #spawn: (command: string, args: string[]) => SpeakerProcess;
  #child: SpeakerProcess | undefined;

  constructor(
    options: { spawn?: (command: string, args: string[]) => SpeakerProcess } = {}
  ) {
    this.#spawn =
      options.spawn ??
      ((command, args) =>
        nodeSpawn(command, args, { stdio: ["pipe", "ignore", "ignore"] }));
  }

  speak(text: string) {
    this.stop();
    const child = this.#spawn(sayPath, []);
    this.#child = child;
    return new Promise<void>((resolve) => {
      const forget = () => {
        if (this.#child === child) this.#child = undefined;
        resolve();
      };
      child.once("exit", forget);
      child.once("error", forget);
      child.stdin?.end(text);
    });
  }

  speaking() {
    return this.#child !== undefined;
  }

  stop() {
    const child = this.#child;
    this.#child = undefined;
    child?.kill("SIGTERM");
  }
}
