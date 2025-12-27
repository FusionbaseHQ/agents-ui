import React, { useState, useRef, useCallback, useEffect } from "react";

type SlidePanelProps = {
  isOpen: boolean;
  onClose: () => void;
  activeTab: "prompts" | "recordings" | "assets";
  onTabChange: (tab: "prompts" | "recordings" | "assets") => void;
  width: number;
  onWidthChange: (width: number) => void;
  children: React.ReactNode;
};

const MIN_WIDTH = 320;
const MAX_WIDTH = 500;

export function SlidePanel({
  isOpen,
  onClose,
  activeTab,
  onTabChange,
  width,
  onWidthChange,
  children,
}: SlidePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const panel = panelRef.current;
      const rightEdge = panel?.getBoundingClientRect().right ?? window.innerWidth;
      const newWidth = rightEdge - e.clientX;
      const clampedWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth));
      onWidthChange(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onWidthChange]);

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      className={`slidePanel ${isResizing ? "slidePanelResizing" : ""}`}
      style={{ width }}
    >
      <div className="slidePanelResize" onMouseDown={handleMouseDown} />
      <div className="slidePanelHeader">
        <div className="slidePanelTabs">
          <button
            className={`slidePanelTab ${activeTab === "prompts" ? "slidePanelTabActive" : ""}`}
            onClick={() => onTabChange("prompts")}
          >
            Prompts
          </button>
          <button
            className={`slidePanelTab ${activeTab === "recordings" ? "slidePanelTabActive" : ""}`}
            onClick={() => onTabChange("recordings")}
          >
            Recordings
          </button>
          <button
            className={`slidePanelTab ${activeTab === "assets" ? "slidePanelTabActive" : ""}`}
            onClick={() => onTabChange("assets")}
          >
            Assets
          </button>
        </div>
        <button className="slidePanelClose" onClick={onClose} title="Close panel">
          ×
        </button>
      </div>
      <div className="slidePanelContent">{children}</div>
    </div>
  );
}
