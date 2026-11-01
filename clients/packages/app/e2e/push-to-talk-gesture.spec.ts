import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import ts from "typescript";
import type { openPushToTalkPeer } from "../src/components/push-to-talk/pushToTalkPeer";

// Execute the production peer without starting the app, a backend or a microphone device.
const peerScript = ts.transpileModule(
  readFileSync(
    new URL("../src/components/push-to-talk/pushToTalkPeer.ts", import.meta.url),
    "utf8"
  ),
  {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }
).outputText;

test("a cold shortcut sends its buffered speech after admission but a short warm tap sends nothing", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.setContent("<button>Start audio loopback</button>");
  await page.getByRole("button", { name: "Start audio loopback" }).click();
  await page.addScriptTag({
    content: `{ const exports = {}; ${peerScript}\nwindow.openPttPeer = exports.openPushToTalkPeer; }`,
  });
  const observed = await page.evaluate(async () => {
    const openPeer = (
      window as typeof window & { openPttPeer: typeof openPushToTalkPeer }
    ).openPttPeer;
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Playwright serializes this browser callback without outer functions.
    const delay = (ms: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    };
    const micContext = new AudioContext();
    const oscillator = micContext.createOscillator();
    oscillator.frequency.value = 440;
    const gain = micContext.createGain();
    gain.gain.value = 0.3;
    const mic = micContext.createMediaStreamDestination();
    oscillator.connect(gain).connect(mic);
    oscillator.start();
    await micContext.resume();

    const receiver = new RTCPeerConnection();
    const receiveContext = new AudioContext();
    await receiveContext.resume();
    const analyser = receiveContext.createAnalyser();
    analyser.fftSize = 4096;
    const silentSink = receiveContext.createGain();
    silentSink.gain.value = 0;
    analyser.connect(silentSink).connect(receiveContext.destination);
    // HTMLMediaElement activates the remote WebRTC playout/decoder in Chromium.
    const receiveAudio = new Audio();
    receiveAudio.volume = 0;
    receiver.ontrack = (event) => {
      receiveAudio.srcObject = event.streams[0]!;
      void receiveAudio.play();
      receiveContext.createMediaStreamSource(event.streams[0]!).connect(analyser);
    };
    const { promise: offerGate, resolve: releaseOffer } = Promise.withResolvers<void>();
    let connected = false;
    let peerCount = 0;
    const audio = new Audio();
    audio.volume = 0;
    const peer = openPeer({
      listening: true,
      admitted: false,
      contextId: 1,
      qualified: false,
      deps: {
        createPeer: () => {
          peerCount++;
          return new RTCPeerConnection();
        },
        createAudioContext: () => new AudioContext(),
        createAudio: () => audio,
        getUserMedia: async () => mic.stream,
      },
      report: (event) => {
        if (event === "connected") connected = true;
      },
      offer: async (sdp) => {
        await offerGate;
        await receiver.setRemoteDescription({ type: "offer", sdp });
        await receiver.setLocalDescription(await receiver.createAnswer());
        if (receiver.iceGatheringState !== "complete") {
          const { promise, resolve } = Promise.withResolvers<void>();
          const timer = setTimeout(finish, 5_000);
          function finish() {
            clearTimeout(timer);
            receiver.removeEventListener("icegatheringstatechange", check);
            resolve();
          }
          function check() {
            if (receiver.iceGatheringState === "complete") finish();
          }
          receiver.addEventListener("icegatheringstatechange", check);
          check();
          await promise;
        }
        return { sdp: receiver.localDescription!.sdp };
      },
    });
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    const peak = () => {
      analyser.getFloatFrequencyData(spectrum);
      let index = 0;
      for (let i = 1; i < spectrum.length; i++)
        if (spectrum[i]! > spectrum[index]!) index = i;
      return spectrum[index]! > -60
        ? (index * receiveContext.sampleRate) / analyser.fftSize
        : 0;
    };
    const sampleFor = async (milliseconds: number) => {
      const peaks: number[] = [];
      const end = performance.now() + milliseconds;
      while (performance.now() < end) {
        await delay(25);
        peaks.push(peak());
      }
      return peaks;
    };
    try {
      const mutedOnPress = audio.muted;
      await delay(450);
      peer.update({ listening: false, qualified: true });
      const restoredWithoutCaption = !audio.muted;
      const micMutedAfterRelease = !mic.stream.getAudioTracks()[0]!.enabled;
      // If the first gesture were lost, this later input could not reproduce its 440 Hz prefix.
      oscillator.frequency.value = 880;
      releaseOffer();
      for (let i = 0; i < 200; i++) {
        if (connected) break;
        await delay(25);
      }
      const beforeAdmission = peak();
      peer.update({ admitted: true });
      const coldPeaks = await sampleFor(1_500);
      await delay(300);

      oscillator.frequency.value = 2200;
      peer.update({ contextId: 2, qualified: false, admitted: true, listening: true });
      const mutedOnWarmPress = audio.muted;
      await delay(180);
      peer.update({ listening: false });
      const restoredOnWarmRelease = !audio.muted;
      const shortTapPeaks = await sampleFor(1_000);
      return {
        connected,
        mutedOnPress,
        restoredWithoutCaption,
        micMutedAfterRelease,
        beforeAdmission,
        coldPeaks,
        mutedOnWarmPress,
        restoredOnWarmRelease,
        shortTapPeaks,
        peerCount,
      };
    } finally {
      releaseOffer();
      peer.close();
      receiver.close();
      receiveAudio.pause();
      receiveAudio.srcObject = null;
      oscillator.stop();
      await micContext.close();
      await receiveContext.close();
    }
  });
  expect(observed.connected).toBe(true);
  expect(observed.beforeAdmission).toBe(0);
  expect(observed.coldPeaks.some((hz) => Math.abs(hz - 440) < 30)).toBe(true);
  expect(observed.shortTapPeaks.some((hz) => Math.abs(hz - 2200) < 40)).toBe(false);
  expect(observed.mutedOnPress).toBe(true);
  expect(observed.mutedOnWarmPress).toBe(true);
  expect(observed.restoredWithoutCaption).toBe(true);
  expect(observed.restoredOnWarmRelease).toBe(true);
  expect(observed.micMutedAfterRelease).toBe(true);
  expect(observed.peerCount).toBe(1);
});
