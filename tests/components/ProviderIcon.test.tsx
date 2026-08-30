import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderIcon } from "@/components/ProviderIcon";

describe("ProviderIcon", () => {
  it("renders the Cursor mark instead of a letter fallback", () => {
    const { container } = render(
      <ProviderIcon icon="cursor" name="cursor" size={18} />,
    );

    expect(container.querySelector("svg title")?.textContent).toBe("Cursor");
    expect(screen.queryByText("C")).not.toBeInTheDocument();
  });

  it("falls back to initials when the icon is missing", () => {
    render(<ProviderIcon icon="not-a-real-icon" name="cursor" size={18} />);

    expect(screen.getByText("C")).toBeInTheDocument();
  });
});
