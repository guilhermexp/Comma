import { beforeEach, describe, expect, it, vi } from "vitest";
const electron = vi.hoisted(() => ({
  BaseWindow: class {
    isDestroyed() {
      return false;
    }
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 2 })) },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn(), closePopup: vi.fn() })) },
  shell: { openExternal: vi.fn(async () => {}) },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => "granted"),
    askForMediaAccess: vi.fn(async () => true),
  },
}));
vi.mock("electron", () => electron);
import { createSitePermissionPlatform } from "../modules/browser-sidebar/site-permissions-platform";
import type { SitePermissionMenuWindow } from "../site-permission-menu-window";

beforeEach(() => {
  vi.clearAllMocks();
  electron.dialog.showMessageBox.mockResolvedValue({ response: 2 });
});
describe("native website permission UI", () => {
  it("shows the exact website and requested devices, with dismissal denying without persistence", async () => {
    const platform = createSitePermissionPlatform("en");
    const input = {
      owner: new electron.BaseWindow(),
      origin: "https://meet.google.com",
      media: ["microphone", "camera"] as ("microphone" | "camera")[],
      signal: new AbortController().signal,
    };
    expect(await platform.prompt(input)).toBe("ask");
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      input.owner,
      expect.objectContaining({
        message: "https://meet.google.com wants to use your microphone and camera",
        buttons: ["Allow", "Block", "Not now"],
        defaultId: 2,
        cancelId: 2,
        signal: input.signal,
      })
    );
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await platform.prompt(input)).toBe("allow");
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await platform.prompt(input)).toBe("block");
  });
  it("follows the app language Main holds when each dialog opens", async () => {
    let locale: "pt-BR" | "zh-CN" | "en" = "pt-BR";
    const platform = createSitePermissionPlatform(() => locale);
    const input = {
      owner: new electron.BaseWindow(),
      origin: "https://meet.google.com",
      media: ["camera"] as ("microphone" | "camera")[],
      signal: new AbortController().signal,
    };
    await platform.prompt(input);
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
      input.owner,
      expect.objectContaining({
        title: "Permissões do site",
        message: "https://meet.google.com quer usar sua câmera",
        buttons: ["Permitir", "Bloquear", "Agora não"],
      })
    );
    locale = "zh-CN";
    await platform.prompt(input);
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
      input.owner,
      expect.objectContaining({
        title: "网站权限",
        message: "https://meet.google.com 请求使用摄像头",
        buttons: ["允许", "阻止", "暂不允许"],
      })
    );
    platform.reportError(input.owner, "storage-full");
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
      input.owner,
      expect.objectContaining({ type: "error", title: "网站权限" })
    );
  });
  it("opens Comma's dedicated menu with the document-bound callbacks and anchor", async () => {
    const open = vi.fn(async () => {});
    const menu = { open } as unknown as SitePermissionMenuWindow;
    const input = {
      owner: new electron.BaseWindow(),
      origin: "https://meet.google.com",
      choices: { microphone: "allow" as const, camera: "ask" as const },
      anchor: { x: 100, y: 40, width: 28, height: 28 },
      signal: new AbortController().signal,
      change: vi.fn(),
      reset: vi.fn(),
      reload: vi.fn(),
    };
    const platform = createSitePermissionPlatform("en", menu);
    await platform.settings(input);
    expect(open).toHaveBeenCalledWith(input);
    expect(platform.menu).toBe(menu);
    expect(electron.Menu.buildFromTemplate).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === "darwin")(
    "requests macOS consent and explains an OS denial",
    async () => {
      const platform = createSitePermissionPlatform("en");
      const owner = new electron.BaseWindow();
      electron.systemPreferences.getMediaAccessStatus.mockReturnValue("not-determined");
      expect(platform.hasSystemAccess("microphone")).toBe(false);
      expect(await platform.ensureSystemAccess(owner, ["microphone"])).toBe(true);
      expect(electron.systemPreferences.askForMediaAccess).toHaveBeenCalledWith(
        "microphone"
      );
      electron.systemPreferences.getMediaAccessStatus.mockReturnValue("denied");
      expect(await platform.ensureSystemAccess(owner, ["camera"])).toBe(false);
      expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
        owner,
        expect.objectContaining({
          message: expect.stringContaining("Privacy & Security → Camera"),
        })
      );
    }
  );
});
