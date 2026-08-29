import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";

import SkillsCorePanel from "@/components/skills/SkillsCorePanel";
import { skillsCoreApi } from "@/lib/api/skillsCore";
import zh from "@/i18n/locales/zh.json";

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
        candidates: [
          {
            name: "git-worktree-submodule",
            provenance: "catalog-managed",
            description: "ignored when curated",
          },
          {
            name: "unknown-local",
            provenance: "local-draft",
            description: "Do a one-off thing",
          },
        ],
        conflicts: [],
      }),
    },
  };
});

describe("SkillsCorePanel first open labels", () => {
  it("shows product names instead of raw tokens", async () => {
    render(<SkillsCorePanel onOpenDiscovery={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeInTheDocument();
    });
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("Grok Build")).toBeInTheDocument();
    expect(screen.queryByText("Claude / Cursor")).not.toBeInTheDocument();
    expect(screen.queryByText("claude-cursor")).not.toBeInTheDocument();
    expect(screen.queryByText("grokbuild")).not.toBeInTheDocument();
  });

  it("shows one product sentence so a candidate can be decided", async () => {
    i18n.addResourceBundle("zh", "translation", zh, true, true);
    render(<SkillsCorePanel onOpenDiscovery={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByText("Pi")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Pi"));

    await waitFor(() => {
      expect(skillsCoreApi.previewOpen).toHaveBeenCalledWith(["pi"]);
    });
    expect(
      screen.getByText("在含 submodule 的仓库里，统一帮 Agent 建和切工作区。"),
    ).toBeInTheDocument();
    expect(screen.getByText("Do a one-off thing")).toBeInTheDocument();
    expect(screen.queryByText("工作")).not.toBeInTheDocument();
    expect(screen.queryByText("何时不要")).not.toBeInTheDocument();
    expect(screen.queryByText("进台后果")).not.toBeInTheDocument();
    expect(screen.queryByText("local-draft")).not.toBeInTheDocument();
    expect(screen.queryByText("ignored when curated")).not.toBeInTheDocument();
  });
});
