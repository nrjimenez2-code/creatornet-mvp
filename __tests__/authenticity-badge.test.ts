/**
 * @jest-environment jsdom
 */
/**
 * Blue "Authenticity verified" shield — components/AuthenticityBadge.tsx.
 *
 * Renders the REAL component (createRoot + act, no JSX — same pattern as
 * single-auth-flow.test.ts). Locks: nothing renders without the timestamp;
 * with it, an accessible blue shield whose label/title/colour differ from the
 * purple sell-ready badge so the two can never blur. Plus a source tripwire
 * that the badge stays a plain server-safe presentational component, and
 * that the public creator page actually selects the column it needs.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import AuthenticityBadge, {
  AUTHENTICITY_LABEL,
  AUTHENTICITY_TITLE,
} from "@/components/AuthenticityBadge";

const REPO_ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof AuthenticityBadge>[0];

describe("AuthenticityBadge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function render(props: Props) {
    await act(async () => {
      root.render(createElement(AuthenticityBadge, props));
    });
    return container.querySelector<HTMLElement>('[role="img"]');
  }

  it.each([null, undefined, ""])("renders nothing when verifiedAt is %p", async (value) => {
    const badge = await render({ verifiedAt: value as Props["verifiedAt"] });
    expect(badge).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("renders an accessible blue shield when the timestamp is set", async () => {
    const badge = await render({ verifiedAt: "2026-09-06T12:00:00Z" });
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("aria-label")).toBe("Authenticity verified");
    expect(badge?.getAttribute("title")).toBe("CreatorNet confirmed this is the creator's real account");
    expect(badge?.style.backgroundColor).toBe("rgb(37, 99, 235)"); // #2563EB
    expect(badge?.style.width).toBe("18px");

    const svg = badge?.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    // A shield, not a bare check: the purple badge's glyph is the single path.
    expect(svg?.querySelectorAll("path")).toHaveLength(2);
  });

  it("supports the small size", async () => {
    const badge = await render({ verifiedAt: "2026-09-06T12:00:00Z", size: "sm" });
    expect(badge?.style.width).toBe("14px");
  });

  it("is distinct from the purple sell-ready badge in label, title and colour", () => {
    expect(AUTHENTICITY_LABEL).not.toBe("Verified creator");
    expect(AUTHENTICITY_TITLE).not.toMatch(/Stripe/i);
    expect(read("components/AuthenticityBadge.tsx")).not.toMatch(/#4A35C7/i);
  });
});

describe("source tripwires", () => {
  it("the badge stays a server-safe presentational component", () => {
    const src = read("components/AuthenticityBadge.tsx");
    expect(src).not.toMatch(/^\s*['"]use client['"]/m);
    expect(src).not.toMatch(/supabase/i);
    expect(src).not.toMatch(/\buse[A-Z]\w*\(/); // no hooks
  });

  it("the public creator page selects the column and renders the badge next to the name", () => {
    const src = read("app/creators/[creatorId]/page.tsx");
    expect(src).toMatch(/AuthenticityBadge/);
    // Both profile lookups (by id and by username) must fetch the column.
    expect(src.match(/authenticity_verified_at/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("the creator card never talks to supabase auth directly (single-auth-flow)", () => {
    const src = read("components/AuthenticityVerificationCard.tsx");
    expect(src).not.toMatch(/auth\s*\.\s*(getUser|getSession)\s*\(/);
    expect(src).toMatch(/useUser\(\)/);
  });
});
