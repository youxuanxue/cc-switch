import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SessionTocDialog,
  SessionTocSidebar,
} from "@/components/sessions/SessionToc";

describe("SessionToc", () => {
  it("renders the sidebar for a single user turn instead of hiding Claude-style transcripts", () => {
    render(
      <SessionTocSidebar
        items={[{ index: 0, preview: "loop every 30 minutes", ts: 1 }]}
        onItemClick={() => undefined}
      />,
    );

    expect(screen.getByText("sessionManager.tocTitle")).toBeInTheDocument();
    expect(screen.getByText("loop every 30 minutes")).toBeInTheDocument();
  });

  it("keeps the sidebar chrome even when there are no jump targets", () => {
    render(<SessionTocSidebar items={[]} onItemClick={() => undefined} />);

    expect(screen.getByText("sessionManager.tocTitle")).toBeInTheDocument();
  });

  it("shows the compact dialog trigger when there is at least one jump target", () => {
    render(
      <SessionTocDialog
        items={[{ index: 0, preview: "single Claude turn" }]}
        onItemClick={() => undefined}
        open={false}
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("does not float an empty dialog when there is nothing to jump to", () => {
    const { container } = render(
      <SessionTocDialog
        items={[]}
        onItemClick={() => undefined}
        open={false}
        onOpenChange={() => undefined}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
