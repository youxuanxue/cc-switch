import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSettings } from "@/components/settings/TerminalSettings";

const platformMocks = vi.hoisted(() => ({
  isMac: vi.fn(() => true),
  isWindows: vi.fn(() => false),
  isLinux: vi.fn(() => false),
}));

vi.mock("@/lib/platform", () => ({
  isMac: () => platformMocks.isMac(),
  isWindows: () => platformMocks.isWindows(),
  isLinux: () => platformMocks.isLinux(),
}));

describe("TerminalSettings", () => {
  beforeEach(() => {
    platformMocks.isMac.mockReturnValue(true);
    platformMocks.isWindows.mockReturnValue(false);
    platformMocks.isLinux.mockReturnValue(false);
  });

  it("shows iTerm open mode only when iTerm is the preferred terminal", () => {
    const { rerender } = render(
      <TerminalSettings value="iterm2" onChange={vi.fn()} />,
    );

    expect(
      screen.getByLabelText("settings.terminal.openModeDescription"),
    ).toBeInTheDocument();

    rerender(<TerminalSettings value="terminal" onChange={vi.fn()} />);

    expect(
      screen.queryByLabelText("settings.terminal.openModeDescription"),
    ).not.toBeInTheDocument();
  });

  it("hides iTerm open mode on non-mac platforms even if the value is iTerm", () => {
    platformMocks.isMac.mockReturnValue(false);
    platformMocks.isLinux.mockReturnValue(true);

    render(<TerminalSettings value="iterm2" onChange={vi.fn()} />);

    expect(
      screen.queryByLabelText("settings.terminal.openModeDescription"),
    ).not.toBeInTheDocument();
  });
});
