import { Suspense, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "i18next";
import en from "@/i18n/locales/en.json";
import { resetProviderState, setSettings } from "../msw/state";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({ providers }: { providers: Record<string, unknown> }) => (
    <div data-testid="provider-list">{JSON.stringify(providers)}</div>
  ),
}));

vi.mock("@/components/providers/AddProviderDialog", () => ({
  AddProviderDialog: () => null,
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: () => null,
}));

vi.mock("@/components/UsageScriptModal", () => ({
  default: () => null,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({ hasUpdate: false, updateInfo: null }),
}));

vi.mock("@/components/settings/SettingsPage", () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}));

vi.mock("@/components/skills/SkillsPage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/skills/SkillsPage")>();
  return {
    ...actual,
    SkillsPage: () => <div data-testid="skills-discovery-page" />,
  };
});

vi.mock("@/components/mcp/McpPanel", () => ({
  default: () => null,
}));

vi.mock("@/components/sessions/SessionManagerPage", () => ({
  SessionManagerPage: () => <div data-testid="session-manager-stub" />,
}));

vi.mock("@/lib/api/skillsCore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/skillsCore")>();
  return {
    ...actual,
    skillsCoreApi: {
      ...actual.skillsCoreApi,
      doctor: vi.fn().mockResolvedValue({
        schema: 1,
        open: false,
        follow_catalog: true,
        catalog_ref: { repo: "", revision: "" },
        in_use_agents: [],
        library: [],
        projections: [],
        foreign: [],
        broken: [],
        duplicate: [],
        legacy_writers_stopped: [],
        reload: [],
      }),
      previewOpen: vi.fn().mockResolvedValue({
        candidates: [],
        conflicts: [],
      }),
    },
  };
});

const renderApp = (AppComponent: ComponentType) => {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <AppComponent />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("App skills route wires SkillsCorePanel", () => {
  beforeEach(() => {
    resetProviderState();
    setSettings({ firstRunNoticeConfirmed: true, language: "en" });
    i18n.addResourceBundle("en", "translation", en, true, true);
    void i18n.changeLanguage("en");
    localStorage.setItem("cc-switch-last-view", "skills");
  });

  it("renders the real SkillsCorePanel on the skills view", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    const main = document.getElementById("main-content");
    expect(main).not.toBeNull();
    expect(
      await within(main as HTMLElement).findByRole("heading", {
        name: "First time: pick in-use agents",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("skills-core-panel")).not.toBeInTheDocument();
  });
});
