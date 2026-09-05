/**
 * @jest-environment jsdom
 */
/**
 * components/BuyButton.tsx — the one Buy CTA on every VideoCard.
 *
 * Locks the Noah #4 polish (purple pill, hollow white cart, "Buy $X.XX",
 * trailing chevron) AND the things the restyle must not break: the button
 * is still a real <button type="button"> that announces its dropdown via
 * aria-haspopup / aria-expanded, and the mobile size overrides survive.
 *
 * Renders the REAL component (createRoot + act, no JSX) — same pattern as
 * single-auth-flow.test.ts.
 */

import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import BuyButton from "@/components/BuyButton";

// react-dom/client refuses act() outside a marked act environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type BuyButtonProps = Parameters<typeof BuyButton>[0];

describe("BuyButton", () => {
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

  async function render(props: BuyButtonProps): Promise<HTMLButtonElement> {
    await act(async () => {
      root.render(createElement(BuyButton, props));
    });
    const button = container.querySelector("button");
    if (!button) throw new Error("BuyButton did not render a <button>");
    return button;
  }

  const cartOf = (button: HTMLElement) =>
    button.querySelector("svg.lucide-shopping-cart");
  const chevronOf = (button: HTMLElement) =>
    button.querySelector("svg.lucide-chevron-right");

  test("renders the Buy label followed by the formatted dollar price", async () => {
    const button = await render({ priceCents: 10000 });

    // Label and price are sibling spans spaced by CSS gap, so assert each
    // span's text rather than the whitespace-free textContent concatenation.
    const spans = Array.from(button.querySelectorAll("span")).map((s) => s.textContent);
    expect(spans).toEqual(["Buy", "$100.00"]);
  });

  test("formats cents with two decimals", async () => {
    const button = await render({ priceCents: 1999 });

    expect(button.textContent).toContain("$19.99");
  });

  test("omits the price when priceCents is null or zero", async () => {
    const withNull = await render({ priceCents: null });
    expect(withNull.textContent?.trim()).toBe("Buy");

    const withZero = await render({ priceCents: 0 });
    expect(withZero.textContent).not.toContain("$");
  });

  test("is a non-submitting button that announces its dropdown menu", async () => {
    const button = await render({ priceCents: 500 });

    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  test("forwards clicks to the parent toggle", async () => {
    const onClick = jest.fn();
    const button = await render({ priceCents: 500, onClick });

    await act(async () => {
      button.click();
    });

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("chevron rotation class toggles together with aria-expanded", async () => {
    const closed = await render({ priceCents: 500, expanded: false });
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    expect(chevronOf(closed)?.classList.contains("rotate-90")).toBe(false);

    const open = await render({ priceCents: 500, expanded: true });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(chevronOf(open)?.classList.contains("rotate-90")).toBe(true);
    // The rotation animates, so it must be disabled for prefers-reduced-motion.
    expect(chevronOf(open)?.classList.contains("motion-reduce:transition-none")).toBe(true);
  });

  test("cart icon is a hollow stroke icon, not a filled glyph", async () => {
    const button = await render({ priceCents: 500 });
    const cart = cartOf(button);

    expect(cart).not.toBeNull();
    // lucide renders fill="none" + stroke="currentColor"; the old inline SVG
    // was fill="currentColor" (solid). The mockup wants the thin hollow cart.
    expect(cart?.getAttribute("fill")).toBe("none");
    expect(cart?.getAttribute("stroke")).toBe("currentColor");
    expect(cart?.getAttribute("stroke-width")).toBe("2");
    expect(cart?.getAttribute("aria-hidden")).toBe("true");
  });

  test("trailing icon is a right chevron, not the old down caret", async () => {
    const button = await render({ priceCents: 500 });

    expect(chevronOf(button)).not.toBeNull();
    expect(button.querySelectorAll("svg")).toHaveLength(2);
  });

  test("is the in-app purple pill with white text", async () => {
    const button = await render({ priceCents: 500 });
    const cls = button.className;

    expect(cls).toContain("bg-[#4A35C7]");
    expect(cls).toContain("hover:bg-[#3D2BA3]");
    expect(cls).toContain("text-white");
    expect(cls).toContain("rounded-full");
    // The silver gradient / frosted border is gone.
    expect(cls).not.toContain("bg-gradient-to-b");
    expect(cls).not.toContain("border-white/25");
  });

  test("keeps the mobile size overrides the card layout depends on", async () => {
    const button = await render({ priceCents: 500 });
    const cls = button.className;

    for (const sizeClass of ["max-sm:!h-7", "max-sm:!min-h-3", "max-sm:!py-0", "max-sm:!rounded-xl"]) {
      expect(cls).toContain(sizeClass);
    }
  });
});
