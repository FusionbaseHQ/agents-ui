import React from "react";
import { Icon } from "./Icon";

export type ActivityCenterItem = {
  id: string;
  title: string;
  summary: string;
  tone: "info" | "warning" | "error";
  running?: boolean;
  details?: string[];
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  onDismiss?: () => void;
};

type Props = {
  menuRef: React.MutableRefObject<HTMLDivElement | null>;
  open: boolean;
  items: ActivityCenterItem[];
  onToggle: () => void;
};

export const ActivityCenter = React.memo(function ActivityCenter({
  menuRef,
  open,
  items,
  onToggle,
}: Props) {
  const runningCount = items.filter((item) => item.running).length;
  const badgeCount = runningCount;
  const buttonLabel =
    runningCount > 0
      ? `${runningCount} active task${runningCount === 1 ? "" : "s"}`
      : "Activity center";

  return (
    <div className="topbarSettingsMenu sidebarActionMenu activityCenterMenu" ref={menuRef}>
      <button
        type="button"
        className={`iconBtn activityCenterBtn ${open ? "iconBtnActive" : ""} ${
          runningCount > 0 ? "activityCenterBtnRunning" : ""
        }`}
        onClick={onToggle}
        title={buttonLabel}
        aria-label={buttonLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="activity" />
        {badgeCount > 0 ? (
          <span className="activityCenterBadge" aria-hidden="true">
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="sidebarActionMenuDropdown activityCenterDropdown" role="dialog" aria-label="Activity center">
          <div className="activityCenterHeader">
            <div className="topbarSettingsLabel">Activity</div>
            {runningCount > 0 ? (
              <div className="activityCenterRunningLabel">
                <span className="activityCenterRunningDot" aria-hidden="true" />
                <span>{runningCount} running</span>
              </div>
            ) : null}
          </div>

          {items.length === 0 ? (
            <div className="activityCenterEmpty">No current activity.</div>
          ) : (
            <div className="activityCenterList">
              {items.map((item) => (
                <div
                  key={item.id}
                  className={`activityCenterItem activityCenterItem-${item.tone} ${
                    item.running ? "activityCenterItemRunning" : ""
                  }`}
                >
                  <div className="activityCenterItemHeader">
                    <div className="activityCenterItemTitleRow">
                      <span className="activityCenterItemDot" aria-hidden="true" />
                      <span className="activityCenterItemTitle">{item.title}</span>
                    </div>
                    {item.onDismiss ? (
                      <button
                        type="button"
                        className="activityCenterItemClose"
                        onClick={item.onDismiss}
                        title="Dismiss"
                        aria-label="Dismiss"
                      >
                        <Icon name="close" size={12} />
                      </button>
                    ) : null}
                  </div>

                  <div className="activityCenterItemSummary" title={item.summary}>
                    {item.summary}
                  </div>

                  {item.details && item.details.length > 0 ? (
                    <div className="activityCenterItemDetails">
                      {item.details.map((detail, index) => (
                        <div key={`${item.id}-${index}`} className="activityCenterItemDetail" title={detail}>
                          {detail}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {item.actionLabel && item.onAction ? (
                    <div className="activityCenterItemActions">
                      <button
                        type="button"
                        className="btnSmall"
                        onClick={item.onAction}
                        disabled={item.actionDisabled}
                      >
                        {item.actionLabel}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});
