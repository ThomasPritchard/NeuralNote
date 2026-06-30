import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatStub } from "./ChatStub";

describe("ChatStub", () => {
  it("renders an honest, clearly-disabled cited-recall shell", () => {
    render(<ChatStub />);
    expect(screen.getByText("Cited recall")).toBeInTheDocument();
    expect(screen.getByText("Indexing soon")).toBeInTheDocument();
    expect(screen.getByText(/Cited chat arrives in the next phase/i)).toBeInTheDocument();
  });

  it("disables the input and send button (no faked AI)", () => {
    render(<ChatStub />);
    expect(screen.getByLabelText(/Ask across your vault/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /Send/i })).toBeDisabled();
  });
});
