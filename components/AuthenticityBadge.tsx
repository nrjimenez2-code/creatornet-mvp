/**
 * Blue "Authenticity verified" shield, shown next to a creator's display name.
 *
 * Pure presentational: a server-safe component with no client directive, no
 * hooks, no auth and no data access (a tripwire test enforces this). The
 * caller passes profiles.authenticity_verified_at, which ONLY
 * /api/admin/verification writes — never anything a browser can set.
 *
 * Deliberately distinct from components/VerifiedCreatorBadge.tsx (the PURPLE
 * "cleared to sell" check derived from Stripe): different colour (#2563EB),
 * different glyph (a shield, not a bare check), different label and title.
 * The two can sit side by side; they answer different questions.
 */

const BADGE_BLUE = "#2563EB";
const BADGE_SIZE_PX = { sm: 14, md: 18 } as const;

export const AUTHENTICITY_LABEL = "Authenticity verified";
export const AUTHENTICITY_TITLE =
  "CreatorNet confirmed this is the creator's real account";

type Props = {
  /** profiles.authenticity_verified_at — the badge renders only when set. */
  verifiedAt: string | null | undefined;
  size?: keyof typeof BADGE_SIZE_PX;
  className?: string;
};

export default function AuthenticityBadge({ verifiedAt, size = "md", className }: Props) {
  if (!verifiedAt) return null;
  const px = BADGE_SIZE_PX[size];
  return (
    <span
      role="img"
      aria-label={AUTHENTICITY_LABEL}
      title={AUTHENTICITY_TITLE}
      className={`inline-flex shrink-0 items-center justify-center rounded-full align-middle${className ? ` ${className}` : ""}`}
      style={{ width: px, height: px, backgroundColor: BADGE_BLUE }}
    >
      <svg
        viewBox="0 0 24 24"
        width={Math.round(px * 0.66)}
        height={Math.round(px * 0.66)}
        fill="none"
        stroke="#ffffff"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    </span>
  );
}
