const mockStripeConstructor = jest.fn().mockImplementation(() => ({ testClient: true }));

jest.mock("stripe", () => ({
  __esModule: true,
  default: mockStripeConstructor,
}));

const originalEnvironment = process.env;

beforeEach(() => {
  jest.resetModules();
  mockStripeConstructor.mockClear();
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
});

afterAll(() => {
  process.env = originalEnvironment;
});

async function stripeClient() {
  return (await import("@/lib/stripeClient")).getStripe;
}

describe("Preview Stripe isolation", () => {
  test.each(["sk_live_not_a_real_key", "rk_live_not_a_real_key", "unrecognized-key"])(
    "rejects an unsafe Preview key before constructing a Stripe client: %s",
    async (key) => {
      process.env.STRIPE_SECRET_KEY = key;
      const getStripe = await stripeClient();
      expect(getStripe).toThrow("Stripe Preview deployments require a test-mode key.");
      expect(mockStripeConstructor).not.toHaveBeenCalled();
    },
  );

  test.each(["sk_test_not_a_real_key", "rk_test_not_a_real_key"])(
    "accepts supported test key prefixes and preserves client reuse: %s",
    async (key) => {
      process.env.STRIPE_SECRET_KEY = key;
      const getStripe = await stripeClient();
      expect(getStripe()).toBe(getStripe());
      expect(mockStripeConstructor).toHaveBeenCalledTimes(1);
      expect(mockStripeConstructor).toHaveBeenCalledWith(key, expect.objectContaining({
        timeout: 20_000,
        maxNetworkRetries: 2,
      }));
    },
  );

  test("preserves production live-key behavior", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.STRIPE_SECRET_KEY = "sk_live_not_a_real_key";
    const getStripe = await stripeClient();
    expect(() => getStripe()).not.toThrow();
    expect(mockStripeConstructor).toHaveBeenCalledTimes(1);
  });

  test("does not create a new requirement for non-Vercel environments", async () => {
    delete process.env.VERCEL_ENV;
    process.env.STRIPE_SECRET_KEY = "existing-local-test-value";
    const getStripe = await stripeClient();
    expect(() => getStripe()).not.toThrow();
  });

  test("preserves the missing-key failure without including a secret", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const getStripe = await stripeClient();
    expect(getStripe).toThrow("STRIPE_SECRET_KEY is not set in this environment.");
    expect(mockStripeConstructor).not.toHaveBeenCalled();
  });
});
