import type { PushToTalkPoint, PushToTalkRect } from "./types";

// Screenshot of the cursor's display at the press (openspec
// add-push-to-talk-agent, D3). The group file upload accepts PNG or JPEG up
// to 10,000,000 bytes and 4096 px a side.

/** `comma/group_files.ex` @max_upload_bytes. */
export const maxUploadBytes = 10_000_000;
/** The longest side of the sent screenshot. */
export const maxScreenshotSide = 2560;
/** The longest side the upload accepts, which bounds the detail image. */
export const maxUploadSide = 4096;
/** The detail around the cursor when no area was marked, in points. */
export const cursorDetailSize = { width: 800, height: 500 };
const jpegQuality = 85;

/** The subset of Electron's `nativeImage` this module uses. */
export interface CaptureImage {
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
  resize(options: { width: number; height: number; quality?: "best" }): CaptureImage;
  crop(rect: PushToTalkRect): CaptureImage;
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
  region?: PushToTalkRect;
  /** The display screenshot, then the detail of the area or the cursor. */
  images: PushToTalkImage[];
};

export type PushToTalkScreenCaptureResult =
  | {
      status: "captured";
      /** Builds the images once the marked region (or none) is known. */
      finalize(region: PushToTalkRect | null): PushToTalkScreenContext;
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
      finalize: (region) => finalizeCapture(full, location, region),
    };
  }
}

function finalizeCapture(
  full: CaptureImage,
  location: PushToTalkCursorLocation,
  region: PushToTalkRect | null
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
  const area = region
    ? clampRect(region, bounds)
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
  const detail = fitSide(
    full.crop(scaleRect(area, pixelsPerPoint, size)),
    maxUploadSide
  );
  const sent = screenshot.getSize();
  return {
    width: sent.width,
    height: sent.height,
    cursor: {
      x: Math.round(cursor.x * sentScale),
      y: Math.round(cursor.y * sentScale),
    },
    ...(region ? { region: roundRect(scaleRect(area, sentScale)) } : {}),
    images: [encode(screenshot, "screen"), encode(detail, "detail")],
  };
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
