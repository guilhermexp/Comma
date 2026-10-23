import { pushToTalkStrokeColor } from "@comma/native-bridge";
import type { PushToTalkPoint, PushToTalkRect, PushToTalkStroke } from "./types";

// Screenshot of the cursor's display at the press (openspec
// add-push-to-talk-agent, D3). The group file upload accepts PNG or JPEG up
// to 10,000,000 bytes and 4096 px a side.

/** `comma/group_files.ex` @max_upload_bytes. */
export const maxUploadBytes = 10_000_000;
/** The longest side of the sent screenshot. */
export const maxScreenshotSide = 2560;
/** The longest side the upload accepts, which bounds the detail image. */
export const maxUploadSide = 4096;
/** The detail around the cursor when no stroke was drawn, in points. */
export const cursorDetailSize = { width: 800, height: 500 };
/** The margin around the stroke's box in the detail, per side. */
export const strokeMargin = 0.1;
/** The stroke's line width in pixels of the sent screenshot. */
export const strokeWidth = 6;
/** The stroke's color, the cursor companion's blue the overlay draws with. */
export const strokeColor = {
  red: Number.parseInt(pushToTalkStrokeColor.slice(1, 3), 16),
  green: Number.parseInt(pushToTalkStrokeColor.slice(3, 5), 16),
  blue: Number.parseInt(pushToTalkStrokeColor.slice(5, 7), 16),
};
const jpegQuality = 85;

/** The subset of Electron's `nativeImage` this module uses. */
export interface CaptureImage {
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
  resize(options: { width: number; height: number; quality?: "best" }): CaptureImage;
  crop(rect: PushToTalkRect): CaptureImage;
  /** BGRA pixels on macOS, rows top to bottom. */
  toBitmap(): Buffer;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}

/** The subset of an Electron `Display` this module uses. */
export type CaptureDisplay = {
  id: number;
  bounds: PushToTalkRect;
  scaleFactor: number;
};

export interface ScreenCaptureDeps {
  getCursorScreenPoint(): PushToTalkPoint;
  getDisplayNearestPoint(point: PushToTalkPoint): CaptureDisplay;
  getSources(options: {
    types: ["screen"];
    thumbnailSize: { width: number; height: number };
  }): Promise<{ display_id: string; thumbnail: CaptureImage }[]>;
  /** `systemPreferences.getMediaAccessStatus("screen")`. */
  mediaAccessStatus(): string;
  /** `nativeImage.createFromBitmap`. */
  createFromBitmap(
    bitmap: Buffer,
    size: { width: number; height: number }
  ): CaptureImage;
}

/** Where the cursor was at the press, in Electron screen points. */
export type PushToTalkCursorLocation = {
  displayId: number;
  cursor: PushToTalkPoint;
  bounds: PushToTalkRect;
  scaleFactor: number;
};

export type PushToTalkImage = {
  name: string;
  mediaType: "image/png" | "image/jpeg";
  data: Buffer;
};

/** What the turn sends: images plus coordinates in the screenshot's pixels. */
export type PushToTalkScreenContext = {
  width: number;
  height: number;
  cursor: PushToTalkPoint;
  /** The box of the drawn stroke, cut at the display's edges. */
  strokeBounds?: PushToTalkRect;
  /** The display screenshot, then the detail of the stroke or the cursor. */
  images: PushToTalkImage[];
};

export type PushToTalkScreenCaptureResult =
  | {
      status: "captured";
      /**
       * Builds the images once the stroke is known. A stroke without extent
       * (none, empty or one point) gives the detail around the cursor.
       */
      finalize(stroke: PushToTalkStroke | null): PushToTalkScreenContext;
    }
  // Screen Recording is denied or restricted for Comma.
  | { status: "denied" }
  // The capture produced no image of the cursor's display.
  | { status: "unavailable" };

export class PushToTalkScreen {
  readonly #deps: ScreenCaptureDeps;

  constructor(deps: ScreenCaptureDeps) {
    this.#deps = deps;
  }

  locate(): PushToTalkCursorLocation {
    const cursor = this.#deps.getCursorScreenPoint();
    const display = this.#deps.getDisplayNearestPoint(cursor);
    return {
      displayId: display.id,
      cursor,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    };
  }

  /**
   * Takes the screenshot of the located display. `not-determined` lets the
   * capture raise the macOS prompt; `denied` and `restricted` capture nothing.
   */
  async capture(
    location: PushToTalkCursorLocation
  ): Promise<PushToTalkScreenCaptureResult> {
    const status = this.#deps.mediaAccessStatus();
    if (status === "denied" || status === "restricted") return { status: "denied" };
    const { bounds, scaleFactor } = location;
    const sources = await this.#deps.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(bounds.width * scaleFactor),
        height: Math.round(bounds.height * scaleFactor),
      },
    });
    const source = sources.find(
      (candidate) => candidate.display_id === String(location.displayId)
    );
    if (!source || source.thumbnail.isEmpty()) return { status: "unavailable" };
    const full = source.thumbnail;
    return {
      status: "captured",
      finalize: (stroke) =>
        finalizeCapture(full, location, stroke, this.#deps.createFromBitmap),
    };
  }
}

function finalizeCapture(
  full: CaptureImage,
  location: PushToTalkCursorLocation,
  stroke: PushToTalkStroke | null,
  createFromBitmap: ScreenCaptureDeps["createFromBitmap"]
): PushToTalkScreenContext {
  const { bounds } = location;
  const size = full.getSize();
  // Pixels of the captured image per point; the thumbnail may differ from
  // the requested size.
  const pixelsPerPoint = size.width / bounds.width;
  const reduction = Math.min(1, maxScreenshotSide / Math.max(size.width, size.height));
  const sentScale = pixelsPerPoint * reduction;

  const cursor = {
    x: location.cursor.x - bounds.x,
    y: location.cursor.y - bounds.y,
  };
  const box = stroke ? strokeBox(stroke) : null;
  const strokeBounds = box ? clampRect(box, bounds) : null;
  const margin = box ? strokeMargin * Math.max(box.width, box.height) : 0;
  const area = box
    ? clampRect(
        {
          x: box.x - margin,
          y: box.y - margin,
          width: box.width + 2 * margin,
          height: box.height + 2 * margin,
        },
        bounds
      )
    : clampRect(
        {
          x: cursor.x - cursorDetailSize.width / 2,
          y: cursor.y - cursorDetailSize.height / 2,
          ...cursorDetailSize,
        },
        bounds,
        { shift: true }
      );

  const screenshot =
    reduction < 1
      ? full.resize({
          width: Math.round(size.width * reduction),
          height: Math.round(size.height * reduction),
          quality: "best",
        })
      : full;
  const crop = scaleRect(area, pixelsPerPoint, size);
  const detail = fitSide(full.crop(crop), maxUploadSide);
  const sent = screenshot.getSize();
  // Pixels of the detail per pixel of the full-resolution crop.
  const detailScale = detail.getSize().width / crop.width;
  const drawn =
    stroke && box
      ? {
          screenshot: drawStroke(screenshot, stroke, createFromBitmap, {
            origin: { x: 0, y: 0 },
            scale: sentScale,
            width: strokeWidth,
          }),
          detail: drawStroke(detail, stroke, createFromBitmap, {
            origin: { x: crop.x * detailScale, y: crop.y * detailScale },
            scale: pixelsPerPoint * detailScale,
            width: (strokeWidth * pixelsPerPoint * detailScale) / sentScale,
          }),
        }
      : { screenshot, detail };
  return {
    width: sent.width,
    height: sent.height,
    cursor: {
      x: Math.round(cursor.x * sentScale),
      y: Math.round(cursor.y * sentScale),
    },
    ...(strokeBounds ? { strokeBounds: scaleRect(strokeBounds, sentScale) } : {}),
    images: [encode(drawn.screenshot, "screen"), encode(drawn.detail, "detail")],
  };
}

/** The box of a stroke in points; `null` when it has no extent. */
export function strokeBox(stroke: PushToTalkStroke): PushToTalkRect | null {
  if (stroke.length < 2) return null;
  const xs = stroke.map((point) => point.x);
  const ys = stroke.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  if (width === 0 && height === 0) return null;
  return { x, y, width, height };
}

/**
 * Draws the stroke as an antialiased polyline over a copy of the image.
 * Display points map to image pixels as `point × scale − origin`.
 */
function drawStroke(
  image: CaptureImage,
  stroke: PushToTalkStroke,
  createFromBitmap: ScreenCaptureDeps["createFromBitmap"],
  transform: { origin: PushToTalkPoint; scale: number; width: number }
): CaptureImage {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const stride = bitmap.length / size.height;
  const points = stroke.map((point) => ({
    x: point.x * transform.scale - transform.origin.x,
    y: point.y * transform.scale - transform.origin.y,
  }));
  const radius = transform.width / 2;
  const reach = radius + 1;
  const minX = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x)) - reach));
  const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y)) - reach));
  const maxX = Math.min(
    size.width - 1,
    Math.ceil(Math.max(...points.map((p) => p.x)) + reach)
  );
  const maxY = Math.min(
    size.height - 1,
    Math.ceil(Math.max(...points.map((p) => p.y)) + reach)
  );
  if (minX > maxX || minY > maxY) return image;

  // Coverage of each pixel in the stroke's box; the maximum over segments
  // keeps the joints from blending twice.
  const coverageWidth = maxX - minX + 1;
  const coverage = new Float32Array(coverageWidth * (maxY - minY + 1));
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const fromX = Math.max(minX, Math.floor(Math.min(a.x, b.x) - reach));
    const toX = Math.min(maxX, Math.ceil(Math.max(a.x, b.x) + reach));
    const fromY = Math.max(minY, Math.floor(Math.min(a.y, b.y) - reach));
    const toY = Math.min(maxY, Math.ceil(Math.max(a.y, b.y) + reach));
    for (let y = fromY; y <= toY; y++) {
      for (let x = fromX; x <= toX; x++) {
        // Distance from the pixel's center to the segment.
        const px = x + 0.5 - a.x;
        const py = y + 0.5 - a.y;
        const t =
          lengthSquared === 0
            ? 0
            : Math.min(1, Math.max(0, (px * dx + py * dy) / lengthSquared));
        const distance = Math.hypot(px - t * dx, py - t * dy);
        const value = Math.min(1, Math.max(0, radius + 0.5 - distance));
        const cell = (y - minY) * coverageWidth + (x - minX);
        if (value > coverage[cell]!) coverage[cell] = value;
      }
    }
  }

  const color = [strokeColor.blue, strokeColor.green, strokeColor.red];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const alpha = coverage[(y - minY) * coverageWidth + (x - minX)]!;
      if (alpha === 0) continue;
      const offset = y * stride + x * 4;
      for (let channel = 0; channel < 3; channel++)
        bitmap[offset + channel] = Math.round(
          bitmap[offset + channel]! * (1 - alpha) + color[channel]! * alpha
        );
      bitmap[offset + 3] = Math.round(bitmap[offset + 3]! * (1 - alpha) + 255 * alpha);
    }
  }
  return createFromBitmap(bitmap, size);
}

/**
 * Keeps a display-relative rect inside the display. `shift` moves it back
 * inside, keeping its size; otherwise it is cut at the edges.
 */
function clampRect(
  rect: PushToTalkRect,
  bounds: PushToTalkRect,
  options: { shift?: boolean } = {}
): PushToTalkRect {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  if (options.shift) {
    return {
      x: Math.min(Math.max(rect.x, 0), bounds.width - width),
      y: Math.min(Math.max(rect.y, 0), bounds.height - height),
      width,
      height,
    };
  }
  const x = Math.min(Math.max(rect.x, 0), bounds.width);
  const y = Math.min(Math.max(rect.y, 0), bounds.height);
  return {
    x,
    y,
    width: Math.max(1, Math.min(rect.x + rect.width, bounds.width) - x),
    height: Math.max(1, Math.min(rect.y + rect.height, bounds.height) - y),
  };
}

function scaleRect(
  rect: PushToTalkRect,
  scale: number,
  limit?: { width: number; height: number }
): PushToTalkRect {
  const scaled = roundRect({
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  });
  if (!limit) return scaled;
  const x = Math.min(scaled.x, limit.width - 1);
  const y = Math.min(scaled.y, limit.height - 1);
  return {
    x,
    y,
    width: Math.max(1, Math.min(scaled.width, limit.width - x)),
    height: Math.max(1, Math.min(scaled.height, limit.height - y)),
  };
}

function roundRect(rect: PushToTalkRect): PushToTalkRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function fitSide(image: CaptureImage, side: number) {
  const { width, height } = image.getSize();
  const scale = side / Math.max(width, height);
  if (scale >= 1) return image;
  return image.resize({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    quality: "best",
  });
}

/** PNG when it fits the upload, otherwise JPEG 85. */
function encode(image: CaptureImage, name: string): PushToTalkImage {
  const png = image.toPNG();
  if (png.byteLength <= maxUploadBytes)
    return { name: `${name}.png`, mediaType: "image/png", data: png };
  const jpeg = image.toJPEG(jpegQuality);
  if (jpeg.byteLength > maxUploadBytes)
    throw new Error(`The ${name} image exceeds the upload limit.`);
  return { name: `${name}.jpg`, mediaType: "image/jpeg", data: jpeg };
}
