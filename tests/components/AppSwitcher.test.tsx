import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSwitcher } from "@/components/AppSwitcher";
import { APP_SWITCHER_RECENT_WINDOW_MS } from "@/components/appSwitcherOrder";
import type { SessionMeta } from "@/types";
import { setSessionFixtures } from "../msw/state";

const renderSwitcher = (activeApp: "claude" | "codex" = "claude") => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <AppSwitcher activeApp={activeApp} onSwitch={vi.fn()} />
    </QueryClientProvider>,
  );
};

const appLabels = () =>
  screen
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"))
    .filter((label): label is string => Boolean(label));

describe("AppSwitcher", () => {
  beforeEach(() => {
    setSessionFixtures([], {});
  });

  it("moves the busiest recent apps to the front", async () => {
    const now = Date.now();
    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "codex-1",
        lastActiveAt: now,
        sourcePath: "/mock/codex-1.jsonl",
      },
      {
        providerId: "codex",
        sessionId: "codex-2",
        lastActiveAt: now,
        sourcePath: "/mock/codex-2.jsonl",
      },
      {
        providerId: "gemini",
        sessionId: "gemini-1",
        lastActiveAt: now,
        sourcePath: "/mock/gemini-1.jsonl",
      },
      {
        providerId: "claude",
        sessionId: "claude-old",
        lastActiveAt: now - APP_SWITCHER_RECENT_WINDOW_MS - 1,
        sourcePath: "/mock/claude-old.jsonl",
      },
    ];
    setSessionFixtures(sessions, {});

    renderSwitcher();

    await waitFor(() => {
      expect(appLabels().slice(0, 3)).toEqual([
        "Codex",
        "Gemini",
        "Claude Code",
      ]);
    });
  });

  it("keeps catalog order when no recent sessions exist", async () => {
    renderSwitcher();

    await waitFor(() => {
      expect(appLabels()[0]).toBe("Claude Code");
    });
    expect(appLabels().slice(0, 3)).toEqual([
      "Claude Code",
      "Claude Desktop",
      "Codex",
    ]);
  });
});
