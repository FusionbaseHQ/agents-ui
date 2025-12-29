import React from "react";

export type IconName =
  | "plus"
  | "trash"
  | "settings"
  | "bolt"
  | "layers"
  | "panel"
  | "play"
  | "record"
  | "stop"
  | "search"
  | "ssh";

type IconProps = {
  name: IconName;
  size?: number;
  className?: string;
};

export function Icon({ name, size = 16, className }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
    focusable: false as const,
  };

  switch (name) {
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M4 7h16" />
          <path d="M10 11v7" />
          <path d="M14 11v7" />
          <path d="M6 7l1 14h10l1-14" />
          <path d="M9 7V4h6v3" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path d="M4 6h10" />
          <path d="M18 6h2" />
          <circle cx="16" cy="6" r="2" />

          <path d="M4 12h2" />
          <path d="M10 12h10" />
          <circle cx="8" cy="12" r="2" />

          <path d="M4 18h8" />
          <path d="M16 18h4" />
          <circle cx="14" cy="18" r="2" />
        </svg>
      );
    case "bolt":
      return (
        <svg {...common}>
          <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
        </svg>
      );
    case "layers":
      return (
        <svg {...common}>
          <path d="M12 4l8 4-8 4-8-4 8-4z" />
          <path d="M4 12l8 4 8-4" />
          <path d="M4 16l8 4 8-4" />
        </svg>
      );
    case "panel":
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M9 5v14" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <path d="M10 8l6 4-6 4V8z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "record":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "stop":
      return (
        <svg {...common}>
          <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
      );
    case "ssh":
      return (
        <svg {...common}>
          <path d="M7 8l5 4-5 4" />
          <path d="M15 16h5" />
        </svg>
      );
    default:
      return null;
  }
}
