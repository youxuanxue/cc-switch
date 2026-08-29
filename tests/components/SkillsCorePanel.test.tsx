import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SkillsCorePanel from "@/components/skills/SkillsCorePanel";

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
});
