type Environment = Record<string, string | undefined>;
type Binding = { id: string; fingerprint: string };
type DeploymentConfiguration = { env: Record<string, string>; [key: string]: unknown };
type PaymentContext = Readonly<{
  apiVersion: string; mode: 'test'; stripeAccountId: string;
  supabaseProjectRef: string; siteOrigin: string;
}>;
declare const completion: {
  PROFILE: string;
  CONTEXT: PaymentContext;
  enabledGates: readonly string[];
  prepareConfiguration(base: DeploymentConfiguration, bindings: readonly Binding[]): DeploymentConfiguration;
  validateConfiguration(env: Environment, gateNames: readonly string[]): readonly Readonly<Binding>[];
  checkIdentity(env: Environment, gateNames: readonly string[], fetcher?: typeof fetch): Promise<Record<string, unknown>>;
  readRuntimeIdentity(request: Request, env: Environment, gateNames: readonly string[], fetcher?: typeof fetch): Promise<Response>;
};
export = completion;
