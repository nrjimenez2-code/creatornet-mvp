/** @jest-environment jsdom */
import { authDiagnosticStorage, startAuthTrace, traceAuth } from "@/lib/authDiagnostics";

test("opt-in auth tracing projects metadata without credentials or raw provider data", () => {
  sessionStorage.setItem("cn.auth.trace", "1");
  const info = jest.spyOn(console, "info").mockImplementation(() => {});
  try {
    traceAuth(Object.assign({ operation: "fixture", phase: "event" as const, hasSession: true }, { session: { access_token: "ACCESS_SENTINEL", refresh_token: "REFRESH_SENTINEL" }, provider: "PRIVATE_SENTINEL" }));
    const finish = startAuthTrace("fixture-operation");
    finish({ status: 200 });
    const serialized = JSON.stringify(info.mock.calls);
    for (const value of ["ACCESS_SENTINEL", "REFRESH_SENTINEL", "PRIVATE_SENTINEL"]) expect(serialized).not.toContain(value);
    const projected = JSON.parse(info.mock.calls[0][1]);
    expect(projected).toMatchObject({ operation: "fixture", hasSession: true, tabId: expect.any(String), at: expect.any(Number) });
    expect(finish.headers["X-CN-Auth-Operation"]).toMatch(/^fixture-operation:/);
    expect(finish.headers["X-CN-Auth-Tab"]).toBe(projected.tabId);
  } finally { sessionStorage.clear(); info.mockRestore(); }
});

test("disabled tracing adds no logs or request headers", () => {
  const info = jest.spyOn(console, "info").mockImplementation(() => {});
  try {
    const finish = startAuthTrace("disabled"); finish();
    expect(finish.headers).toEqual({});
    expect(info).not.toHaveBeenCalled();
  } finally { info.mockRestore(); }
});

describe("temporary staging race controls", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = "sb-nwqfofezfzljhxolkycz-auth-token";
  const raw = JSON.stringify({ access_token: "ACCESS", refresh_token: "REFRESH", expires_at: 9999999999 });
  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear();
    window.history.replaceState({}, "", "/?authTrace=1&authExpireOnce=fixture&authCallbackDelayMs=99000");
    localStorage.setItem(key, raw);
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    window.history.replaceState({}, "", "/");
    sessionStorage.clear(); localStorage.clear();
    jest.restoreAllMocks();
  });
  test("Production binding cannot inject expiry or callback delay", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://rvkqxgghqitkwzdsuclz.supabase.co";
    jest.spyOn(console, "info").mockImplementation(() => {});
    expect(authDiagnosticStorage.getItem(key)).toBe(raw);
    expect(startAuthTrace("cookie-sync-SIGNED_IN").headers["X-CN-Auth-Delay"]).toBeUndefined();
  });
  test("Staging injection preserves credentials, runs once, and caps callback delay", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://nwqfofezfzljhxolkycz.supabase.co";
    jest.spyOn(console, "info").mockImplementation(() => {});
    const injected = JSON.parse(authDiagnosticStorage.getItem(key)!);
    expect(injected).toMatchObject({ access_token: "ACCESS", refresh_token: "REFRESH" });
    expect(injected.expires_at).toBeLessThan(Date.now() / 1000);
    authDiagnosticStorage.setItem(key, raw);
    expect(authDiagnosticStorage.getItem(key)).toBe(raw);
    expect(startAuthTrace("cookie-sync-SIGNED_IN").headers["X-CN-Auth-Delay"]).toBe("5000");
  });
});
