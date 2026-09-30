import { readFileSync } from "fs";
import { join } from "path";

const profilePage = readFileSync(
  join(__dirname, "..", "app", "profile", "page.tsx"),
  "utf8",
);
const desktopShell = readFileSync(
  join(__dirname, "..", "components", "DesktopNavigationShell.tsx"),
  "utf8",
);
const globals = readFileSync(
  join(__dirname, "..", "app", "globals.css"),
  "utf8",
);
const profileMenu = readFileSync(
  join(__dirname, "..", "components", "ProfileMobileHeader.tsx"),
  "utf8",
);

describe("profile navigation breakpoint contract", () => {
  test("keeps the profile menu until the shared desktop rail appears", () => {
    const menuBreakpoint = profilePage.match(
      /<div className="([a-z]+):hidden mb-6">\s*<ProfileMobileHeader\b/,
    )?.[1];

    expect(menuBreakpoint).toBe("lg");
    expect(desktopShell).toContain('className="cn-desktop-nav"');
    expect(globals).toMatch(/@media \(min-width: 1024px\)\s*\{/);
  });

  test("switches all desktop profile header controls at the same breakpoint", () => {
    const desktopControls = [...profilePage.matchAll(
      /<div className="hidden ([a-z]+):(?:block|flex) absolute top-4/g,
    )];

    expect(desktopControls).toHaveLength(1);
    expect(desktopControls.every((match) => match[1] === "lg")).toBe(true);
    expect(profilePage).not.toContain("<BackButton");
    expect(profilePage).toContain("<ProfileDesktopMenu userId={user.id} />");
  });

  test("reuses the existing menu and sign-out flow", () => {
    expect(profilePage.match(/<ProfileMobileHeader\b/g)).toHaveLength(1);
    expect(profileMenu).toContain('aria-label="Open profile menu"');
    expect(profileMenu).toContain("await signOutThisDevice(supabase)");
    expect(profileMenu).toContain('window.location.href = "/auth"');
  });
});
