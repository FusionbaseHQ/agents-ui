import React from "react";

type BadgeProps = {
  children: React.ReactNode;
  tone?: "accent" | "muted" | "outline" | "danger";
  title?: string;
};

/** Small inline tag chip (shell kinds, statuses, counts). */
export function Badge({ children, tone = "muted", title }: BadgeProps) {
  return (
    <span className={`uiBadge uiBadge-${tone}`} title={title}>
      {children}
    </span>
  );
}
