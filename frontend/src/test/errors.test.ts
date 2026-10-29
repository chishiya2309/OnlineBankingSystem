import { describe, expect, it } from "vitest";
import { id } from "ethers";
import { parseTransactionError } from "../lib/errors";

describe("Real RPC custom-error decoding", () => {
  const selector = id("EnforcedPause()").slice(0, 10);
  it.each([
    { data: selector },
    { info: { error: { data: selector } } },
    { info: { error: { data: { data: selector } } } },
  ])("decodes EnforcedPause from raw provider data %#", (metadata) => {
    expect(parseTransactionError({ message: "execution reverted (unknown custom error)", ...metadata }))
      .toBe("The banking vault is currently paused by Bank Admin.");
  });
  it("preserves the fallback for an unknown selector", () => {
    expect(parseTransactionError({ message: "Transaction failed", shortMessage: "Unknown revert", data: "0x12345678" }))
      .toBe("Unknown revert");
  });
});
