export type CursorCapabilityState = "supported" | "conditional" | "unsupported";

export const cursorCapabilities = {
  officialLogin: "supported",
  userApiKey: "supported",
  fixedSessionResume: "supported",
  localSessionIndex: "conditional",
  transcriptPreview: "unsupported",
  sessionDeletion: "unsupported",
} as const satisfies Record<string, CursorCapabilityState>;

export type CursorCapability = keyof typeof cursorCapabilities;

export function isCursorCapabilitySupported(
  capability: CursorCapability,
): boolean {
  return cursorCapabilities[capability] === "supported";
}
