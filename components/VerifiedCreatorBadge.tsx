/**
 * Purple "Verified creator" check, shown next to a creator's display name.
 *
 * Pure presentational: a server-safe component with no client directive, no
 * hooks, no auth and no data access (a tripwire test enforces this).
 * The caller decides `verified` — server components and service-role routes
 * derive it from lib/sellReady.ts#isSellReadyProfile (Stripe Connect
 * onboarding complete), never from anything a browser can write.
 *
 * Colour: brand purple #4A35C7. BLUE is deliberately reserved for a future,
 * separately-earned badge (e.g. identity/notability) so the two never blur.
 */

const BADGE_PURPLE = "#4A35C7";
const BADGE_SIZE_PX = { sm: 14, md: 18 } as const;

export const VERIFIED_CREATOR_LABEL = "Verified creator";
export const VERIFIED_CREATOR_TITLE =
  "Verified creator: identity and payouts confirmed through Stripe";

type Props = {
  verified: boolean;
  size?: keyof typeof BADGE_SIZE_PX;
  className?: string;
};

export default function VerifiedCreatorBadge({ verified, size = "md", className }: Props) {
  if (!verified) return null;
  const px = BADGE_SIZE_PX[size];
  return (
    <span
      role="img"
      aria-label={VERIFIED_CREATOR_LABEL}
      title={VERIFIED_CREATOR_TITLE}
      className={`inline-flex shrink-0 items-center justify-center rounded-full align-middle${className ? ` ${className}` : ""}`}
      style={{ width: px, height: px, backgroundColor: BADGE_PURPLE }}
    >
      <svg
        viewBox="0 0 24 24"
        width={Math.round(px * 0.7)}
        height={Math.round(px * 0.7)}
        fill="none"
        stroke="#ffffff"
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}
