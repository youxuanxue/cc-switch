import { isCursorCapabilitySupported } from "@/config/cursorCapabilities";
import type { SessionMeta } from "@/types";

export const MS_PER_DAY = 86_400_000;
export const STALE_CLEANUP_MIN_DAYS = 1;
export const STALE_CLEANUP_MAX_DAYS = 3650;
export const STALE_CLEANUP_DEFAULT_DAYS = 30;

export function isSessionDeletable(session: SessionMeta): boolean {
  if (session.providerId === "cursor") {
    return (
      isCursorCapabilitySupported("sessionDeletion") &&
      Boolean(session.sourcePath)
    );
  }
  return Boolean(session.sourcePath);
}

export function normalizeStaleCleanupDays(days: number): number | null {
  if (
    !Number.isInteger(days) ||
    days < STALE_CLEANUP_MIN_DAYS ||
    days > STALE_CLEANUP_MAX_DAYS
  ) {
    return null;
  }
  return days;
}

export function getSessionActivityAt(session: SessionMeta): number | undefined {
  return session.lastActiveAt || session.createdAt || undefined;
}

export function summarizeStaleCleanup(
  sessions: SessionMeta[],
  days: number,
  now = Date.now(),
): { targets: SessionMeta[]; skipped: number } {
  const normalized = normalizeStaleCleanupDays(days);
  if (normalized === null) {
    return { targets: [], skipped: 0 };
  }

  const cutoff = now - normalized * MS_PER_DAY;
  const targets: SessionMeta[] = [];
  let skipped = 0;

  for (const session of sessions) {
    const activityAt = getSessionActivityAt(session);
    if (!activityAt || activityAt > cutoff) {
      continue;
    }
    if (isSessionDeletable(session)) {
      targets.push(session);
    } else {
      skipped += 1;
    }
  }

  return { targets, skipped };
}
