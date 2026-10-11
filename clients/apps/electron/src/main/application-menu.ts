import { applicationMenuIcons } from "./generated/application-menu-icons";
import { app, Menu, nativeImage, type MenuItemConstructorOptions } from "electron";
import { defaultLocale, messages, type CommaLocale } from "@comma/i18n";
import type {
  ApplicationMenuCommand,
  ApplicationMenuItems,
} from "@comma/native-bridge";
import { applicationMenuProvider } from "./application-menu-provider";

type Options = {
  isMainFocused: () => boolean;
  dispatch: (id: ApplicationMenuCommand) => void;
  /** Main's language until the renderer publishes its menu presentation. */
  locale?: CommaLocale;
  openMain: () => unknown;
  openSideChat: () => unknown;
  openSideChatBackground?: () => unknown;
  /** False hides Open Side Chat, as Side Chat is turned off in General. */
  sideChatEnabled: () => boolean;
};
type MenuLabel = (
  inputs: Record<string, never>,
  options: { locale: CommaLocale }
) => string;
const accelerators = (entries: ApplicationMenuItems) =>
  JSON.stringify(
    entries
      .filter((item) => item.accelerator)
      .map((item) => [item.id, item.accelerator])
      .toSorted(([left], [right]) => left!.localeCompare(right!))
  );

export function installApplicationMenu(options: Options) {
  const images = new Map(
    Object.entries(applicationMenuIcons).map(([id, data]) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"), {
        scaleFactor: 2,
      });
      image.setTemplateImage(true);
      return [id, image];
    })
  );
  let items: ApplicationMenuItems = [];
  let locale: CommaLocale = options.locale ?? defaultLocale;
  // Electron's role items carry English labels; every label comes from the
  // catalog so the whole menu follows the app language.
  const t = (label: MenuLabel) => label({}, { locale });
  let menu: Menu | undefined;
  const labels = new Map<ApplicationMenuCommand, MenuLabel>();

  function update() {
    if (!menu) return;
    const focused = options.isMainFocused();
    for (const [id, label] of labels) {
      const item = menu.getMenuItemById(id);
      if (!item) continue;
      const state = items.find((candidate) => candidate.id === id);
      item.enabled = (state?.enabled ?? false) && focused;
      item.label = state?.shortcutLabel
        ? `${t(label)}    ${state.shortcutLabel}`
        : t(label);
      if (item.type === "checkbox") item.checked = state?.checked ?? false;
      if (id === "record-resume") item.visible = state?.enabled ?? false;
      if (id === "record-pause") {
        item.visible = !items.some(
          (candidate) => candidate.id === "record-resume" && candidate.enabled
        );
      }
    }
    const sideChatItem = menu.getMenuItemById("open-side-chat");
    if (sideChatItem) sideChatItem.visible = options.sideChatEnabled();
  }

  function build() {
    const command = (
      id: ApplicationMenuCommand,
      label: MenuLabel
    ): MenuItemConstructorOptions => {
      labels.set(id, label);
      const state = items.find((item) => item.id === id);
      return {
        ...(images.has(id) ? { icon: images.get(id)! } : {}),
        id,
        label: state?.shortcutLabel
          ? `${t(label)}    ${state.shortcutLabel}`
          : t(label),
        enabled: (state?.enabled ?? false) && options.isMainFocused(),
        ...(id === "record-resume" ? { visible: state?.enabled ?? false } : {}),
        ...(id === "record-pause"
          ? {
              visible: !items.some(
                (item) => item.id === "record-resume" && item.enabled
              ),
            }
          : {}),
        ...(id === "toggle-left-sidebar" || id === "toggle-right-sidebar"
          ? { type: "checkbox", checked: state?.checked ?? false }
          : {}),
        ...(state?.accelerator
          ? { accelerator: state.accelerator, acceleratorWorksWhenHidden: false }
          : {}),
        click: () => options.dispatch(id),
      };
    };
    const product = { productName: app.name };
    const separator: MenuItemConstructorOptions = { type: "separator" };
    const mac = process.platform === "darwin";
    const template: MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: "about", label: messages.app_menu_about(product, { locale }) },
          command("check-updates", messages.app_menu_check_updates),
          separator,
          command("go-settings", messages.app_menu_settings),
          separator,
          { role: "services", label: t(messages.app_menu_services) },
          separator,
          { role: "hide", label: messages.app_menu_hide(product, { locale }) },
          { role: "hideOthers", label: t(messages.app_menu_hide_others) },
          { role: "unhide", label: t(messages.app_menu_show_all) },
          separator,
          { role: "quit", label: messages.app_menu_quit(product, { locale }) },
        ],
      },
      {
        label: t(messages.app_menu_file),
        submenu: [
          command("record-start", messages.app_menu_record_start),
          command("record-pause", messages.app_menu_record_pause),
          command("record-resume", messages.app_menu_record_resume),
          command("record-stop", messages.app_menu_record_stop),
          command("go-recording-settings", messages.app_menu_recording_settings),
          separator,
          command("drive-upload", messages.app_menu_drive_upload),
          command("drive-upload-folder", messages.app_menu_drive_upload_folder),
          command("drive-add-folder", messages.app_menu_drive_add_folder),
          command("drive-download", messages.app_menu_drive_download),
          separator,
          command("browser-new-tab", messages.app_menu_browser_new_tab),
          command("browser-close-tab", messages.app_menu_browser_close_tab),
          separator,
          { role: "close", label: t(messages.app_menu_close_window) },
        ],
      },
      {
        // Electron's editMenu role, spelled out so each item takes a label.
        label: t(messages.app_menu_edit),
        submenu: [
          { role: "undo", label: t(messages.app_menu_undo) },
          { role: "redo", label: t(messages.app_menu_redo) },
          separator,
          { role: "cut", label: t(messages.app_menu_cut) },
          { role: "copy", label: t(messages.app_menu_copy) },
          { role: "paste", label: t(messages.app_menu_paste) },
          ...(mac
            ? [
                {
                  role: "pasteAndMatchStyle",
                  label: t(messages.app_menu_paste_match_style),
                } as const,
              ]
            : []),
          { role: "delete", label: t(messages.app_menu_delete) },
          { role: "selectAll", label: t(messages.app_menu_select_all) },
          ...(mac
            ? [
                separator,
                {
                  label: t(messages.app_menu_speech),
                  submenu: [
                    {
                      role: "startSpeaking",
                      label: t(messages.app_menu_start_speaking),
                    },
                    {
                      role: "stopSpeaking",
                      label: t(messages.app_menu_stop_speaking),
                    },
                  ],
                } satisfies MenuItemConstructorOptions,
              ]
            : []),
        ],
      },
      {
        label: t(messages.app_menu_view),
        submenu: [
          command("go-comma-assistant", messages.app_menu_home),
          command("go-inbox", messages.app_menu_inbox),
          command("go-drive", messages.app_menu_drive),
          command("go-tasks", messages.app_menu_tasks),
          command("go-plugins", messages.app_menu_plugins),
          command("go-routines", messages.app_menu_routines),
          command("go-search", messages.app_menu_search_tasks),
          separator,
          command("history-back", messages.app_menu_back),
          command("history-forward", messages.app_menu_forward),
          separator,
          command("toggle-left-sidebar", messages.app_menu_show_left_sidebar),
          command("toggle-right-sidebar", messages.app_menu_show_right_sidebar),
          separator,
          {
            id: "toggle-devtools",
            role: "toggleDevTools",
            label: t(messages.app_menu_toggle_devtools),
          },
          ...(options.openSideChatBackground
            ? [
                {
                  id: "side-chat-background-debug",
                  label: t(messages.app_menu_side_chat_background),
                  click: () => {
                    void options.openSideChatBackground?.();
                  },
                },
              ]
            : []),
          separator,
          { role: "zoomIn", label: t(messages.app_menu_zoom_in) },
          { role: "zoomOut", label: t(messages.app_menu_zoom_out) },
          { role: "resetZoom", label: t(messages.app_menu_actual_size) },
          separator,
          { role: "togglefullscreen", label: t(messages.app_menu_toggle_full_screen) },
        ],
      },
      {
        role: "windowMenu",
        label: t(messages.app_menu_window),
        submenu: [
          {
            label: t(messages.app_menu_show_comma),
            click: () => {
              void options.openMain();
            },
          },
          {
            id: "open-side-chat",
            label: t(messages.app_menu_open_side_chat),
            visible: options.sideChatEnabled(),
            click: () => {
              void options.openSideChat();
            },
          },
          separator,
          { role: "minimize", label: t(messages.app_menu_minimize) },
          { role: "zoom", label: t(messages.app_menu_zoom) },
          separator,
          { role: "front", label: t(messages.app_menu_bring_all_to_front) },
        ],
      },
      {
        role: "help",
        label: t(messages.app_menu_help),
        submenu: [command("go-shortcuts", messages.app_menu_keyboard_shortcuts)],
      },
    ];
    menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }
  applicationMenuProvider.subscribe((next) => {
    const structureChanged =
      locale !== next.locale || accelerators(items) !== accelerators(next.items);
    items = next.items;
    locale = next.locale;
    if (structureChanged) build();
    else update();
  });
  app.on("browser-window-focus", update);
  app.on("browser-window-blur", update);
  build();
  return { update };
}
