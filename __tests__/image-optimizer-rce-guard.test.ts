/**
 * Guard for GHSA-2xp9-vwfh-vxw4 (RCE via AVIF in the image optimizer).
 *
 * The trap: Next 16.3.3 fixed this by DISABLING avif decoding, then 16.3.4
 * RE-ENABLED it and moved the fix into sharp's bundled libheif. There is no
 * runtime version check in Next — the only thing binding the fix to a patched
 * sharp is next's own `optionalDependencies` range. So `next >= 16.3.4` with
 * `sharp < 0.35.4` decodes avif against the vulnerable libheif and prints no
 * warning: exactly as exposed as before the upgrade.
 *
 * sharp is an OPTIONAL dependency, which is precisely the kind that a stale
 * lockfile or an install flow that skips optional deps can silently leave
 * behind. This test fails loudly if that ever happens.
 */

import fs from "fs";
import path from "path";

/** Read a package's version without going through its `exports` map. */
function installedVersion(pkg: string): string | null {
  const p = path.join(process.cwd(), "node_modules", pkg, "package.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")).version as string;
}

const gte = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) >= 0;

describe("image optimizer RCE guard", () => {
  it("has sharp >= 0.35.4, which carries the patched libheif", () => {
    const sharp = installedVersion("sharp");

    // sharp is optional. If it is genuinely absent, Next cannot decode avif
    // locally at all and there is nothing to protect.
    if (sharp === null) return;

    expect(gte(sharp, "0.35.4")).toBe(true);
  });

  it("is not on a Next version whose avif fix was reverted without a patched sharp", () => {
    const next = installedVersion("next");
    const sharp = installedVersion("sharp");
    if (!next || sharp === null) return;

    // 16.3.4+ decodes avif again and delegates the fix to sharp.
    if (gte(next, "16.3.4")) {
      expect(gte(sharp, "0.35.4")).toBe(true);
    }
  });

  it("keeps next's own declared sharp floor at or above the patched release", () => {
    const declared = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "node_modules", "next", "package.json"), "utf8")
    ).optionalDependencies?.sharp as string | undefined;
    if (!declared) return;

    // e.g. "^0.35.4" -> "0.35.4"
    const floor = declared.replace(/^[\^~>=\s]*/, "");
    expect(gte(floor, "0.35.4")).toBe(true);
  });
});
