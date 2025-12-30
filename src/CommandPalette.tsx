import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import { Icon } from "./components/Icon";

type Prompt = {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  pinned?: boolean;
  pinOrder?: number;
};

type RecordingMeta = {
  schemaVersion: number;
  createdAt: number;
  name?: string | null;
  projectId: string;
  sessionPersistId: string;
  cwd: string | null;
  effectId?: string | null;
  bootstrapCommand?: string | null;
};

type RecordingIndexEntry = {
  recordingId: string;
  meta: RecordingMeta | null;
};

type Session = {
  id: string;
  name: string;
  command: string;
  cwd: string | null;
  projectId: string;
};

type QuickStartPreset = {
  id: string;
  title: string;
  command: string | null;
  iconSrc?: string | null;
};

type CommandItem = {
  id: string;
  type: "quickstart" | "prompt" | "recording" | "session" | "action";
  title: string;
  subtitle?: string;
  icon?: string;
  iconSrc?: string;
  iconAlt?: string;
  shortcut?: string;
  pinned?: boolean;
  data?: unknown;
};

type CommandPaletteProps = {
  isOpen: boolean;
  onClose: () => void;
  prompts: Prompt[];
  recordings: RecordingIndexEntry[];
  sessions: Session[];
  activeSessionId: string | null;
  quickStarts?: QuickStartPreset[];
  onQuickStart?: (preset: QuickStartPreset) => void;
  onSendPrompt: (prompt: Prompt, mode: "paste" | "send") => void;
  onEditPrompt: (prompt: Prompt) => void;
  onOpenRecording: (recordingId: string, mode: "step" | "all") => void;
  onSwitchSession: (sessionId: string) => void;
  onNewSession: () => void;
  onOpenSshManager: () => void;
  onNewPrompt: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onOpenSecureStorageSettings: () => void;
  isRecording: boolean;
  onOpenPromptsPanel: () => void;
  onOpenRecordingsPanel: () => void;
  onOpenAssetsPanel: () => void;
};

function fuzzyMatch(text: string, query: string): { match: boolean; score: number } {
  if (!query) return { match: true, score: 0 };

  const textLower = text.toLowerCase();
  const queryLower = query.toLowerCase();

  // Exact match gets highest score
  if (textLower === queryLower) return { match: true, score: 100 };

  // Starts with gets high score
  if (textLower.startsWith(queryLower)) return { match: true, score: 90 };

  // Contains gets medium score
  if (textLower.includes(queryLower)) return { match: true, score: 70 };

  // Fuzzy match: all query chars must appear in order
  let queryIndex = 0;
  let consecutiveMatches = 0;
  let maxConsecutive = 0;

  for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
    if (textLower[i] === queryLower[queryIndex]) {
      queryIndex++;
      consecutiveMatches++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveMatches);
    } else {
      consecutiveMatches = 0;
    }
  }

  if (queryIndex === queryLower.length) {
    return { match: true, score: 30 + maxConsecutive * 5 };
  }

  return { match: false, score: 0 };
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function CommandPalette({
  isOpen,
  onClose,
  prompts,
  recordings,
  sessions,
  activeSessionId,
  quickStarts,
  onQuickStart,
  onSendPrompt,
  onEditPrompt,
  onOpenRecording,
  onSwitchSession,
  onNewSession,
  onOpenSshManager,
  onNewPrompt,
  onStartRecording,
  onStopRecording,
  onOpenSecureStorageSettings,
  isRecording,
  onOpenPromptsPanel,
  onOpenRecordingsPanel,
  onOpenAssetsPanel,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build unified command items
  const allItems = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];

    // Pinned prompts first (with shortcuts)
    const pinnedPrompts = prompts
      .filter(p => p.pinned)
      .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0))
      .slice(0, 5);

    pinnedPrompts.forEach((p, i) => {
      items.push({
        id: `prompt-${p.id}`,
        type: "prompt",
        title: p.title,
        subtitle: p.content.split("\n")[0].slice(0, 60),
        icon: "star",
        shortcut: `${i + 1}`,
        pinned: true,
        data: p,
      });
    });

    // Unpinned prompts
    prompts
      .filter(p => !p.pinned)
      .sort((a, b) => b.createdAt - a.createdAt)
      .forEach(p => {
        items.push({
          id: `prompt-${p.id}`,
          type: "prompt",
          title: p.title,
          subtitle: p.content.split("\n")[0].slice(0, 60),
          data: p,
        });
      });

    // Recent recordings (top 5)
    recordings.slice(0, 5).forEach(r => {
      const meta = r.meta;
      items.push({
        id: `recording-${r.recordingId}`,
        type: "recording",
        title: meta?.name || r.recordingId.slice(0, 8),
        subtitle: meta ? formatTimeAgo(meta.createdAt) : undefined,
        icon: "recording",
        data: r,
      });
    });

    // Active sessions
    sessions.forEach(s => {
      items.push({
        id: `session-${s.id}`,
        type: "session",
        title: s.name,
        subtitle: s.command || s.cwd || undefined,
        icon: s.id === activeSessionId ? "active" : "session",
        data: s,
      });
    });

    // Quick starts
    (quickStarts ?? []).forEach((preset) => {
      items.push({
        id: `quickstart-${preset.id}`,
        type: "quickstart",
        title: `New ${preset.title}`,
        subtitle: preset.command ? `Runs: ${preset.command}` : "Runs: $SHELL",
        icon: preset.iconSrc ? "active" : "plus",
        iconSrc: preset.iconSrc ?? undefined,
        iconAlt: preset.title,
        data: preset,
      });
    });

    // Actions
    items.push({
      id: "action-new-session",
      type: "action",
      title: "New Session",
      icon: "plus",
      shortcut: "T",
    });

    items.push({
      id: "action-ssh-connect",
      type: "action",
      title: "SSH Connect",
      icon: "ssh",
    });

    items.push({
      id: "action-new-prompt",
      type: "action",
      title: "New Prompt",
      icon: "plus",
    });

    items.push({
      id: isRecording ? "action-stop-recording" : "action-start-recording",
      type: "action",
      title: isRecording ? "Stop Recording" : "Start Recording",
      icon: "recording",
    });

    items.push({
      id: "action-open-prompts",
      type: "action",
      title: "Open Prompts Panel",
      icon: "panel",
      shortcut: "Shift+P",
    });

    items.push({
      id: "action-open-recordings",
      type: "action",
      title: "Open Recordings Panel",
      icon: "panel",
      shortcut: "Shift+R",
    });

    items.push({
      id: "action-open-assets",
      type: "action",
      title: "Open Assets Panel",
      icon: "panel",
      shortcut: "Shift+A",
    });

    items.push({
      id: "action-secure-storage",
      type: "action",
      title: "Secure Storage Settings",
      icon: "settings",
    });

    return items;
  }, [prompts, recordings, sessions, activeSessionId, isRecording, quickStarts]);

  // Filter and sort by query
  const filteredItems = useMemo(() => {
    if (!query.trim()) return allItems;

    return allItems
      .map(item => ({
        item,
        ...fuzzyMatch(item.title, query),
      }))
      .filter(r => r.match)
      .sort((a, b) => b.score - a.score)
      .map(r => r.item);
  }, [allItems, query]);

  // Group items by type
  const groupedItems = useMemo(() => {
    const groups: { label: string; items: CommandItem[] }[] = [];

    const quickStartItems = filteredItems.filter(i => i.type === "quickstart");
    const promptItems = filteredItems.filter(i => i.type === "prompt");
    const recordingItems = filteredItems.filter(i => i.type === "recording");
    const sessionItems = filteredItems.filter(i => i.type === "session");
    const actionItems = filteredItems.filter(i => i.type === "action");

    if (quickStartItems.length) groups.push({ label: "New Sessions", items: quickStartItems });
    if (promptItems.length) groups.push({ label: "Prompts", items: promptItems });
    if (recordingItems.length) groups.push({ label: "Recordings", items: recordingItems });
    if (sessionItems.length) groups.push({ label: "Sessions", items: sessionItems });
    if (actionItems.length) groups.push({ label: "Actions", items: actionItems });

    return groups;
  }, [filteredItems]);

  const displayedItems = useMemo(() => groupedItems.flatMap((g) => g.items), [groupedItems]);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [displayedItems]);

  // Focus input on open
  useLayoutEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector("[data-selected='true']");
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const executeItem = useCallback((item: CommandItem) => {
    onClose();

    switch (item.type) {
      case "quickstart": {
        const preset = item.data as QuickStartPreset;
        onQuickStart?.(preset);
        break;
      }
      case "prompt": {
        const prompt = item.data as Prompt;
        onSendPrompt(prompt, "send");
        break;
      }
      case "recording": {
        const recording = item.data as RecordingIndexEntry;
        onOpenRecording(recording.recordingId, "step");
        break;
      }
      case "session": {
        const session = item.data as Session;
        onSwitchSession(session.id);
        break;
      }
      case "action": {
        switch (item.id) {
          case "action-new-session":
            onNewSession();
            break;
          case "action-ssh-connect":
            onOpenSshManager();
            break;
          case "action-new-prompt":
            onNewPrompt();
            break;
          case "action-start-recording":
            onStartRecording();
            break;
          case "action-stop-recording":
            onStopRecording();
            break;
          case "action-open-prompts":
            onOpenPromptsPanel();
            break;
          case "action-open-recordings":
            onOpenRecordingsPanel();
            break;
          case "action-open-assets":
            onOpenAssetsPanel();
            break;
          case "action-secure-storage":
            onOpenSecureStorageSettings();
            break;
        }
        break;
      }
    }
  }, [onClose, onSendPrompt, onOpenRecording, onSwitchSession, onNewSession, onOpenSshManager, onNewPrompt, onStartRecording, onStopRecording, onOpenSecureStorageSettings, onOpenPromptsPanel, onOpenRecordingsPanel, onOpenAssetsPanel, onQuickStart]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, displayedItems.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (displayedItems[selectedIndex]) {
          executeItem(displayedItems[selectedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          const pinnedIndex = parseInt(e.key) - 1;
          const pinnedPrompts = prompts.filter(p => p.pinned).sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
          if (pinnedPrompts[pinnedIndex]) {
            onClose();
            onSendPrompt(pinnedPrompts[pinnedIndex], "send");
          }
        }
        break;
    }
  }, [displayedItems, selectedIndex, executeItem, onClose, prompts, onSendPrompt]);

  if (!isOpen) return null;

  const getIcon = (item: CommandItem): React.ReactNode => {
    switch (item.icon) {
      case "star": return "\u2605";
      case "recording": return <Icon name="record" />;
      case "plus": return <Icon name="plus" />;
      case "panel": return <Icon name="panel" />;
      case "settings": return <Icon name="settings" />;
      case "active": return "\u25CF";
      case "session": return "\u25CB";
      case "ssh": return <Icon name="ssh" />;
      default: return "\u25CB";
    }
  };

  let flatIndex = 0;

  return (
    <div className="commandPaletteBackdrop" onClick={onClose}>
      <div className="commandPalette" onClick={e => e.stopPropagation()}>
        <div className="commandPaletteSearch">
          <span className="commandPaletteSearchIcon">&gt;</span>
          <input
            ref={inputRef}
            className="commandPaletteInput"
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search prompts, recordings, sessions..."
          />
        </div>
        <div className="commandPaletteList" ref={listRef}>
          {groupedItems.length === 0 && (
            <div className="commandPaletteEmpty">No results found</div>
          )}
          {groupedItems.map(group => (
            <div key={group.label} className="commandPaletteGroup">
              <div className="commandPaletteGroupLabel">{group.label}</div>
              {group.items.map(item => {
                const isSelected = flatIndex === selectedIndex;
                const currentIndex = flatIndex;
                flatIndex++;
                return (
                  <div
                    key={item.id}
                    className={`commandPaletteItem ${isSelected ? "commandPaletteItemSelected" : ""}`}
                    data-selected={isSelected}
                    onClick={() => executeItem(item)}
                    onMouseEnter={() => setSelectedIndex(currentIndex)}
                  >
                    <span className={`commandPaletteItemIcon ${item.icon === "star" ? "iconPinned" : ""} ${item.icon === "recording" ? "iconRecording" : ""} ${item.icon === "active" ? "iconActive" : ""}`}>
                      {item.iconSrc ? (
                        <img
                          className="commandPaletteItemIconImg"
                          src={item.iconSrc}
                          alt=""
                          aria-hidden="true"
                        />
                      ) : (
                        getIcon(item)
                      )}
                    </span>
                    <div className="commandPaletteItemContent">
                      <div className="commandPaletteItemTitle">{item.title}</div>
                      {item.subtitle && (
                        <div className="commandPaletteItemSubtitle">{item.subtitle}</div>
                      )}
                    </div>
                    {item.shortcut && (
                      <span className="commandPaletteItemShortcut">
                        {item.shortcut.includes("Shift") ? `\u2318${item.shortcut}` : `\u2318${item.shortcut}`}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="commandPaletteFooter">
          <span className="commandPaletteHint">
            <kbd>\u2191</kbd><kbd>\u2193</kbd> navigate
            <kbd>\u21B5</kbd> select
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
