import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MermaidBlock } from "./MarkdownViewer";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

import mermaid from "mermaid";

const writeTextMock = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  writeTextMock.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true,
  });
});

describe("MermaidBlock", () => {
  it("shows copy button when mermaid renders successfully", async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: "<svg>diagram</svg>",
      bindFunctions: undefined,
      diagramType: "flowchart",
    });

    render(<MermaidBlock code="graph TD; A-->B" />);

    await waitFor(() => {
      expect(screen.getByTitle("Copy code")).toBeInTheDocument();
    });
  });

  it("shows copy button in fallback mode when rendering fails", async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error("parse error"));

    render(<MermaidBlock code="invalid mermaid" />);

    await waitFor(() => {
      expect(screen.getByTitle("Copy code")).toBeInTheDocument();
    });
    expect(screen.getByText("invalid mermaid")).toBeInTheDocument();
  });

  it("copies original mermaid code to clipboard on click", async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: "<svg>diagram</svg>",
      bindFunctions: undefined,
      diagramType: "flowchart",
    });

    render(<MermaidBlock code="graph TD; A-->B" />);

    await waitFor(() => {
      expect(screen.getByTitle("Copy code")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Copy code"));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("graph TD; A-->B");
    });
  });
});
