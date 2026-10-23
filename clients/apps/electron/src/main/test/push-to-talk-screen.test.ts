import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { PushToTalkStroke } from "../push-to-talk/types";
import {
  maxUploadBytes,
  PushToTalkScreen,
  strokeColor,
  type CaptureDisplay,
  type CaptureImage,
  type ScreenCaptureDeps,
} from "../push-to-talk/screen-capture";

type Rect = { x: number; y: number; width: number; height: number };

// The captured screen's color in the fake bitmaps (BGRA).
const background = [0x20, 0x20, 0x20, 0xff];

/**
 * A nativeImage stand-in that records crops and resizes as plain sizes. Its
 * bitmap is a flat background until a drawn bitmap replaces it; the "PNG" of
 * a drawn image is its size and deflated BGRA bitmap.
 */
class FakeImage implements CaptureImage {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly ops: string[] = [],
    readonly pngBytes = 1_000,
    readonly bitmap?: Buffer
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
  toBitmap() {
    this.ops.push(`bitmap ${this.width}x${this.height}`);
    const bitmap = Buffer.alloc(this.width * this.height * 4);
    for (let offset = 0; offset < bitmap.length; offset += 4)
      bitmap.set(background, offset);
    return bitmap;
  }
  toPNG() {
    if (!this.bitmap) return Buffer.alloc(this.pngBytes);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(this.width, 0);
    header.writeUInt32LE(this.height, 4);
    return Buffer.concat([header, deflateSync(this.bitmap)]);
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
    createFromBitmap: (bitmap, size) =>
      new FakeImage(size.width, size.height, ops, input.pngBytes, bitmap),
  };
  return { value, ops, getSources };
}

/** Reads a pixel (BGRA) of a drawn fake image. */
function pixel(data: Buffer, point: { x: number; y: number }) {
  const width = data.readUInt32LE(0);
  const bitmap = inflateSync(data.subarray(8));
  const offset = (Math.round(point.y) * width + Math.round(point.x)) * 4;
  return [...bitmap.subarray(offset, offset + 4)];
}

function imageSize(data: Buffer) {
  return { width: data.readUInt32LE(0), height: data.readUInt32LE(4) };
}

const strokeBGRA = [strokeColor.blue, strokeColor.green, strokeColor.red, 0xff];

/** A closed circle in display points, starting at its rightmost point. */
function circle(center: { x: number; y: number }, radius: number): PushToTalkStroke {
  return Array.from({ length: 65 }, (_, index) => {
    const angle = (index / 64) * 2 * Math.PI;
    return {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    };
  });
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
    expect(context.strokeBounds).toBeUndefined();
    // The detail is 800x500 points around the cursor at full resolution.
    expect(ops).toContain("crop 320,500,1600x1000");
    expect(ops).toContain("resize 2560x1655");
    expect(context.images.map(({ name, mediaType }) => ({ name, mediaType }))).toEqual([
      { name: "screen.png", mediaType: "image/png" },
      { name: "detail.png", mediaType: "image/png" },
    ]);
  });

  it("crops a stroke on a 2x secondary display with a 10% margin and reports its bounds", async () => {
    const { value, ops } = deps({ cursor: { x: 2000, y: 500 } });
    const screen = new PushToTalkScreen(value);
    const capture = await screen.capture(screen.locate());
    if (capture.status !== "captured") throw new Error(capture.status);
    // A circle of 100 points around (400, 300) of the display: its box is
    // 300,200 200x200 pt, and 20 pt of margin make the detail 280,180 240x240.
    const context = capture.finalize(circle({ x: 400, y: 300 }, 100));
    expect(ops).toContain("crop 560,360,480x480");
    // In screenshot pixels: points x 2 x 2560/3456.
    expect(context.strokeBounds).toEqual({ x: 444, y: 296, width: 296, height: 296 });
  });

  it("draws the stroke over the screenshot and the detail", async () => {
    const { value } = deps({ cursor: { x: 2000, y: 500 } });
    const screen = new PushToTalkScreen(value);
    const capture = await screen.capture(screen.locate());
    if (capture.status !== "captured") throw new Error(capture.status);
    const stroke = circle({ x: 400, y: 300 }, 100);
    const [shot, detail] = capture.finalize(stroke).images;
    if (!shot || !detail) throw new Error("missing images");
    expect(imageSize(shot.data)).toEqual({ width: 2560, height: 1655 });
    expect(imageSize(detail.data)).toEqual({ width: 480, height: 480 });

    const sentScale = (2 * 2560) / 3456;
    for (const point of stroke.filter((_, index) => index % 8 === 0)) {
      // The screenshot maps points by its scale; the detail by 2 px per point
      // from the crop's origin at 280,180 pt.
      expect(
        pixel(shot.data, { x: point.x * sentScale, y: point.y * sentScale })
      ).toEqual(strokeBGRA);
      expect(
        pixel(detail.data, { x: (point.x - 280) * 2, y: (point.y - 180) * 2 })
      ).toEqual(strokeBGRA);
    }
    // The inside of the circle keeps the screen.
    expect(pixel(shot.data, { x: 400 * sentScale, y: 300 * sentScale })).toEqual(
      background
    );
    expect(pixel(detail.data, { x: 240, y: 240 })).toEqual(background);
  });

  it("clamps a stroke and the cursor detail to the display edges", async () => {
    const { value, ops } = deps({ cursor: { x: 1440 + 1720, y: 1110 } });
    const screen = new PushToTalkScreen(value);
    const capture = await screen.capture(screen.locate());
    if (capture.status !== "captured") throw new Error(capture.status);

    capture.finalize(null);
    // 800x500 points pushed back inside the 1728x1117 display.
    expect(ops).toContain("crop 1856,1234,1600x1000");

    ops.length = 0;
    // A box of 1600,1000 120x110 pt; its 12 pt margin is cut at 1728x1117.
    const context = capture.finalize([
      { x: 1600, y: 1000 },
      { x: 1720, y: 1000 },
      { x: 1720, y: 1110 },
      { x: 1600, y: 1110 },
      { x: 1600, y: 1000 },
    ]);
    expect(ops).toContain("crop 3176,1976,280x258");
    expect(context.strokeBounds).toEqual({ x: 2370, y: 1481, width: 178, height: 163 });
  });

  it.each([
    ["an empty stroke", []],
    ["a one-point stroke", [{ x: 400, y: 300 }]],
  ])("uses the cursor detail and draws nothing for %s", async (_, stroke) => {
    const { value, ops } = deps({ cursor: { x: 2000, y: 500 } });
    const screen = new PushToTalkScreen(value);
    const capture = await screen.capture(screen.locate());
    if (capture.status !== "captured") throw new Error(capture.status);
    const context = capture.finalize(stroke);
    expect(ops).toContain("crop 320,500,1600x1000");
    expect(ops.some((op) => op.startsWith("bitmap"))).toBe(false);
    expect(context.strokeBounds).toBeUndefined();
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
    capture.finalize([
      { x: 0, y: 0 },
      { x: 3008, y: 1692 },
    ]);
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
