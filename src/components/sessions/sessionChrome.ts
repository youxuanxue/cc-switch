import type { SessionMessage } from "@/types";
import {
  extractCodexPromptPreview,
  extractCursorDisplayContent,
  extractCursorPromptPreview,
  formatSessionMessagePreview,
  shouldHideCodexMessageFromToc,
  shouldHideCursorMessageFromToc,
} from "./utils";

export interface SessionTocItem {
  index: number;
  preview: string;
  ts?: number;
}

interface SessionMessagePresentation {
  hideFromToc?: (content: string) => boolean;
  preview?: (content: string) => string;
  displayContent?: (content: string) => string;
}

const DEFAULT_PRESENTATION: SessionMessagePresentation = {};

const SESSION_MESSAGE_PRESENTATION: Record<string, SessionMessagePresentation> =
  {
    codex: {
      hideFromToc: shouldHideCodexMessageFromToc,
      preview: extractCodexPromptPreview,
    },
    cursor: {
      hideFromToc: shouldHideCursorMessageFromToc,
      preview: extractCursorPromptPreview,
      displayContent: extractCursorDisplayContent,
    },
  };

export function getSessionMessagePresentation(
  providerId?: string,
): SessionMessagePresentation {
  if (!providerId) return DEFAULT_PRESENTATION;
  return SESSION_MESSAGE_PRESENTATION[providerId] ?? DEFAULT_PRESENTATION;
}

export function toDisplayMessages(
  messages: SessionMessage[],
  providerId?: string,
): SessionMessage[] {
  const presentation = getSessionMessagePresentation(providerId);
  if (!presentation.displayContent) return messages;

  return messages.flatMap((message) => {
    const content = presentation.displayContent?.(message.content) ?? "";
    if (!content) return [];
    return [{ ...message, content }];
  });
}

export function buildSessionTocItems(
  messages: SessionMessage[],
  providerId?: string,
): SessionTocItem[] {
  const presentation = getSessionMessagePresentation(providerId);

  return messages
    .map((msg, index) => ({ msg, index }))
    .filter(({ msg }) => {
      if (msg.role.toLowerCase() !== "user") return false;
      return !presentation.hideFromToc?.(msg.content);
    })
    .map(({ msg, index }) => ({
      index,
      preview: formatSessionMessagePreview(
        presentation.preview?.(msg.content) ?? msg.content,
      ),
      ts: msg.ts,
    }));
}

export function shouldRenderSessionTocSidebar(
  _items: readonly SessionTocItem[],
): boolean {
  return true;
}

export function shouldRenderSessionTocDialog(
  items: readonly SessionTocItem[],
): boolean {
  return items.length > 0;
}
