import { describe, expect, it } from "vitest";
import { reconcileSidebarNavOrder } from "../sidebarNavOrder";

describe("reconcileSidebarNavOrder", () => {
  it.each([
    {
      name: "shows the default order for an empty preference",
      stored: [],
      expected: ["home", "inbox", "tasks", "drive", "plugins", "agenda"],
    },
    {
      name: "keeps the reader's arrangement",
      stored: ["tasks", "home", "plugins", "agenda", "inbox", "drive"],
      expected: ["tasks", "home", "plugins", "agenda", "inbox", "drive"],
    },
    {
      name: "adds Agenda after a saved order that predates it",
      stored: ["home", "tasks", "inbox", "drive", "plugins"],
      expected: ["home", "tasks", "inbox", "drive", "plugins", "agenda"],
    },
    {
      name: "drops ids the build no longer ships and appends ones it newly does",
      stored: ["tasks", "archive", "home"],
      expected: ["tasks", "home", "inbox", "drive", "plugins", "agenda"],
    },
    {
      name: "collapses a duplicated id to its first position",
      stored: ["inbox", "home", "inbox"],
      expected: ["inbox", "home", "tasks", "drive", "plugins", "agenda"],
    },
  ])("$name", ({ stored, expected }) => {
    expect(reconcileSidebarNavOrder(stored)).toEqual(expected);
  });
});
