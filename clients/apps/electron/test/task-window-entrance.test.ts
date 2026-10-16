import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const appDir = resolve(import.meta.dirname, "..");
const electronExecutable = resolve(appDir, "../../../node_modules/.bin/electron");
// Like the native backdrop test, this needs built artifacts: the backdrop addon
// (`build:native`) and the Main window renderer (`vite.renderer.config.ts`).
const addonPath = [
  process.env.COMMA_SIDE_CHAT_BACKDROP_PATH,
  resolve(
    appDir,
    "native/macos/SideChatBackdrop/build/Debug/comma_side_chat_backdrop.node"
  ),
  resolve(
    appDir,
    "native/macos/SideChatBackdrop/build/Release/comma_side_chat_backdrop.node"
  ),
  resolve(appDir, "dist/native/macos/comma-side-chat-backdrop.node"),
]
  .filter((candidate): candidate is string => Boolean(candidate))
  .find(existsSync);
const canRunRealEntrance =
  process.platform === "darwin" &&
  existsSync(electronExecutable) &&
  existsSync(resolve(appDir, ".vite/renderer/main_window/index.html")) &&
  addonPath !== undefined;

it.skipIf(!canRunRealEntrance)(
  "paints an opaque source before moving in real cold and repeated Electron windows",
  async () => {
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(
        electronExecutable,
        [resolve(import.meta.dirname, "fixtures/task-window-entrance.cjs")],
        { cwd: appDir, env: { ...env, COMMA_SIDE_CHAT_BACKDROP_PATH: addonPath } }
      );
      let capturedOutput = "";
      child.stdout.on("data", (chunk) => {
        capturedOutput += chunk;
      });
      child.stderr.on("data", (chunk) => {
        capturedOutput += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolveOutput(capturedOutput) : reject(new Error(capturedOutput))
      );
    });
    const line = output
      .split("\n")
      .find((entry) => entry.startsWith("TASK_ENTRANCE_RESULT="));
    expect(line, output).toBeDefined();
    const results = JSON.parse(line!.slice("TASK_ENTRANCE_RESULT=".length));
    for (const result of results) {
      expect(result.shownBeforeLoad).toBe(true);
      const frames = result.frames;
      expect(frames[0].expanded).toBe("false");
      expect(frames[0].opacity).toBe("1");
      expect(frames[0].rect.x).toBeCloseTo(40, 1);
      expect(frames[0].rect.y).toBeCloseTo(80, 1);
      expect(frames[0].rect.width).toBeCloseTo(120, 1);
      expect(frames[0].rect.height).toBeCloseTo(24, 1);
      expect(
        frames.filter(
          (f: { rect: { width: number } }) =>
            f.rect.width > 120.1 && f.rect.width < 559.9
        ).length
      ).toBeGreaterThanOrEqual(4);
      expect(
        frames.every(
          (f: { backdropTransform: string; hostTransform: string }) =>
            f.backdropTransform === "none" && f.hostTransform === "none"
        )
      ).toBe(true);
      const gaps = frames
        .slice(1)
        .map((f: { time: number }, i: number) => f.time - frames[i].time);
      console.log(
        "Task entrance frames:",
        frames.length,
        "maximum frame gap:",
        Math.max(...gaps)
      );
      expect(Math.max(...gaps)).toBeLessThan(80);
    }
  },
  30000
);
