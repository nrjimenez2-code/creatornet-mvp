const mockCreate = jest.fn().mockReturnValue({ auth: {} });
jest.mock("@supabase/supabase-js", () => ({ createClient: (...args: unknown[]) => mockCreate(...args), AuthError: class extends Error {} }));
test("blocked browser storage preserves ordinary SDK fallback and refuses unsafe MFA setup", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co/";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-public";
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage() { throw Error("Storage unavailable"); } } });
  try {
    await jest.isolateModulesAsync(async () => {
      const factory = await import("@/lib/supabaseClient");
      expect(factory.createClient()).toBeTruthy();
      expect(mockCreate.mock.calls[0][2].auth.storage).toBeUndefined();
      expect(() => factory.runMfaAction("fixture-token", async () => {})).toThrow("requires browser storage");
    });
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
