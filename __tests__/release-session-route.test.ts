import { NextRequest } from "next/server";
import { closedFeatures, SETTINGS_ID, type ReleaseSettings } from "@/lib/release/policy";

let mockSettings: ReleaseSettings | null;
const mockIdentity = jest.fn(), mockPrivateAccess = jest.fn();
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: (...args: unknown[]) => mockIdentity(...args) }));
jest.mock("@/lib/release/server", () => ({
  loadReleaseSettings: async () => mockSettings,
  hasPrivateAccess: (...args: unknown[]) => mockPrivateAccess(...args),
}));
import { dynamic, GET } from "@/app/api/release/session/route";

const originalFlag = process.env.PRIVATE_APPLE_SIGN_IN_ENABLED;
beforeEach(() => {
  jest.clearAllMocks(); delete process.env.PRIVATE_APPLE_SIGN_IN_ENABLED;
  mockSettings = { id: SETTINGS_ID, owner_id: "owner", hidden: true, features: closedFeatures(), discord_invite: null, public_page: "blank", revision: 7, updated_at: "now" };
  mockIdentity.mockResolvedValue(null); mockPrivateAccess.mockResolvedValue(false);
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.PRIVATE_APPLE_SIGN_IN_ENABLED;
  else process.env.PRIVATE_APPLE_SIGN_IN_ENABLED = originalFlag;
});
async function request() {
  const response = await GET(new NextRequest("https://creatornet.test/api/release/session"));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(dynamic).toBe("force-dynamic");
  return response.json();
}

test.each([undefined, "", "false", "TRUE", "True", " true", "true ", "1"])("default or nonliteral flag %p preserves the exact three-field response", async flag => {
  if (flag !== undefined) process.env.PRIVATE_APPLE_SIGN_IN_ENABLED = flag;
  expect(await request()).toEqual({ privateAccess: false, publicFeed: false, registrationOpen: false });
});

test("explicit true adds only the public UI capability under valid private settings", async () => {
  process.env.PRIVATE_APPLE_SIGN_IN_ENABLED = "true";
  expect(await request()).toEqual({ privateAccess: false, publicFeed: false, registrationOpen: false, privateAppleSignInEnabled: true });
});

test("missing or rejected settings cannot advertise private Apple even with the flag on", async () => {
  process.env.PRIVATE_APPLE_SIGN_IN_ENABLED = "true"; mockSettings = null;
  expect(await request()).toEqual({ privateAccess: false, publicFeed: false, registrationOpen: false });
});

test("public registration retains the original response and existing feed/access decisions", async () => {
  process.env.PRIVATE_APPLE_SIGN_IN_ENABLED = "true";
  mockSettings = { ...mockSettings!, hidden: false, features: { ...closedFeatures(), registration: true, feed: true } };
  const owner = { id: "owner" }; mockIdentity.mockResolvedValue(owner); mockPrivateAccess.mockResolvedValue(true);
  expect(await request()).toEqual({ privateAccess: true, publicFeed: true, registrationOpen: true });
  expect(mockPrivateAccess).toHaveBeenCalledWith(owner, mockSettings);
});

test("closed registration can expose Apple without changing a separately open feed", async () => {
  process.env.PRIVATE_APPLE_SIGN_IN_ENABLED = "true";
  mockSettings = { ...mockSettings!, hidden: false, features: { ...closedFeatures(), feed: true } };
  expect(await request()).toEqual({ privateAccess: false, publicFeed: true, registrationOpen: false, privateAppleSignInEnabled: true });
});

test("hidden overrides a saved registration flag before advertising private Apple", async () => {
  process.env.PRIVATE_APPLE_SIGN_IN_ENABLED = "true";
  mockSettings = { ...mockSettings!, features: { ...closedFeatures(), registration: true } };
  expect(await request()).toEqual({ privateAccess: false, publicFeed: false, registrationOpen: false, privateAppleSignInEnabled: true });
});

test("an auth lookup error still denies private access and exposes no identity", async () => {
  process.env.PRIVATE_APPLE_SIGN_IN_ENABLED = "true"; mockIdentity.mockRejectedValue(Error("unavailable"));
  expect(await request()).toEqual({ privateAccess: false, publicFeed: false, registrationOpen: false, privateAppleSignInEnabled: true });
  expect(mockPrivateAccess).not.toHaveBeenCalled();
});
