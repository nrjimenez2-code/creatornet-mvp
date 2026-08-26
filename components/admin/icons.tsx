import type { SVGProps } from "react";

/**
 * Admin Launch Board icon set — hand-drawn 24px stroke icons so the board has
 * one consistent visual language (stroke 1.8, round caps, currentColor).
 * Kept separate from src/components/icons.tsx (auth-page brand SVGs).
 */

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function base({ size = 16, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export function IconGrid(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    </svg>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M3.5 19.5c.7-3.1 2.9-4.8 5.5-4.8s4.8 1.7 5.5 4.8" />
      <path d="M15.4 5.2a3.4 3.4 0 0 1 0 5.6" />
      <path d="M17.6 14.9c1.6.6 2.6 2 3 4" />
    </svg>
  );
}

export function IconPlaySquare(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M10 8.8v6.4l5.4-3.2Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconCard(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.8" y="5.5" width="18.4" height="13" rx="2.6" />
      <path d="M2.8 9.8h18.4" />
      <path d="M6.5 14.8h4" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  );
}

export function IconFlag(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5.5 21V4.2" />
      <path d="M5.5 4.6c4.6-2.4 8.4 2.2 13-.2v9.2c-4.6 2.4-8.4-2.2-13 .2" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m4.5 12.8 4.6 4.6L19.5 6.6" />
    </svg>
  );
}

export function IconCheckCircle(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="m8.4 12.4 2.5 2.5 4.9-5.2" />
    </svg>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 4.5 20 19.5" />
      <path d="M9.9 6.1A8.9 8.9 0 0 1 12 5.9c4.4 0 7.7 3 9.2 6.1a11.4 11.4 0 0 1-3 3.9M6.2 7.6a11.6 11.6 0 0 0-3.4 4.4c1.5 3.1 4.8 6.1 9.2 6.1 1.1 0 2.1-.2 3-.5" />
      <path d="M10 10.2a2.8 2.8 0 0 0 3.9 4" />
    </svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V4.8c0-.7.6-1.3 1.3-1.3h3.4c.7 0 1.3.6 1.3 1.3v1.7" />
      <path d="M6.3 6.5 7 19c.1 1 .8 1.6 1.8 1.6h6.4c1 0 1.7-.6 1.8-1.6l.7-12.5" />
      <path d="M10 10.5v6M14 10.5v6" />
    </svg>
  );
}

export function IconX(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 12h15" />
      <path d="m13.5 6 6 6-6 6" />
    </svg>
  );
}

export function IconBolt(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12.8 3 5.5 13.4h5l-1.3 7.6L16.5 10.6h-5z" />
    </svg>
  );
}

export function IconDollar(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.5v17" />
      <path d="M16.4 7.2c-.7-1.3-2.3-2-4.2-2-2.3 0-4 1.2-4 3 0 4 8.4 2 8.4 6.2 0 1.9-1.9 3.1-4.4 3.1-2.1 0-3.8-.9-4.5-2.3" />
    </svg>
  );
}

export function IconUserPlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="8" r="3.4" />
      <path d="M4 19.6c.7-3.1 3-4.8 6-4.8 1.5 0 2.9.4 3.9 1.3" />
      <path d="M18.5 13.5v6M15.5 16.5h6" />
    </svg>
  );
}

export function IconCalendar(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.6" />
      <path d="M3.5 9.6h17M8 3v3.4M16 3v3.4" />
      <path d="m9.5 14.6 1.8 1.8 3.4-3.6" />
    </svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4 2.8 19.5h18.4Z" />
      <path d="M12 10v4.2" />
      <circle cx="12" cy="16.9" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconStar(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path
        d="m12 3.6 2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.2 6.9 19l1.1-5.6-4.2-3.9 5.7-.7Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export function IconBan(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M5.9 5.9 18.1 18.1" />
    </svg>
  );
}

export function IconCommand(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 9h6v6H9z" />
      <path d="M9 9H7a2 2 0 1 1 2-2Zm6 0h2a2 2 0 1 0-2-2Zm0 6h2a2 2 0 1 1-2 2Zm-6 0H7a2 2 0 1 0 2 2Z" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m9 5.5 6.5 6.5L9 18.5" />
    </svg>
  );
}

export function IconShieldCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.2 5 5.8v5.4c0 4.4 2.9 7.6 7 9.6 4.1-2 7-5.2 7-9.6V5.8Z" />
      <path d="m8.8 11.8 2.3 2.3 4.1-4.4" />
    </svg>
  );
}

export function IconInbox(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 4.8h16v14.4H4z" opacity="0" />
      <path d="M20 13.2V17a2.4 2.4 0 0 1-2.4 2.4H6.4A2.4 2.4 0 0 1 4 17v-3.8" />
      <path d="M4 13.2h4.4l1.4 2.4h4.4l1.4-2.4H20" />
      <path d="m6 13.2 1.6-7c.2-.9.9-1.4 1.8-1.4h5.2c.9 0 1.6.5 1.8 1.4l1.6 7" />
    </svg>
  );
}
