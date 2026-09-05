import { readFileSync } from "fs";
import { join } from "path";

const profilePage = readFileSync(
  join(__dirname, "..", "app", "profile", "page.tsx"),
  "utf8",
);
const dashboardPage = readFileSync(
  join(__dirname, "..", "app", "dashboard", "page.tsx"),
  "utf8",
);
const profileMenu = readFileSync(
  join(__dirname, "..", "components", "ProfileMobileHeader.tsx"),
  "utf8",
);

describe("profile navigation breakpoint contract", () => {
  test("keeps the existing profile menu until the dashboard sidebar appears", () => {
    const sidebarBreakpoint = dashboardPage.match(
      /<aside className="hidden ([a-z]+):block\b/,
    )?.[1];
    const menuBreakpoint = profilePage.match(
      /<div className="([a-z]+):hidden mb-6">\s*<ProfileMobileHeader\b/,
    )?.[1];

    expect(sidebarBreakpoint).toBe("lg");
    expect(menuBreakpoint).toBe(sidebarBreakpoint);
  });

  test("switches all desktop profile header controls at the same breakpoint", () => {
    const desktopControls = [...profilePage.matchAll(
      /<div className="hidden ([a-z]+):(?:block|flex) absolute top-4/g,
    )];

    expect(desktopControls).toHaveLength(3);
    expect(desktopControls.every((match) => match[1] === "lg")).toBe(true);
  });

  test("reuses the existing menu and sign-out flow", () => {
    expect(profilePage.match(/<ProfileMobileHeader\b/g)).toHaveLength(1);
    expect(profileMenu).toContain('aria-label="Open profile menu"');
    expect(profileMenu).toContain("await supabase.auth.signOut()");
    expect(profileMenu).toContain('window.location.href = "/auth"');
  });
});
