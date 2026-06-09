import React from "react";

export type IconName =
  | "plus"
  | "trash"
  | "close"
  | "refresh"
  | "folder"
  | "file"
  | "files"
  | "code"
  | "settings"
  | "bolt"
  | "brain"
  | "wand"
  | "layers"
  | "panel"
  | "play"
  | "record"
  | "stop"
  | "search"
  | "ssh"
  | "grip"
  | "chevron-left"
  | "chevron-right"
  | "chevron-down"
  | "download"
  | "upload"
  | "history"
  | "activity"
  | "globe"
  | "pin";

type IconProps = {
  name: IconName;
  size?: number;
  className?: string;
};

export const Icon = React.memo(function Icon({ name, size = 16, className }: IconProps) {
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
    case "globe":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
        </svg>
      );
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
    case "close":
      return (
        <svg {...common}>
          <path d="M18 6L6 18" />
          <path d="M6 6l12 12" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 3v6h-6" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
      );
    case "file":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    case "files":
      return (
        <svg {...common}>
          <path d="M8 6h13" />
          <path d="M8 12h13" />
          <path d="M8 18h13" />
          <path d="M3 6h1" />
          <path d="M3 12h1" />
          <path d="M3 18h1" />
        </svg>
      );
    case "code":
      return (
        <svg {...common}>
          <path d="M8 7l-5 5 5 5" />
          <path d="M16 7l5 5-5 5" />
          <path d="M14 4l-4 16" />
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
    case "brain":
      return (
        <svg {...common}>
          <path d="M12 2a6 6 0 0 0-5.2 3A5 5 0 0 0 4 14.8V16a2 2 0 0 0 2 2h2v4h8v-4h2a2 2 0 0 0 2-2v-1.2A5 5 0 0 0 17.2 5 6 6 0 0 0 12 2z" />
          <path d="M12 2v8" />
          <path d="M8 10h8" />
        </svg>
      );
    case "wand":
      return (
        <svg {...common}>
          <path d="M12 4v16" />
          <path d="M4 12h16" />
          <path d="M6 6l12 12" />
          <path d="M18 6L6 18" />
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
    case "grip":
      return (
        <svg {...common}>
          <circle cx="9" cy="7" r="1.25" fill="currentColor" stroke="none" />
          <circle cx="15" cy="7" r="1.25" fill="currentColor" stroke="none" />
          <circle cx="9" cy="12" r="1.25" fill="currentColor" stroke="none" />
          <circle cx="15" cy="12" r="1.25" fill="currentColor" stroke="none" />
          <circle cx="9" cy="17" r="1.25" fill="currentColor" stroke="none" />
          <circle cx="15" cy="17" r="1.25" fill="currentColor" stroke="none" />
        </svg>
      );
    case "chevron-left":
      return (
        <svg {...common}>
          <path d="M15 18l-6-6 6-6" />
        </svg>
      );
    case "chevron-right":
      return (
        <svg {...common}>
          <path d="M9 18l6-6-6-6" />
        </svg>
      );
    case "download":
      return (
        <svg {...common}>
          <path d="M12 5v10" />
          <path d="M8 13l4 4 4-4" />
          <path d="M5 19h14" />
        </svg>
      );
    case "upload":
      return (
        <svg {...common}>
          <path d="M12 19V9" />
          <path d="M8 11l4-4 4 4" />
          <path d="M5 19h14" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...common}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      );
    case "history":
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l4 2" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
          <path d="M12 4.5a7.5 7.5 0 0 1 7.5 7.5" />
          <path d="M12 19.5A7.5 7.5 0 0 1 4.5 12" />
          <path d="M5.4 6.2 7.6 8.4" />
          <path d="M16.4 15.6l2.2 2.2" />
        </svg>
      );
    case "pin":
      return (
        <svg {...common}>
          <path d="M9 4h6" />
          <path d="M10 4v5l-3 3v1h10v-1l-3-3V4" />
          <path d="M12 13v7" />
        </svg>
      );
    default:
      return null;
  }
});
