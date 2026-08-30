import { APP_IDS } from "@/config/appConfig";
import {
  MS_PER_DAY,
  getSessionActivityAt,
} from "@/components/sessions/sessionCapabilities";
import type { AppId } from "@/lib/api";
import type { SessionMeta } from "@/types";

export const APP_SWITCHER_RECENT_WINDOW_DAYS = 7;
export const APP_SWITCHER_RECENT_WINDOW_MS =
  APP_SWITCHER_RECENT_WINDOW_DAYS * MS_PER_DAY;

const APP_ID_SET = new Set<string>(APP_IDS);
const APP_ID_INDEX = new Map(APP_IDS.map((id, index) => [id, index]));

function isAppId(value: string): value is AppId {
  return APP_ID_SET.has(value);
}

export function countRecentSessionsByApp(
  sessions: SessionMeta[],
  now = Date.now(),
  windowMs = APP_SWITCHER_RECENT_WINDOW_MS,
): Map<AppId, number> {
  const cutoff = now - windowMs;
  const counts = new Map<AppId, number>();

  for (const session of sessions) {
    if (!isAppId(session.providerId)) {
      continue;
    }
    const activityAt = getSessionActivityAt(session);
    if (!activityAt || activityAt < cutoff) {
      continue;
    }
    counts.set(session.providerId, (counts.get(session.providerId) ?? 0) + 1);
  }

  return counts;
}

export function sortAppsByRecentSessionCount<T extends AppId>(
  apps: T[],
  sessions: SessionMeta[] | undefined,
  now = Date.now(),
): T[] {
  if (!sessions) {
    return [...apps];
  }

  const counts = countRecentSessionsByApp(sessions, now);
  return [...apps].sort((left, right) => {
    const countDiff = (counts.get(right) ?? 0) - (counts.get(left) ?? 0);
    if (countDiff !== 0) {
      return countDiff;
    }
    return (APP_ID_INDEX.get(left) ?? 0) - (APP_ID_INDEX.get(right) ?? 0);
  });
}
