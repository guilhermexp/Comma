import { describe, expect, it, vi } from "vitest";
import {
  allowedRendererOrigins,
  installSessionSecurity,
  installWindowSecurity,
  isAllowedUrl,
} from "../security";

describe("Electron security guards", () => {
  it("allows only packaged and configured dev renderer navigation origins", () => {
    const origins = new Set(allowedRendererOrigins("http://127.0.0.1:5173/some/path"));

    expect(isAllowedUrl("assets://./", origins)).toBe(true);
    expect(isAllowedUrl("assets://./settings", origins)).toBe(true);
    expect(isAllowedUrl("http://127.0.0.1:5173/app", origins)).toBe(true);
    expect(isAllowedUrl("https://example.com/phish", origins)).toBe(false);
  });

  it("denies window-open by default and blocks unallowlisted navigation", () => {
    const on = vi.fn();
    const setWindowOpenHandler = vi.fn();
    const logger = { warn: vi.fn() };

    installWindowSecurity({
      logger,
      webContents: { on, setWindowOpenHandler },
    });

    const openHandler = setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
      url: string;
    }) => { action: "allow" | "deny" };
    const navigateHandler = on.mock.calls[0]?.[1] as (
      event: { preventDefault: () => void },
      url: string
    ) => void;
    const preventDefault = vi.fn();

    expect(openHandler({ url: "https://example.com" })).toEqual({
      action: "deny",
    });
    navigateHandler({ preventDefault }, "https://example.com");

    expect(on).toHaveBeenCalledWith("will-navigate", expect.any(Function));
    expect(preventDefault).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("Blocked renderer window-open request.", {
      url: "https://example.com",
    });
  });

  it("denies session permission requests and synchronous checks by default", () => {
    const setPermissionCheckHandler = vi.fn();
    const setPermissionRequestHandler = vi.fn();

    installSessionSecurity({ setPermissionCheckHandler, setPermissionRequestHandler });

    const requestHandler = setPermissionRequestHandler.mock.calls[0]?.[0] as (
      webContents: unknown,
      permission: string,
      callback: (permissionGranted: boolean) => void
    ) => void;
    const checkHandler = setPermissionCheckHandler.mock.calls[0]?.[0] as (
      webContents: unknown,
      permission: string
    ) => boolean;
    const callback = vi.fn();

    requestHandler({}, "media", callback);

    expect(callback).toHaveBeenCalledWith(false);
    expect(checkHandler({}, "media")).toBe(false);
  });

  it("grants only microphone requests from the main renderer and rechecks after OS consent", async () => {
    const setPermissionCheckHandler = vi.fn();
    const setPermissionRequestHandler = vi.fn();
    const contents = { getURL: vi.fn(() => "http://localhost:5173/") };
    const requestSystemAccess = vi.fn(async () => true);
    installSessionSecurity(
      { setPermissionCheckHandler, setPermissionRequestHandler },
      {
        allowedOrigins: ["http://localhost:5173"],
        getMainWebContents: () => contents as never,
        requestSystemAccess,
      }
    );
    const check = setPermissionCheckHandler.mock.calls[0]![0];
    const request = setPermissionRequestHandler.mock.calls[0]![0];
    const details = {
      isMainFrame: true,
      requestingUrl: "http://localhost:5173/",
      mediaTypes: ["audio"],
    };
    const callback = vi.fn();
    request(contents, "media", callback, details);
    await Promise.resolve();
    expect(callback).toHaveBeenCalledWith(true);
    expect(
      check(contents, "media", "http://localhost:5173", {
        ...details,
        mediaType: "audio",
      })
    ).toBe(true);
    for (const [target, permission, data] of [
      [contents, "media", { ...details, mediaTypes: ["video"] }],
      [contents, "media", { ...details, isMainFrame: false }],
      [contents, "media", { ...details, requestingUrl: "https://evil.example" }],
      [{ getURL: contents.getURL }, "media", details],
      [contents, "geolocation", details],
    ]) {
      callback.mockClear();
      request(target, permission, callback, data);
      expect(callback).toHaveBeenCalledWith(false);
    }
    callback.mockClear();
    request(contents, "media", callback, details);
    contents.getURL.mockReturnValue("https://evil.example");
    await Promise.resolve();
    expect(callback).toHaveBeenCalledWith(false);
  });

  it("grants microphone requests from the voice renderer even when main renderer is closed", async () => {
    const setPermissionCheckHandler = vi.fn();
    const setPermissionRequestHandler = vi.fn();
    const voiceContents = {
      getURL: vi.fn(() => "http://localhost:5173/push-to-talk-voice"),
    };
    const requestSystemAccess = vi.fn(async () => true);
    installSessionSecurity(
      { setPermissionCheckHandler, setPermissionRequestHandler },
      {
        allowedOrigins: ["http://localhost:5173"],
        getMainWebContents: () => undefined,
        getVoiceWebContents: () => voiceContents as never,
        requestSystemAccess,
      }
    );
    const check = setPermissionCheckHandler.mock.calls[0]![0];
    const request = setPermissionRequestHandler.mock.calls[0]![0];
    const details = {
      isMainFrame: true,
      requestingUrl: "http://localhost:5173/push-to-talk-voice",
      mediaTypes: ["audio"],
    };
    const callback = vi.fn();
    request(voiceContents, "media", callback, details);
    await Promise.resolve();
    expect(callback).toHaveBeenCalledWith(true);
    expect(
      check(voiceContents, "media", "http://localhost:5173", {
        ...details,
        mediaType: "audio",
      })
    ).toBe(true);

    // Denies video
    callback.mockClear();
    request(voiceContents, "media", callback, {
      ...details,
      mediaTypes: ["video"],
    });
    expect(callback).toHaveBeenCalledWith(false);

    // Denies subframe
    callback.mockClear();
    request(voiceContents, "media", callback, {
      ...details,
      isMainFrame: false,
    });
    expect(callback).toHaveBeenCalledWith(false);

    // Denies foreign requesting URL
    callback.mockClear();
    request(voiceContents, "media", callback, {
      ...details,
      requestingUrl: "https://evil.example",
    });
    expect(callback).toHaveBeenCalledWith(false);

    // Denies unknown target webContents (neither main nor voice)
    callback.mockClear();
    const unknownContents = {
      getURL: () => "http://localhost:5173/push-to-talk-voice",
    };
    request(unknownContents, "media", callback, details);
    expect(callback).toHaveBeenCalledWith(false);
    expect(
      check(unknownContents, "media", "http://localhost:5173", {
        ...details,
        mediaType: "audio",
      })
    ).toBe(false);

    // Denies non-media permissions
    callback.mockClear();
    request(voiceContents, "geolocation", callback, details);
    expect(callback).toHaveBeenCalledWith(false);

    // Rechecks after OS consent and denies if origin changed
    callback.mockClear();
    request(voiceContents, "media", callback, details);
    voiceContents.getURL.mockReturnValue("https://evil.example");
    await Promise.resolve();
    expect(callback).toHaveBeenCalledWith(false);
  });
});
