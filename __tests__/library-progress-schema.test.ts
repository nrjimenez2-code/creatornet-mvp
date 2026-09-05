/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
const router = { prefetch: jest.fn() };
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => db }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: "buyer-one", loading: false }) }));
jest.mock("next/navigation", () => ({ useRouter: () => router }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: never }) => createElement("a", { href }, children),
}));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test.each([60, null])("library resumes using seconds, with recorded duration %s", async (duration) => {
  db = createMockClient((op) => {
    if (op.table === "purchases") return {
      data: [{ id: "purchase-one", post_id: "post-one", posts: { id: "post-one", title: "QA Course", creator_id: null, duration_seconds: duration } }], error: null,
    };
    if (op.table === "watch_progress") {
      if (op.columns !== "post_id, seconds") return { data: null, error: { message: "Unknown column" } };
      return { data: [{ post_id: "post-one", seconds: 18 }], error: null };
    }
    return undefined;
  });
  const { default: LibraryPage } = await import("@/app/library/page");
  await act(async () => root.render(createElement(LibraryPage)));
  expect(db.opsFor("purchases")[0].columns).toContain("duration_seconds");
  expect(db.opsFor("watch_progress")[0].filters).toEqual({ user_id: "buyer-one" });
  expect(container.textContent).toContain("Resume");
  expect(container.textContent).toContain(duration ? "0:18 / 1:00" : "Resume at 0:18");
});
