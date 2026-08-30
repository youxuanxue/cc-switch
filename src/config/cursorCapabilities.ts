export type CursorCapabilityState = "supported" | "conditional" | "unsupported";

export const cursorCapabilities = {
  officialLogin: "supported",
  userApiKey: "supported",
  fixedSessionResume: "supported",
  localSessionIndex: "conditional",
  transcriptPreview: "supported",
  // Agent CLI local chats under ~/.cursor/chats only. Cursor Desktop stores stay out of scope.
  sessionDeletion: "supported",
} as const satisfies Record<string, CursorCapabilityState>;

export type CursorCapability = keyof typeof cursorCapabilities;

export function isCursorCapabilitySupported(
  capability: CursorCapability,
): boolean {
  return cursorCapabilities[capability] === "supported";
}
