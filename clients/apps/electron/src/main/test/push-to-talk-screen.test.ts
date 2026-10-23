import { describe, expect, it, vi } from "vitest";
import {
  maxUploadBytes,
  PushToTalkScreen,
  type CaptureDisplay,
  type CaptureImage,
  type ScreenCaptureDeps,
} from "../push-to-talk/screen-capture";

type Rect = { x: number; y: number; width: number; height: number };

/** A nativeImage stand-in that records crops and resizes as plain sizes. */
class FakeImage implements CaptureImage {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly ops: string[] = [],
    readonly pngBytes = 1_000
  ) {}
  getSize() {
    return { width: this.width, height: this.height };
  }
  isEmpty() {
    return this.width === 0 || this.height === 0;
  }
  resize(size: { width: number; height: number }) {
    this.ops.push(`resize ${size.width}x${size.height}`);
    return new FakeImage(size.width, size.height, this.ops, this.pngBytes);
  }
  crop(rect: Rect) {
    this.ops.push(`crop ${rect.x},${rect.y},${rect.width}x${rect.height}`);
    return new FakeImage(rect.width, rect.height, this.ops, this.pngBytes);
  }
  toPNG() {
    return Buffer.alloc(this.pngBytes);
  }
  toJPEG(quality: number) {
    this.ops.push(`jpeg ${quality}`);
    return Buffer.alloc(100);
  }
}

const primary: CaptureDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  scaleFactor: 1,
};
// A Retina display to the right of the primary one.
const secondary: CaptureDisplay = {
  id: 2,
  bounds: { x: 1440, y: 0, width: 1728, height: 1117 },
  scaleFactor: 2,
};

function deps(input: {
  cursor: { x: number; y: number };
  status?: string;
  pngBytes?: number;
}) {
  const ops: string[] = [];
  const getSources = vi.fn<ScreenCaptureDeps["getSources"]>(async () => [
    { display_id: "1", thumbnail: new FakeImage(1440, 900, ops, input.pngBytes) },
    { display_id: "2", thumbnail: new FakeImage(3456, 2234, ops, input.pngBytes) },
  ]);
  const value: ScreenCaptureDeps = {
    getCursorScreenPoint: () => input.cursor,
    getDisplayNearestPoint: (point) => (point.x >= 1440 ? secondary : primary),
    getSources,
    mediaAccessStatus: () => input.status ?? "granted",
  };
  return { value, ops, getSources };
}

describe("PushToTalkScreen", () => {
  it("captures the cursor's secondary 2x display and maps points to screenshot pixels", async () => {
    const { value, ops, getSources } = deps({ cursor: { x: 2000, y: 500 } });
    const screen = new PushToTalkScreen(value);
    const location = screen.locate();
    expect(location).toMatchObject({ displayId: 2, cursor: { x: 2000, y: 500 } });

    const capture = await screen.capture(location);
    expect(getSources).toHaveBeenCalledWith({
      types: ["screen"],
      thumbnailSize: { width: 3456, height: 2234 },
    });
    if (capture.status !== "captured") throw new Error(capture.status);
    const context = capture.finalize(null);

    // 3456 px reduced to 2560: every point scales by 2 x 2560/3456.
    expect(context).toMatchObject({ width: 2560, height: 1655 });
    expect(context.cursor).toEqual({ x: 830, y: 741 });
    expect(context.region).toBeUndefined();
    // The detail is 800x500 points around the cursor at full resolution.
    expect(ops).toContain("crop 320,500,1600x1000");
    expect(ops).toContain("resize 2560x1655");
    expect(context.images.map(({ name, mediaType }) => ({ name, mediaType }))).toEqual([
      { name: "screen.png", mediaType: "image/png" },
      { name: "detail.png", mediaType: "image/png" },
    ]);
  });

  it("clamps a region and the cursor detail to the display edges", async () => {
    const { value, ops } = deps({ cursor: { x: 1440 + 1720, y: 1110 } });
    const screen = new PushToTalkScreen(value);
    const capture = await screen.capture(screen.locate());
    if (capture.status !== "captured") throw new Error(capture.status);

    capture.finalize(null);
    // 800x500 points pushed back inside the 1728x1117 display.
    expect(ops).toContain("crop 1856,1234,1600x1000");

    ops.length = 0;
    const context = capture.finalize({ x: 1600, y: 1000, width: 400, height: 300 });
    expect(ops).toContain("crop 3200,2000,256x234");
    expect(context.region).toEqual({ x: 2370, y: 1481, width: 190, height: 173 });
  });

  it("keeps a full-display detail within the upload's 4096 px side", async () => {
    const { value, ops } = deps({ cursor: { x: 2000, y: 500 } });
    // A 6K display at 2x: its full-resolution detail is 6016 px wide.
    value.getDisplayNearestPoint = () => ({
      id: 2,
      bounds: { x: 1440, y: 0, width: 3008, height: 1692 },
      scaleFactor: 2,
    });
    value.getSources = async () => [
      { display_id: "2", thumbnail: new FakeImage(6016, 3384, ops) },
    ];
    const screen = new PushToTalkScreen(value);
    const capture = await screen.capture(screen.locate());
    if (capture.status !== "captured") throw new Error(capture.status);
    capture.finalize({ x: 0, y: 0, width: 3008, height: 1692 });
    expect(ops).toContain("crop 0,0,6016x3384");
    expect(ops).toContain("resize 4096x2304");
  });

  it.each(["denied", "restricted"])(
    "does not capture when Screen Recording is %s",
    async (status) => {
      const { value, getSources } = deps({ cursor: { x: 10, y: 10 }, status });
      const screen = new PushToTalkScreen(value);
      expect(await screen.capture(screen.locate())).toEqual({ status: "denied" });
      expect(getSources).not.toHaveBeenCalled();
    }
  );

  it("lets macOS ask for the permission when it was never decided", async () => {
    const { value, getSources } = deps({
      cursor: { x: 10, y: 10 },
      status: "not-determined",
    });
    const screen = new PushToTalkScreen(value);
    expect((await screen.capture(screen.locate())).status).toBe("captured");
    expect(getSources).toHaveBeenCalledOnce();
  });

  it("falls back to JPEG 85 when the PNG exceeds the 10 MB upload limit", async () => {
    const { value, ops } = deps({
      cursor: { x: 10, y: 10 },
      pngBytes: maxUploadBytes + 1,
    });
    const screen = new PushToTalkScreen(value);
    const capture = await screen.capture(screen.locate());
    if (capture.status !== "captured") throw new Error(capture.status);
    const context = capture.finalize(null);
    expect(ops.filter((op) => op === "jpeg 85")).toHaveLength(2);
    expect(context.images.map(({ name, mediaType }) => ({ name, mediaType }))).toEqual([
      { name: "screen.jpg", mediaType: "image/jpeg" },
      { name: "detail.jpg", mediaType: "image/jpeg" },
    ]);
    for (const image of context.images)
      expect(image.data.byteLength).toBeLessThanOrEqual(maxUploadBytes);
  });

  it("reports the screen unavailable when no source matches the display", async () => {
    const { value } = deps({ cursor: { x: 2000, y: 500 } });
    value.getSources = async () => [];
    const screen = new PushToTalkScreen(value);
    expect(await screen.capture(screen.locate())).toEqual({ status: "unavailable" });
  });
});
