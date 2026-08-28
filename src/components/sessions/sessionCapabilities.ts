import type { SessionMeta } from "@/types";

export function isSessionDeletable(session: SessionMeta): boolean {
  return session.providerId !== "cursor" && Boolean(session.sourcePath);
}
