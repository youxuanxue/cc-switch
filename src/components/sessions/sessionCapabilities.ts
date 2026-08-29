import { isCursorCapabilitySupported } from "@/config/cursorCapabilities";
import type { SessionMeta } from "@/types";

export function isSessionDeletable(session: SessionMeta): boolean {
  if (session.providerId === "cursor") {
    return (
      isCursorCapabilitySupported("sessionDeletion") &&
      Boolean(session.sourcePath)
    );
  }
  return Boolean(session.sourcePath);
}
