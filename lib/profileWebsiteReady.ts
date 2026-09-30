// Enable at build time only after the compatible migration and permission checks.
// This keeps Git-created Previews safe when they still point at an older schema.
export const profileWebsiteReady = () => process.env.NEXT_PUBLIC_PROFILE_WEBSITE_READY === "true";
export const profileWebsiteColumn = () => profileWebsiteReady() ? ", website_url" : "";

export type EditableProfile = {
  username: string | null; tagline: string | null; avatar_url: string | null;
  bio: string | null; website_url?: string | null;
};
export type ProfileHeader = EditableProfile & {
  id: string; full_name: string | null;
  stripe_account_id: string | null; stripe_onboarding_complete: boolean | null;
};
