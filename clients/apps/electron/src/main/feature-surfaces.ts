export type FeatureSurfaceKind = "window";

export interface FeatureSurfaceManifestEntry {
  id: string;
  kind: FeatureSurfaceKind;
  optionFactory:
    | "createSitePermissionMenuWindowOptions"
    | "createMeetingRecorderWindowOptions"
    | "createPushToTalkOverlayWindowOptions"
    | "createMainWindowOptions"
    | "createOnboardingWindowOptions"
    | "createRuntimeWorkbenchWindowOptions"
    | "createSideChatTestWindowOptions"
    | "createSideChatWindowOptions";
}

export const FEATURE_SURFACES = [
  {
    id: "site-permission-menu",
    kind: "window",
    optionFactory: "createSitePermissionMenuWindowOptions",
  },
  {
    id: "meeting-recorder-window",
    kind: "window",
    optionFactory: "createMeetingRecorderWindowOptions",
  },
  {
    id: "push-to-talk-overlay",
    kind: "window",
    optionFactory: "createPushToTalkOverlayWindowOptions",
  },
  {
    id: "main-window",
    kind: "window",
    optionFactory: "createMainWindowOptions",
  },
  {
    id: "onboarding-window",
    kind: "window",
    optionFactory: "createOnboardingWindowOptions",
  },
  {
    id: "runtime-workbench",
    kind: "window",
    optionFactory: "createRuntimeWorkbenchWindowOptions",
  },
  {
    id: "side-chat",
    kind: "window",
    optionFactory: "createSideChatWindowOptions",
  },
  {
    id: "side-chat-test-window",
    kind: "window",
    optionFactory: "createSideChatTestWindowOptions",
  },
] as const satisfies readonly FeatureSurfaceManifestEntry[];
