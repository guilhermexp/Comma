import { describe, expect, it } from "vitest";
import { splitSentences } from "../push-to-talk/message";

describe("splitSentences", () => {
  it("splits on sentence ends and line breaks, keeping decimals and empty-free", () => {
    expect(
      splitSentences("O arquivo tem 1.5 GB. Quer apagar?\nItem um\n\nPronto! Fim")
    ).toEqual(["O arquivo tem 1.5 GB.", "Quer apagar?", "Item um", "Pronto!", "Fim"]);
  });
});
