// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ConnectionNotice } from "./connection-notice";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
test("offline notice follows actual connectivity and clears after reconnecting", () => {
  const online = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
  render(<ConnectionNotice />);
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => { online.mockReturnValue(false); window.dispatchEvent(new Event("offline")); });
  expect(screen.getByRole("alert").textContent).toBe("No connection, try again");
  act(() => { online.mockReturnValue(true); window.dispatchEvent(new Event("online")); });
  expect(screen.queryByRole("alert")).toBeNull();
});
