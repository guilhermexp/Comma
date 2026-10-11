import type { SitePermissionMenuWindow } from "../../site-permission-menu-window";
import { defaultLocale, messages } from "@comma/i18n";
import { BaseWindow, dialog, systemPreferences } from "electron";
import { readMainLocale, type MainLocaleSource } from "../../main-locale";
import type { SitePermissionPlatform } from "./site-permissions";

const windowFor = (owner: unknown) =>
  owner instanceof BaseWindow && !owner.isDestroyed() ? owner : undefined;

/** OS consent stays native; website settings use the trusted Comma menu window. */
export function createSitePermissionPlatform(
  locale: MainLocaleSource = defaultLocale,
  menu?: SitePermissionMenuWindow
): SitePermissionPlatform {
  // Read at each dialog so the text follows the app language Main holds now.
  const options = () => ({ locale: readMainLocale(locale) });

  const show = (owner: unknown, message: string) => {
    const window = windowFor(owner);
    if (window)
      void dialog
        .showMessageBox(window, {
          type: "error",
          title: messages.site_permissions_title({}, options()),
          message,
        })
        .catch(() => undefined);
  };
  return {
    async prompt({ owner, origin, media, signal }) {
      const window = windowFor(owner);
      if (!window || signal.aborted) return "ask";
      const result = await dialog.showMessageBox(window, {
        type: "question",
        title: messages.site_permissions_title({}, options()),
        message:
          media.includes("microphone") && media.includes("camera")
            ? messages.site_permissions_prompt_microphone_camera({ origin }, options())
            : media.includes("camera")
              ? messages.site_permissions_prompt_camera({ origin }, options())
              : messages.site_permissions_prompt_microphone({ origin }, options()),
        detail: messages.site_permissions_prompt_detail({}, options()),
        buttons: [
          messages.site_permissions_allow({}, options()),
          messages.site_permissions_block({}, options()),
          messages.site_permissions_not_now({}, options()),
        ],
        defaultId: 2,
        cancelId: 2,
        noLink: true,
        signal,
      });
      return result.response === 0 ? "allow" : result.response === 1 ? "block" : "ask";
    },
    ...(menu
      ? {
          menu,
          prepare: (owner: unknown) => {
            void menu.prepare(owner).catch(() => undefined);
          },
        }
      : {}),
    settings(input) {
      if (!menu)
        return Promise.reject(new Error("Website permission menu is unavailable."));
      return menu.open(input);
    },
    hasSystemAccess: (media) =>
      process.platform !== "darwin" ||
      systemPreferences.getMediaAccessStatus(media) === "granted",
    async ensureSystemAccess(owner, media) {
      if (process.platform !== "darwin") return true;
      for (const type of media) {
        let status = systemPreferences.getMediaAccessStatus(type);
        if (status === "not-determined") {
          if (await systemPreferences.askForMediaAccess(type)) status = "granted";
        }
        if (status !== "granted") {
          show(
            owner,
            messages.site_permissions_system_access_denied(
              {
                media:
                  type === "microphone"
                    ? messages.site_permissions_microphone({}, options())
                    : messages.site_permissions_camera({}, options()),
              },
              options()
            )
          );
          return false;
        }
      }
      return true;
    },
    reportError: (owner, kind) =>
      show(
        owner,
        {
          "storage-unreadable": messages.site_permissions_storage_unreadable,
          "storage-full": messages.site_permissions_storage_full,
          failed: messages.site_permissions_failed,
        }[kind]({}, options())
      ),
  };
}
