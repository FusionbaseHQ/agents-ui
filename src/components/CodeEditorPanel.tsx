import "../monaco/monacoEnv";
import { invoke } from "@tauri-apps/api/core";
import Editor, { loader } from "@monaco-editor/react";
import * as bundledMonaco from "monaco-editor";
import React from "react";
import { shortenPathSmart } from "../pathDisplay";
import { Icon } from "./Icon";
import { ConfirmActionModal } from "./modals/ConfirmActionModal";
import { concatBytes } from "../fileViewer/bytes";
import { useChunkCache } from "../fileViewer/useChunkCache";

type MonacoType = typeof import("monaco-editor");

export type CodeEditorOpenFileRequest = { path: string; nonce: number; mode?: CodeEditorOpenMode };

loader.config({ monaco: bundledMonaco });

export type CodeEditorPanelHandle = {
  openFind: () => boolean;
  workspaceSnapshot: () => CodeEditorWorkspaceSnapshot;
  openWorkspaceTab: (input: CodeEditorOpenWorkspaceTabInput) => Promise<CodeEditorWorkspaceTab>;
  focusWorkspaceTab: (input: { tabId?: string | null; path?: string | null }) => CodeEditorWorkspaceTab;
  closeWorkspaceTab: (input: { tabId?: string | null; path?: string | null; force?: boolean }) => CodeEditorWorkspaceTab;
  browserNavigate: (input: { tabId?: string | null; url: string; activate?: boolean }) => Promise<CodeEditorWorkspaceTab>;
  browserAction: (input: { tabId?: string | null; action: "back" | "forward" | "reload" }) => Promise<CodeEditorWorkspaceTab>;
  browserSnapshot: (input?: { tabId?: string | null }) => CodeEditorBrowserSnapshot;
  fileViewerSnapshot: (input?: { tabId?: string | null; path?: string | null; maxContentLength?: number }) => CodeEditorFileViewerSnapshot;
};

export type CodeEditorOpenMode = "auto" | "text" | "image" | "bytes" | "markdown" | "json" | "csv";
type ViewerKind = "text" | "largeText" | "image" | "bytes" | "pdf" | "markdown" | "json" | "csv" | "browser";

export type CodeEditorOpenWorkspaceTabInput = {
  kind?: "file" | "browser";
  path?: string | null;
  url?: string | null;
  title?: string | null;
  mode?: CodeEditorOpenMode;
};

export type CodeEditorOpenWorkspaceTabRequest = CodeEditorOpenWorkspaceTabInput & {
  nonce: number;
};

export type CodeEditorWorkspaceTab = {
  id: string;
  kind: "file" | "browser";
  title: string;
  active: boolean;
  path: string | null;
  url: string | null;
  label: string | null;
  viewerKind: ViewerKind | null;
  requestedMode: CodeEditorOpenMode;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  locked: boolean;
  size: number | null;
  mime: string | null;
  imageType: string | null;
};

export type CodeEditorWorkspaceSnapshot = {
  provider: "local" | "ssh";
  rootDir: string;
  activeTabId: string | null;
  activeFilePath: string | null;
  tabs: CodeEditorWorkspaceTab[];
};

export type CodeEditorBrowserSnapshot = {
  activeTabId: string | null;
  activeBrowserTabId: string | null;
  tabs: CodeEditorWorkspaceTab[];
};

export type CodeEditorFileViewerSnapshot = {
  tab: CodeEditorWorkspaceTab;
  contentAvailable: boolean;
  content: string | null;
  contentTruncated: boolean;
};

// Heavier / rarely-needed viewers load lazily — same approach as LazyCodeEditorPanel.
const LazyPdfViewer = React.lazy(() => import("../pdf/PdfViewer"));
const LazyMarkdownViewer = React.lazy(() => import("../fileViewer/MarkdownViewer"));
const LazyJsonTreeViewer = React.lazy(() => import("../fileViewer/JsonTreeViewer"));
const LazyCsvTableViewer = React.lazy(() => import("../fileViewer/CsvTableViewer"));
const LazyBrowserView = React.lazy(() => import("../browser/BrowserView"));

// Browser tabs aren't backed by a file; they use a synthetic, never-a-real-path
// key ("browser://<n>", never an absolute path) so the file-loading machinery skips them.
const BROWSER_PREFIX = "browser://";
const BROWSER_START_URL = "https://duckduckgo.com";
const isBrowserPath = (path: string) => path.startsWith(BROWSER_PREFIX);
function urlHost(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host || "Browser";
  } catch {
    return "Browser";
  }
}
function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("url is required");
  const candidate = trimmed.includes("://") || trimmed.startsWith("about:") ? trimmed : `https://${trimmed}`;
  // Validate early so API-driven browser opens fail at the call site instead of
  // later in the native child webview's layout loop.
  new URL(candidate);
  return candidate;
}
const isHtmlPath = (path: string) => /\.(x?html?|htm)$/i.test(path.trim());
// file:// URL for a local absolute path (spaces etc. percent-encoded, slashes kept).
const fileUrlForPath = (path: string) => `file://${encodeURI(path)}`;

type FileProbe = {
  size: number;
  mtimeMs?: number | null;
  kind: "text" | "image" | "binary" | string;
  imageType?: string | null;
  mime?: string | null;
  hasNul: boolean;
  validUtf8: boolean;
  isLargeText: boolean;
};

// Range reads return raw bytes (tauri::ipc::Response → ArrayBuffer). Callers
// derive EOF from a short read (bytes.length < requested length) and the file
// size they already hold; the backend clamps offset, so the requested offset is
// the chunk's start.
type ReadRangeFn = (path: string, offset: number, length: number) => Promise<Uint8Array>;

const EDITABLE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
const RANGE_CHUNK_BYTES = 256 * 1024;
const MAX_RANGE_BYTES = 1024 * 1024;
const MAX_VIEWER_CACHE_BYTES = 8 * 1024 * 1024;

export type CodeEditorPersistedTab = {
  path: string;
  dirty: boolean;
  content: string | null;
  viewerKind?: ViewerKind | null;
  locked?: boolean;
};

export type CodeEditorPersistedState = {
  tabs: CodeEditorPersistedTab[];
  activePath: string | null;
};

export type CodeEditorFsEvent =
  | { type: "rename"; from: string; to: string; nonce: number }
  | { type: "delete"; path: string; nonce: number };

type Tab = {
  path: string;
  title: string;
  viewerKind: ViewerKind | null;
  requestedMode: CodeEditorOpenMode;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  size: number | null;
  mime: string | null;
  imageType: string | null;
  locked: boolean;
};

type PendingCloseAction =
  | { kind: "editor" }
  | { kind: "tab"; path: string };

type TabMenuState = { x: number; y: number; path: string };

function basename(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return "/";
  const cleaned = trimmed.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function dirname(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return "/";
  const cleaned = trimmed.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  if (idx <= 0) return "/";
  return cleaned.slice(0, idx);
}

function emptyTab(path: string, requestedMode: CodeEditorOpenMode = "auto"): Tab {
  return {
    path,
    title: basename(path),
    viewerKind: null,
    requestedMode,
    dirty: false,
    loading: true,
    error: null,
    size: null,
    mime: null,
    imageType: null,
    locked: false,
  };
}

// Structured text formats only auto-open in their rich viewer when small enough
// to load whole; bigger files fall through to the editor / streamed text viewer.
const STRUCTURED_AUTO_MAX_BYTES = 8 * 1024 * 1024;

function autoStructuredKind(path: string): ViewerKind | null {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  // Only render-oriented formats auto-open in their rich viewer. JSON and code
  // files stay in the editor by default (JSON tree is available via "View as").
  if (ext === "md" || ext === "markdown" || ext === "mdown" || ext === "mkd" || ext === "mdx") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  return null;
}

function chooseViewerKind(probe: FileProbe, mode: CodeEditorOpenMode, path: string): ViewerKind {
  if (mode === "bytes") return "bytes";
  if (mode === "markdown") return "markdown";
  if (mode === "json") return "json";
  if (mode === "csv") return "csv";
  if (probe.kind === "pdf" && mode !== "text") return "pdf";
  if (mode === "image") return probe.kind === "image" ? "image" : "bytes";
  if (probe.kind === "image" && mode !== "text") return "image";
  if (probe.kind === "text" && probe.validUtf8 && !probe.hasNul) {
    // Auto-route .md/.json/.csv to their rich viewers (overridable to raw text
    // via "View as"); other text, or oversized structured files, stay editable.
    if (mode === "auto" && probe.size <= STRUCTURED_AUTO_MAX_BYTES) {
      const structured = autoStructuredKind(path);
      if (structured) return structured;
    }
    return probe.size <= EDITABLE_TEXT_MAX_BYTES ? "text" : "largeText";
  }
  return "bytes";
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let n = value / 1024;
  let idx = 0;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx += 1;
  }
  return `${n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[idx]}`;
}

function byteToAscii(byte: number): string {
  return byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".";
}

// Lazily-built indexes from Monaco's full language registry so any language
// Monaco ships (Dockerfile, GraphQL, Vue, C#, Swift, Terraform, Makefile, …) is
// recognized, not just the curated list below.
let monacoLangByExt: Map<string, string> | null = null;
let monacoLangByFilename: Map<string, string> | null = null;
function buildMonacoLangIndex(): void {
  monacoLangByExt = new Map();
  monacoLangByFilename = new Map();
  for (const lang of bundledMonaco.languages.getLanguages()) {
    for (const ext of lang.extensions ?? []) {
      const key = ext.replace(/^\./, "").toLowerCase();
      if (key && !monacoLangByExt.has(key)) monacoLangByExt.set(key, lang.id);
    }
    for (const filename of lang.filenames ?? []) {
      monacoLangByFilename.set(filename.toLowerCase(), lang.id);
    }
  }
}

function inferLanguageId(path: string): string {
  const name = basename(path);
  const lowerName = name.toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  // Curated preferred mappings first (e.g. tsx -> typescript, not the registry's
  // "typescriptreact" if that ever ships), then fall back to Monaco's registry.
  const preferred = preferredLanguageId(ext);
  if (preferred) return preferred;
  if (!monacoLangByExt || !monacoLangByFilename) buildMonacoLangIndex();
  return (
    monacoLangByFilename!.get(lowerName) ??
    (ext ? monacoLangByExt!.get(ext) : undefined) ??
    "plaintext"
  );
}

function preferredLanguageId(ext: string): string | null {
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "html":
    case "htm":
      return "html";
    case "md":
    case "markdown":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "go":
      return "go";
    case "java":
      return "java";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
      return "cpp";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "toml":
      return "toml";
    default:
      return null;
  }
}

type CodeEditorPanelProps = {
  provider: "local" | "ssh";
  editorTheme: "vs" | "vs-dark";
  sshTarget?: string | null;
  rootDir: string;
  openFileRequest: CodeEditorOpenFileRequest | null;
  openWorkspaceTabRequest?: CodeEditorOpenWorkspaceTabRequest | null;
  persistedState: CodeEditorPersistedState | null;
  fsEvent?: CodeEditorFsEvent | null;
  onPersistState: (state: CodeEditorPersistedState) => void;
  onConsumeOpenFileRequest?: () => void;
  onConsumeOpenWorkspaceTabRequest?: () => void;
  onActiveFilePathChange: (path: string | null) => void;
  onCloseEditor: () => void;
};

// Memoized so switching the active tab (or editing one) only re-renders the
// affected tabs, not the whole strip. Relies on stable onOpen/onClose/registerRef.
const EditorTab = React.memo(function EditorTab({
  tab,
  isActive,
  suffix,
  onOpen,
  onClose,
  registerRef,
  onContextMenu,
}: {
  tab: Tab;
  isActive: boolean;
  suffix: string;
  onOpen: (path: string) => void;
  onClose: (path: string) => void;
  registerRef: (path: string, el: HTMLButtonElement | null) => void;
  onContextMenu: (path: string, x: number, y: number) => void;
}) {
  return (
    <div
      className={`codeEditorTab ${isActive ? "codeEditorTabActive" : ""} ${tab.locked ? "codeEditorTabLocked" : ""}`}
      role="tab"
      aria-selected={isActive}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(tab.path, e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className="codeEditorTabMain"
        onClick={() => onOpen(tab.path)}
        onAuxClick={(e) => {
          if (e.button !== 1 || tab.locked) return;
          e.preventDefault();
          onClose(tab.path);
        }}
        ref={(el) => registerRef(tab.path, el)}
        title={tab.path}
      >
        <span className="codeEditorTabTitle">
          {tab.title}
          {suffix ? <span className="codeEditorTabTitleSuffix">{suffix}</span> : null}
        </span>
        {tab.dirty ? <span className="codeEditorTabDirty" aria-label="Unsaved changes" /> : null}
      </button>
      {tab.locked ? (
        <span className="codeEditorTabLock" title="Locked — right-click to unlock" aria-label="Locked tab">
          🔒
        </span>
      ) : (
        <button
          type="button"
          className="codeEditorTabClose"
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.path);
          }}
          title="Close"
          aria-label={`Close ${tab.title}`}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
});

export const CodeEditorPanel = React.forwardRef<CodeEditorPanelHandle, CodeEditorPanelProps>(function CodeEditorPanel(
  {
    provider,
    editorTheme,
    sshTarget,
    rootDir,
    openFileRequest,
    openWorkspaceTabRequest,
    persistedState,
    fsEvent,
    onPersistState,
    onConsumeOpenFileRequest,
    onConsumeOpenWorkspaceTabRequest,
    onActiveFilePathChange,
    onCloseEditor,
  }: CodeEditorPanelProps,
  ref,
) {
  const [tabs, setTabs] = React.useState<Tab[]>([]);
  const [activePath, setActivePath] = React.useState<string | null>(null);
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [pendingClose, setPendingClose] = React.useState<PendingCloseAction | null>(null);
  const [tabMenu, setTabMenu] = React.useState<TabMenuState | null>(null);
  const [saveConflictPath, setSaveConflictPath] = React.useState<string | null>(null);
  const [crossFindOpen, setCrossFindOpen] = React.useState(false);
  const [crossFind, setCrossFind] = React.useState("");
  const [crossReplace, setCrossReplace] = React.useState("");
  const [crossCase, setCrossCase] = React.useState(false);
  const [crossStatus, setCrossStatus] = React.useState<string | null>(null);
  // mtime (ms) of each open file as last loaded/saved by us, used to detect an
  // external edit before we overwrite it on save.
  const loadedMtimeRef = React.useRef<Map<string, number>>(new Map());
  const saveTimerRef = React.useRef<number | null>(null);
  const sshTargetValue = React.useMemo(() => (sshTarget ?? "").trim() || null, [sshTarget]);
  const tabStripRef = React.useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());
  const [tabsMenuOpen, setTabsMenuOpen] = React.useState(false);
  const tabsMenuRef = React.useRef<HTMLDivElement | null>(null);
  const tabsMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);
  // Browser tabs: synthetic-path tab → its native child-webview label + last URL.
  // Kept in a ref (not state) because BrowserView owns the live URL; we only need
  // it here to address browser_close on tab close and to seed BrowserView.
  const browserMetaRef = React.useRef<Map<string, { label: string; url: string }>>(new Map());
  const browserSeqRef = React.useRef(0);

  const modelUriForPath = React.useCallback(
    (monaco: MonacoType, path: string) => {
      if (provider === "ssh") {
        const authority = encodeURIComponent(sshTargetValue ?? "ssh");
        return monaco.Uri.from({ scheme: "ssh", authority, path });
      }
      return monaco.Uri.file(path);
    },
    [provider, sshTargetValue],
  );

  const readTextFile = React.useCallback(
    async (path: string): Promise<string> => {
      if (provider === "ssh") {
        if (!sshTargetValue) throw new Error("Missing SSH target.");
        return await invoke<string>("ssh_read_text_file", { target: sshTargetValue, root: rootDir, path });
      }
      return await invoke<string>("read_text_file", { root: rootDir, path });
    },
    [provider, rootDir, sshTargetValue],
  );

  const probeFile = React.useCallback(
    async (path: string): Promise<FileProbe> => {
      if (provider === "ssh") {
        if (!sshTargetValue) throw new Error("Missing SSH target.");
        return await invoke<FileProbe>("ssh_probe_file", { target: sshTargetValue, root: rootDir, path });
      }
      return await invoke<FileProbe>("probe_file", { root: rootDir, path });
    },
    [provider, rootDir, sshTargetValue],
  );

  const readFileRange = React.useCallback<ReadRangeFn>(
    async (path: string, offset: number, length: number): Promise<Uint8Array> => {
      const safeOffset = Math.max(0, Math.floor(offset));
      const safeLength = Math.max(0, Math.min(MAX_RANGE_BYTES, Math.floor(length)));
      const buffer =
        provider === "ssh"
          ? await (async () => {
              if (!sshTargetValue) throw new Error("Missing SSH target.");
              return invoke<ArrayBuffer>("ssh_read_file_range", {
                target: sshTargetValue,
                root: rootDir,
                path,
                offset: safeOffset,
                length: safeLength,
              });
            })()
          : await invoke<ArrayBuffer>("read_file_range", {
              root: rootDir,
              path,
              offset: safeOffset,
              length: safeLength,
            });
      return new Uint8Array(buffer);
    },
    [provider, rootDir, sshTargetValue],
  );

  const writeTextFile = React.useCallback(
    async (path: string, content: string): Promise<void> => {
      if (provider === "ssh") {
        if (!sshTargetValue) throw new Error("Missing SSH target.");
        await invoke("ssh_write_text_file", { target: sshTargetValue, root: rootDir, path, content });
        return;
      }
      await invoke("write_text_file", { root: rootDir, path, content });
    },
    [provider, rootDir, sshTargetValue],
  );

  const restoredRef = React.useRef(false);
  const lastOpenRequestRef = React.useRef<string | null>(null);
  const scheduledOpenRequestRef = React.useRef<string | null>(null);
  const lastWorkspaceTabRequestRef = React.useRef<string | null>(null);
  const scheduledWorkspaceTabRequestRef = React.useRef<string | null>(null);
  const tabsRef = React.useRef<Tab[]>([]);
  React.useLayoutEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const openPathsRef = React.useRef<Set<string>>(new Set());
  const dirtyPathsRef = React.useRef<Set<string>>(new Set());
  const modelsRef = React.useRef<Map<string, import("monaco-editor").editor.ITextModel>>(new Map());
  const pendingContentRef = React.useRef<Map<string, string>>(new Map());
  const loadNonceByPathRef = React.useRef<Map<string, number>>(new Map());
  const nextLoadNonceRef = React.useRef(1);
  const monacoRef = React.useRef<MonacoType | null>(null);
  const editorRef = React.useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);

  const openFind = React.useCallback((): boolean => {
    const active = activePathRef.current;
    const tab = active ? tabsRef.current.find((it) => it.path === active) : null;
    if (tab?.viewerKind !== "text") return false;
    const editor = editorRef.current;
    if (!editor) return false;
    try {
      editor.focus();
      const action = editor.getAction("actions.find");
      if (!action) return false;
      void action.run();
      return true;
    } catch {
      return false;
    }
  }, []);

  const onPersistStateRef = React.useRef(onPersistState);
  React.useEffect(() => {
    onPersistStateRef.current = onPersistState;
  }, [onPersistState]);

  const onConsumeOpenFileRequestRef = React.useRef(onConsumeOpenFileRequest);
  React.useEffect(() => {
    onConsumeOpenFileRequestRef.current = onConsumeOpenFileRequest;
  }, [onConsumeOpenFileRequest]);

  const onConsumeOpenWorkspaceTabRequestRef = React.useRef(onConsumeOpenWorkspaceTabRequest);
  React.useEffect(() => {
    onConsumeOpenWorkspaceTabRequestRef.current = onConsumeOpenWorkspaceTabRequest;
  }, [onConsumeOpenWorkspaceTabRequest]);

  const onActiveFilePathChangeRef = React.useRef(onActiveFilePathChange);
  React.useEffect(() => {
    onActiveFilePathChangeRef.current = onActiveFilePathChange;
  }, [onActiveFilePathChange]);

  const activePathRef = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    activePathRef.current = activePath;
    onActiveFilePathChangeRef.current(activePath && !isBrowserPath(activePath) ? activePath : null);
  }, [activePath]);

  const readModelValue = React.useCallback((path: string): string | null => {
    const monaco = monacoRef.current;
    if (monaco) {
      const model = monaco.editor.getModel(modelUriForPath(monaco, path));
      if (model) return model.getValue();
    }
    const model = modelsRef.current.get(path);
    if (model) return model.getValue();
    const pending = pendingContentRef.current.get(path);
    return pending ?? null;
  }, [modelUriForPath]);

  const serializeState = React.useCallback((): CodeEditorPersistedState => {
    // Browser tabs are session-only (no URL persistence), so they're excluded.
    const currentTabs = tabsRef.current.filter((tab) => !isBrowserPath(tab.path));
    const outTabs: CodeEditorPersistedTab[] = currentTabs.map((tab) => {
      const dirty = dirtyPathsRef.current.has(tab.path) || tab.dirty;
      const content = dirty && tab.viewerKind === "text" ? readModelValue(tab.path) ?? "" : null;
      return { path: tab.path, dirty: tab.viewerKind === "text" ? dirty : false, content, viewerKind: tab.viewerKind, locked: tab.locked };
    });
    const active = activePathRef.current;
    return { tabs: outTabs, activePath: active && !isBrowserPath(active) ? active : null };
  }, [readModelValue]);

  React.useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      try {
        onPersistStateRef.current(serializeState());
      } catch {
        // Best-effort: preserve editor state when possible.
      }
      // Tear down any embedded-browser webviews so they don't linger off-screen.
      for (const meta of browserMetaRef.current.values()) {
        void invoke("browser_close", { label: meta.label }).catch(() => {});
      }
      browserMetaRef.current.clear();
      editorRef.current?.setModel(null);
      for (const model of modelsRef.current.values()) model.dispose();
      modelsRef.current.clear();
      pendingContentRef.current.clear();
      dirtyPathsRef.current.clear();
      openPathsRef.current.clear();
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, [serializeState]);

  const updateTab = React.useCallback((path: string, updater: (tab: Tab) => Tab) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      if (idx === -1) return prev;
      const nextTab = updater(prev[idx]);
      if (nextTab === prev[idx]) return prev;
      const next = prev.slice();
      next[idx] = nextTab;
      tabsRef.current = next;
      return next;
    });
  }, []);

  const markDirty = React.useCallback(
    (path: string) => {
      if (dirtyPathsRef.current.has(path)) return;
      dirtyPathsRef.current.add(path);
      updateTab(path, (tab) => (tab.dirty ? tab : { ...tab, dirty: true }));
    },
    [updateTab],
  );

  const ensureModel = React.useCallback(
    (path: string, content: string) => {
      const monaco = monacoRef.current;
      if (!monaco) {
        pendingContentRef.current.set(path, content);
        return;
      }

      const uri = modelUriForPath(monaco, path);
      const existing = monaco.editor.getModel(uri);
      const language = inferLanguageId(path);
      if (existing) {
        monaco.editor.setModelLanguage(existing, language);
        existing.setValue(content);
        if (!modelsRef.current.has(path)) {
          existing.onDidChangeContent(() => markDirty(path));
        }
        modelsRef.current.set(path, existing);
        return;
      }

      const model = monaco.editor.createModel(content, language, uri);
      model.onDidChangeContent(() => markDirty(path));
      modelsRef.current.set(path, model);
    },
    [markDirty, modelUriForPath],
  );

  const setEditorModel = React.useCallback((path: string | null) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    if (!path) {
      editor.setModel(null);
      return;
    }
    const model = modelsRef.current.get(path) ?? monaco.editor.getModel(modelUriForPath(monaco, path));
    if (!model) return;
    modelsRef.current.set(path, model);
    editor.setModel(model);
  }, [modelUriForPath]);

  const serializeWorkspaceTab = React.useCallback((tab: Tab): CodeEditorWorkspaceTab => {
    const browserMeta = browserMetaRef.current.get(tab.path) ?? null;
    const dirty = dirtyPathsRef.current.has(tab.path) || tab.dirty;
    return {
      id: tab.path,
      kind: browserMeta ? "browser" : "file",
      title: tab.title,
      active: tab.path === activePathRef.current,
      path: browserMeta ? null : tab.path,
      url: browserMeta?.url ?? null,
      label: browserMeta?.label ?? null,
      viewerKind: tab.viewerKind,
      requestedMode: tab.requestedMode,
      dirty,
      loading: tab.loading,
      error: tab.error,
      locked: tab.locked,
      size: tab.size,
      mime: tab.mime,
      imageType: tab.imageType,
    };
  }, []);

  const workspaceSnapshot = React.useCallback((): CodeEditorWorkspaceSnapshot => {
    const active = activePathRef.current;
    return {
      provider,
      rootDir,
      activeTabId: active,
      activeFilePath: active && !isBrowserPath(active) ? active : null,
      tabs: tabsRef.current.map(serializeWorkspaceTab),
    };
  }, [provider, rootDir, serializeWorkspaceTab]);

  const resolveExistingTabPath = React.useCallback((input?: { tabId?: string | null; path?: string | null }): string | null => {
    const candidate = ((input?.tabId ?? input?.path ?? "") as string).trim();
    if (!candidate) return activePathRef.current;
    if (openPathsRef.current.has(candidate)) return candidate;
    for (const [path, meta] of browserMetaRef.current.entries()) {
      if (meta.label === candidate) return path;
    }
    return null;
  }, []);

  const resolveBrowserPath = React.useCallback((tabId?: string | null): string | null => {
    const candidate = (tabId ?? "").trim();
    if (candidate) {
      if (browserMetaRef.current.has(candidate)) return candidate;
      for (const [path, meta] of browserMetaRef.current.entries()) {
        if (meta.label === candidate) return path;
      }
      return null;
    }
    const active = activePathRef.current;
    if (active && browserMetaRef.current.has(active)) return active;
    return tabsRef.current.find((tab) => browserMetaRef.current.has(tab.path))?.path ?? null;
  }, []);

  const browserSnapshot = React.useCallback(
    (input?: { tabId?: string | null }): CodeEditorBrowserSnapshot => {
      const target = input?.tabId ? resolveBrowserPath(input.tabId) : null;
      if (input?.tabId && !target) throw new Error("browser tab not found");
      const browserTabs = tabsRef.current.filter((tab) => browserMetaRef.current.has(tab.path));
      const active = activePathRef.current;
      const activeBrowser = active && browserMetaRef.current.has(active) ? active : null;
      const tabs = target
        ? browserTabs.filter((tab) => tab.path === target)
        : browserTabs;
      return {
        activeTabId: active,
        activeBrowserTabId: activeBrowser,
        tabs: tabs.map(serializeWorkspaceTab),
      };
    },
    [resolveBrowserPath, serializeWorkspaceTab],
  );

  const fileViewerSnapshot = React.useCallback(
    (input?: { tabId?: string | null; path?: string | null; maxContentLength?: number }): CodeEditorFileViewerSnapshot => {
      const resolved = resolveExistingTabPath(input);
      if (!resolved) throw new Error("file viewer tab not found");
      if (browserMetaRef.current.has(resolved)) throw new Error("target tab is a browser tab");
      const tab = tabsRef.current.find((it) => it.path === resolved);
      if (!tab) throw new Error("file viewer tab not found");

      const fullContent = tab.viewerKind === "text" ? readModelValue(resolved) : null;
      const maxContentLength = Math.min(
        200_000,
        Math.max(0, Math.floor(input?.maxContentLength ?? 20_000)),
      );
      const content =
        fullContent == null
          ? null
          : fullContent.length > maxContentLength
            ? fullContent.slice(0, maxContentLength)
            : fullContent;
      return {
        tab: serializeWorkspaceTab(tab),
        contentAvailable: fullContent != null,
        content,
        contentTruncated: fullContent != null && fullContent.length > maxContentLength,
      };
    },
    [readModelValue, resolveExistingTabPath, serializeWorkspaceTab],
  );

  const openFile = React.useCallback(
    async (path: string, mode: CodeEditorOpenMode = "auto") => {
      const normalized = path.trim();
      if (!normalized) return;

      // Browser tabs have no backing file — just activate them.
      if (isBrowserPath(normalized)) {
        if (openPathsRef.current.has(normalized)) {
          setActivePath(normalized);
          activePathRef.current = normalized;
          setEditorModel(null);
        }
        return;
      }

      const reload = async () => {
        updateTab(normalized, (tab) => ({
          ...tab,
          requestedMode: mode,
          loading: true,
          error: null,
          viewerKind: tab.viewerKind,
        }));

        const loadNonce = nextLoadNonceRef.current++;
        loadNonceByPathRef.current.set(normalized, loadNonce);
        try {
          const probe = await probeFile(normalized);
          if (!openPathsRef.current.has(normalized)) return;
          if (loadNonceByPathRef.current.get(normalized) !== loadNonce) return;
          loadedMtimeRef.current.set(normalized, probe.mtimeMs ?? 0);

          const viewerKind = chooseViewerKind(probe, mode, normalized);
          if (viewerKind !== "text") {
            const editor = editorRef.current;
            if (editor && editor.getModel() === modelsRef.current.get(normalized)) {
              editor.setModel(null);
            }
            const model = modelsRef.current.get(normalized);
            if (model && !dirtyPathsRef.current.has(normalized)) {
              modelsRef.current.delete(normalized);
              model.dispose();
            }
            pendingContentRef.current.delete(normalized);
          }

          if (viewerKind === "text") {
            const content = await readTextFile(normalized);
            if (!openPathsRef.current.has(normalized)) return;
            if (loadNonceByPathRef.current.get(normalized) !== loadNonce) return;
            ensureModel(normalized, content);
          }

          updateTab(normalized, (tab) => ({
            ...tab,
            viewerKind,
            requestedMode: mode,
            loading: false,
            error: mode === "image" && viewerKind !== "image" ? "Not a supported raster image." : null,
            size: probe.size,
            mime: probe.mime ?? null,
            imageType: probe.imageType ?? null,
          }));

          if (activePathRef.current === normalized) {
            if (viewerKind === "text") setEditorModel(normalized);
            else setEditorModel(null);
          }
        } catch (err) {
          if (!openPathsRef.current.has(normalized)) return;
          if (loadNonceByPathRef.current.get(normalized) !== loadNonce) return;
          const message = err instanceof Error ? err.message : String(err);
          updateTab(normalized, (tab) => ({ ...tab, loading: false, error: message }));
        } finally {
          if (loadNonceByPathRef.current.get(normalized) === loadNonce) {
            loadNonceByPathRef.current.delete(normalized);
          }
        }
      };

      if (openPathsRef.current.has(normalized)) {
        setActivePath(normalized);
        activePathRef.current = normalized;

        const existing = tabsRef.current.find((tab) => tab.path === normalized) ?? null;
        const requestedModeMatches = mode === "auto" || existing?.requestedMode === mode;
        if (existing?.viewerKind && requestedModeMatches) {
          if (existing.viewerKind === "text") setEditorModel(normalized);
          else setEditorModel(null);
          return;
        }
        if (dirtyPathsRef.current.has(normalized)) {
          setEditorModel(normalized);
          return;
        }
        if (loadNonceByPathRef.current.has(normalized)) {
          return;
        }
        await reload();
        return;
      }

      openPathsRef.current.add(normalized);
      const nextTabs = [...tabsRef.current, emptyTab(normalized, mode)];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActivePath(normalized);
      activePathRef.current = normalized;
      await reload();
    },
    [ensureModel, probeFile, readTextFile, setEditorModel, updateTab],
  );

  // Open a new embedded-browser tab. The page runs in a native child WKWebView
  // (created lazily by BrowserView on first layout) that has no app capabilities.
  const openBrowserTab = React.useCallback(
    (url: string = BROWSER_START_URL, title = "New tab") => {
      const seq = ++browserSeqRef.current;
      const path = `${BROWSER_PREFIX}${seq}`;
      const label = `browser-${seq}`;
      browserMetaRef.current.set(path, { label, url });
      openPathsRef.current.add(path);
      const tab: Tab = {
        ...emptyTab(path),
        title,
        viewerKind: "browser",
        loading: false,
      };
      const next = [...tabsRef.current, tab];
      tabsRef.current = next;
      setTabs(next);
      setActivePath(path);
      activePathRef.current = path;
      setEditorModel(null);
      return tab;
    },
    [setEditorModel],
  );

  const openWorkspaceTab = React.useCallback(
    async (input: CodeEditorOpenWorkspaceTabInput): Promise<CodeEditorWorkspaceTab> => {
      const kind = input.kind ?? (input.url ? "browser" : "file");
      if (kind === "browser") {
        const url = normalizeBrowserUrl(input.url ?? BROWSER_START_URL);
        const title = (input.title ?? "").trim() || urlHost(url);
        const tab = openBrowserTab(url, title);
        return serializeWorkspaceTab(tab);
      }

      const path = (input.path ?? "").trim();
      if (!path) throw new Error("path is required");
      await openFile(path, input.mode ?? "auto");
      const tab = tabsRef.current.find((it) => it.path === path);
      if (!tab) throw new Error("file tab did not open");
      return serializeWorkspaceTab(tab);
    },
    [openBrowserTab, openFile, serializeWorkspaceTab],
  );

  // "Open in browser" for an HTML file: render it in a browser tab. Local files
  // load directly via file://; SSH files are first downloaded to a temp file.
  const openHtmlInBrowser = React.useCallback(
    async (path: string) => {
      try {
        let localPath = path;
        if (provider === "ssh") {
          if (!sshTargetValue) throw new Error("Missing SSH target.");
          localPath = await invoke<string>("ssh_download_to_temp", {
            target: sshTargetValue,
            root: rootDir,
            remotePath: path,
          });
        }
        openBrowserTab(fileUrlForPath(localPath), basename(path));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSaveError(message);
        setSaveStatus("error");
      }
    },
    [openBrowserTab, provider, rootDir, sshTargetValue],
  );

  React.useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!persistedState) return;
    if (!persistedState.tabs.length) return;

    const nextTabs: Tab[] = persistedState.tabs.map((it) => ({
      path: it.path,
      title: basename(it.path),
      viewerKind: it.dirty && it.content != null ? "text" : null,
      requestedMode: it.viewerKind === "bytes" ? "bytes" : it.viewerKind === "image" ? "image" : "auto",
      dirty: it.dirty && it.content != null,
      loading: it.content == null,
      error: null,
      size: null,
      mime: null,
      imageType: null,
      locked: Boolean(it.locked),
    }));
    setTabs(nextTabs);
    openPathsRef.current = new Set(persistedState.tabs.map((t) => t.path));
    dirtyPathsRef.current = new Set(persistedState.tabs.filter((t) => t.dirty && t.content != null).map((t) => t.path));

    for (const tab of persistedState.tabs) {
      if (!tab.dirty) continue;
      if (tab.content == null) continue;
      ensureModel(tab.path, tab.content);
    }

    const desiredActive =
      (persistedState.activePath &&
        persistedState.tabs.some((t) => t.path === persistedState.activePath) &&
        persistedState.activePath) ||
      persistedState.tabs[0]?.path ||
      null;

    setActivePath(desiredActive);
    activePathRef.current = desiredActive;
    if (desiredActive) void openFile(desiredActive);
  }, [ensureModel, openFile, persistedState]);

  React.useEffect(() => {
    if (!openFileRequest) return;
    const key = `${openFileRequest.nonce}:${openFileRequest.path}:${openFileRequest.mode ?? "auto"}`;
    if (lastOpenRequestRef.current === key) return;
    if (scheduledOpenRequestRef.current === key) return;
    scheduledOpenRequestRef.current = key;

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      if (lastOpenRequestRef.current === key) return;
      lastOpenRequestRef.current = key;
      if (scheduledOpenRequestRef.current === key) scheduledOpenRequestRef.current = null;
      onConsumeOpenFileRequestRef.current?.();
      void openFile(openFileRequest.path, openFileRequest.mode ?? "auto");
    };

    // Defer to the microtask queue so StrictMode test mounts don't eat the request,
    // while still feeling instant for users.
    if (typeof queueMicrotask === "function") queueMicrotask(run);
    else void Promise.resolve().then(run);

    return () => {
      cancelled = true;
      if (scheduledOpenRequestRef.current === key) scheduledOpenRequestRef.current = null;
    };
  }, [openFile, openFileRequest]);

  React.useEffect(() => {
    if (!openWorkspaceTabRequest) return;
    const kind = openWorkspaceTabRequest.kind ?? (openWorkspaceTabRequest.url ? "browser" : "file");
    const key = [
      openWorkspaceTabRequest.nonce,
      kind,
      openWorkspaceTabRequest.path ?? "",
      openWorkspaceTabRequest.url ?? "",
      openWorkspaceTabRequest.mode ?? "auto",
      openWorkspaceTabRequest.title ?? "",
    ].join(":");
    if (lastWorkspaceTabRequestRef.current === key) return;
    if (scheduledWorkspaceTabRequestRef.current === key) return;
    scheduledWorkspaceTabRequestRef.current = key;

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      if (lastWorkspaceTabRequestRef.current === key) return;
      lastWorkspaceTabRequestRef.current = key;
      if (scheduledWorkspaceTabRequestRef.current === key) scheduledWorkspaceTabRequestRef.current = null;
      onConsumeOpenWorkspaceTabRequestRef.current?.();
      void openWorkspaceTab(openWorkspaceTabRequest).catch(() => {});
    };

    if (typeof queueMicrotask === "function") queueMicrotask(run);
    else void Promise.resolve().then(run);

    return () => {
      cancelled = true;
      if (scheduledWorkspaceTabRequestRef.current === key) scheduledWorkspaceTabRequestRef.current = null;
    };
  }, [openWorkspaceTab, openWorkspaceTabRequest]);

  React.useEffect(() => {
    if (!tabsMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (tabsMenuRef.current?.contains(target)) return;
      if (tabsMenuButtonRef.current?.contains(target)) return;
      setTabsMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setTabsMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [tabsMenuOpen]);

  const updateScrollState = React.useCallback(() => {
    const el = tabStripRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 1);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  React.useEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;

    updateScrollState();

    const handleScroll = () => updateScrollState();
    el.addEventListener("scroll", handleScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateScrollState());
    resizeObserver.observe(el);

    return () => {
      el.removeEventListener("scroll", handleScroll);
      resizeObserver.disconnect();
    };
  }, [updateScrollState, tabs.length]);

  const scrollTabs = React.useCallback((direction: "left" | "right") => {
    const el = tabStripRef.current;
    if (!el) return;
    const scrollAmount = 150;
    el.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  }, []);

  React.useEffect(() => {
    if (!activePath) {
      setEditorModel(null);
      return;
    }
    const monaco = monacoRef.current;
    const hasModel =
      modelsRef.current.has(activePath) ||
      (monaco ? Boolean(monaco.editor.getModel(modelUriForPath(monaco, activePath))) : false);
    if (!hasModel) {
      setEditorModel(null);
      return;
    }
    setEditorModel(activePath);
  }, [activePath, modelUriForPath, setEditorModel]);

  const closeTab = React.useCallback(
    (path: string) => {
      const browserMeta = browserMetaRef.current.get(path);
      if (browserMeta) {
        void invoke("browser_close", { label: browserMeta.label }).catch(() => {});
        browserMetaRef.current.delete(path);
      }
      const editor = editorRef.current;
      if (editor && editor.getModel() === modelsRef.current.get(path)) {
        editor.setModel(null);
      }

      const model = modelsRef.current.get(path);
      if (model) {
        modelsRef.current.delete(path);
        model.dispose();
      }
      dirtyPathsRef.current.delete(path);
      openPathsRef.current.delete(path);
      pendingContentRef.current.delete(path);

      const prevTabs = tabsRef.current;
      const next = prevTabs.filter((t) => t.path !== path);
      tabsRef.current = next;
      setTabs(next);
      if (next.length === 0) {
        setActivePath(null);
        activePathRef.current = null;
        onCloseEditor();
        return;
      }
      if (activePathRef.current === path) {
        const nextActive = next[next.length - 1].path;
        setActivePath(nextActive);
        activePathRef.current = nextActive;
        setEditorModel(nextActive);
      }
    },
    [onCloseEditor, setEditorModel],
  );

  // Batch close (for the tab context menu). Skips locked tabs and tabs with
  // unsaved changes so nothing is silently discarded; those stay open.
  const closeTabs = React.useCallback(
    (targets: string[]) => {
      const lockedSet = new Set(tabsRef.current.filter((t) => t.locked).map((t) => t.path));
      const toClose = new Set(targets.filter((p) => !lockedSet.has(p) && !dirtyPathsRef.current.has(p)));
      if (toClose.size === 0) return;
      const editor = editorRef.current;
      for (const p of toClose) {
        const browserMeta = browserMetaRef.current.get(p);
        if (browserMeta) {
          void invoke("browser_close", { label: browserMeta.label }).catch(() => {});
          browserMetaRef.current.delete(p);
        }
        const model = modelsRef.current.get(p);
        if (model) {
          if (editor && editor.getModel() === model) editor.setModel(null);
          modelsRef.current.delete(p);
          model.dispose();
        }
        dirtyPathsRef.current.delete(p);
        openPathsRef.current.delete(p);
        pendingContentRef.current.delete(p);
      }
      const next = tabsRef.current.filter((t) => !toClose.has(t.path));
      tabsRef.current = next;
      setTabs(next);
      if (next.length === 0) {
        setActivePath(null);
        activePathRef.current = null;
        onCloseEditor();
        return;
      }
      if (activePathRef.current && toClose.has(activePathRef.current)) {
        const nextActive = next[next.length - 1].path;
        setActivePath(nextActive);
        activePathRef.current = nextActive;
        setEditorModel(nextActive);
      }
    },
    [onCloseEditor, setEditorModel],
  );

  const requestCloseTab = React.useCallback(
    (path: string) => {
      const normalized = path.trim();
      if (!normalized) return;
      if (dirtyPathsRef.current.has(normalized)) {
        setPendingClose({ kind: "tab", path: normalized });
        return;
      }
      closeTab(normalized);
    },
    [closeTab],
  );

  const modelForPath = React.useCallback(
    (path: string) => {
      const monaco = monacoRef.current;
      return monaco ? monaco.editor.getModel(modelUriForPath(monaco, path)) : modelsRef.current.get(path) ?? null;
    },
    [modelUriForPath],
  );

  const performWrite = React.useCallback(
    async (path: string, model: import("monaco-editor").editor.ITextModel) => {
      setSaveStatus("saving");
      setSaveError(null);
      try {
        await writeTextFile(path, model.getValue());
        dirtyPathsRef.current.delete(path);
        updateTab(path, (tab) => ({ ...tab, dirty: false }));
        // Re-read mtime so this write isn't later mistaken for an external edit.
        try {
          const probe = await probeFile(path);
          loadedMtimeRef.current.set(path, probe.mtimeMs ?? loadedMtimeRef.current.get(path) ?? 0);
        } catch {
          /* mtime refresh is best-effort */
        }
        setSaveStatus("saved");
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => setSaveStatus("idle"), 1200);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSaveStatus("error");
        setSaveError(message);
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => setSaveStatus("idle"), 2500);
      }
    },
    [probeFile, updateTab, writeTextFile],
  );

  const saveActive = React.useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (tab?.viewerKind !== "text") return;
    if (!dirtyPathsRef.current.has(path)) return;

    const model = modelForPath(path);
    if (!model) return;

    // Guard against silently clobbering an edit made on disk (e.g. by an agent)
    // since we loaded the file.
    try {
      const probe = await probeFile(path);
      const loaded = loadedMtimeRef.current.get(path) ?? 0;
      if ((probe.mtimeMs ?? 0) > loaded) {
        setSaveConflictPath(path);
        return;
      }
    } catch {
      /* if the freshness check fails, fall through to the write */
    }
    await performWrite(path, model);
  }, [modelForPath, performWrite, probeFile]);

  const requestCloseEditor = React.useCallback(() => {
    if (dirtyPathsRef.current.size > 0) {
      setPendingClose({ kind: "editor" });
      return;
    }
    onCloseEditor();
  }, [onCloseEditor]);

  const onMount = React.useCallback(
    (editor: import("monaco-editor").editor.IStandaloneCodeEditor, monaco: MonacoType) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void saveActive();
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => {
        const path = activePathRef.current;
        if (!path) return;
        requestCloseTab(path);
      });
      // Format Document (Shift+Alt+F, as in VS Code). A no-op for languages
      // without a registered formatter (only TS/JS/JSON/CSS/HTML ship one).
      editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
        void editor.getAction("editor.action.formatDocument")?.run();
      });
      // Go to Symbol / quick outline (Ctrl/Cmd+Shift+O).
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO, () => {
        void editor.getAction("editor.action.quickOutline")?.run();
      });
      for (const [path, content] of pendingContentRef.current.entries()) {
        ensureModel(path, content);
      }
      pendingContentRef.current.clear();
      if (activePathRef.current) setEditorModel(activePathRef.current);
    },
    [ensureModel, requestCloseTab, saveActive, setEditorModel],
  );

  const lastFsEventNonceRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!fsEvent) return;
    if (lastFsEventNonceRef.current === fsEvent.nonce) return;
    lastFsEventNonceRef.current = fsEvent.nonce;

    if (fsEvent.type === "rename") {
      const from = fsEvent.from.trim();
      const to = fsEvent.to.trim();
      if (!from || !to || from === to) return;
      const fromPrefix = `${from}/`;

      const transformPath = (path: string): string => {
        const trimmed = path.trim();
        if (trimmed === from) return to;
        if (trimmed.startsWith(fromPrefix)) return `${to}${trimmed.slice(from.length)}`;
        return trimmed;
      };

      const activeBefore = activePathRef.current;
      const activeAfter = activeBefore ? transformPath(activeBefore) : null;

      setTabs((prev) =>
        {
          const next = prev.map((tab) => {
          const nextPath = transformPath(tab.path);
          if (nextPath === tab.path) return tab;
          return { ...tab, path: nextPath, title: basename(nextPath) };
          });
          tabsRef.current = next;
          return next;
        },
      );

      const nextOpenPaths = new Set<string>();
      for (const p of openPathsRef.current) nextOpenPaths.add(transformPath(p));
      openPathsRef.current = nextOpenPaths;

      const nextDirtyPaths = new Set<string>();
      for (const p of dirtyPathsRef.current) nextDirtyPaths.add(transformPath(p));
      dirtyPathsRef.current = nextDirtyPaths;

      if (pendingContentRef.current.size > 0) {
        const nextPending = new Map<string, string>();
        for (const [p, content] of pendingContentRef.current.entries()) {
          nextPending.set(transformPath(p), content);
        }
        pendingContentRef.current = nextPending;
      }

      if (loadNonceByPathRef.current.size > 0) {
        const nextLoads = new Map<string, number>();
        for (const [p, nonce] of loadNonceByPathRef.current.entries()) {
          nextLoads.set(transformPath(p), nonce);
        }
        loadNonceByPathRef.current = nextLoads;
      }

      const monaco = monacoRef.current;
      if (monaco) {
        const editor = editorRef.current;
        const activeModel = editor?.getModel() ?? null;
        const activeModelPath = activeModel?.uri?.fsPath ?? null;
        if (activeModelPath && (activeModelPath === from || activeModelPath.startsWith(fromPrefix))) {
          editor?.setModel(null);
        }

        const nextModels = new Map<string, import("monaco-editor").editor.ITextModel>();
        for (const [path, model] of modelsRef.current.entries()) {
          const nextPath = transformPath(path);
          if (nextPath === path) {
            nextModels.set(path, model);
            continue;
          }
          const content = model.getValue();
          const uri = modelUriForPath(monaco, nextPath);
          const language = inferLanguageId(nextPath);
          const existing = monaco.editor.getModel(uri);
          if (existing && existing !== model) existing.dispose();
          const created = monaco.editor.createModel(content, language, uri);
          created.onDidChangeContent(() => markDirty(nextPath));
          nextModels.set(nextPath, created);
          model.dispose();
        }
        modelsRef.current = nextModels;
      }

      if (activeBefore && activeAfter && activeAfter !== activeBefore) {
        setActivePath(activeAfter);
        activePathRef.current = activeAfter;
        setEditorModel(activeAfter);
      }
      return;
    }

    if (fsEvent.type === "delete") {
      const base = fsEvent.path.trim();
      if (!base) return;
      const basePrefix = `${base}/`;
      const shouldClose = (path: string) => path === base || path.startsWith(basePrefix);

      const prevTabs = tabsRef.current;
      const nextTabs = prevTabs.filter((t) => !shouldClose(t.path));
      tabsRef.current = nextTabs;
      setTabs(nextTabs);

      openPathsRef.current = new Set(Array.from(openPathsRef.current).filter((p) => !shouldClose(p)));
      dirtyPathsRef.current = new Set(Array.from(dirtyPathsRef.current).filter((p) => !shouldClose(p)));
      loadNonceByPathRef.current = new Map(Array.from(loadNonceByPathRef.current).filter(([p]) => !shouldClose(p)));

      if (pendingContentRef.current.size > 0) {
        const nextPending = new Map<string, string>();
        for (const [p, content] of pendingContentRef.current.entries()) {
          if (shouldClose(p)) continue;
          nextPending.set(p, content);
        }
        pendingContentRef.current = nextPending;
      }

      if (activePathRef.current && shouldClose(activePathRef.current)) {
        editorRef.current?.setModel(null);
      }

      for (const [path, model] of modelsRef.current.entries()) {
        if (!shouldClose(path)) continue;
        model.dispose();
        modelsRef.current.delete(path);
      }

      const active = activePathRef.current;
      if (!active || !shouldClose(active)) return;
      if (nextTabs.length === 0) {
        setActivePath(null);
        activePathRef.current = null;
        onCloseEditor();
        return;
      }
      const nextActive = nextTabs[nextTabs.length - 1].path;
      setActivePath(nextActive);
      activePathRef.current = nextActive;
      setEditorModel(nextActive);
    }
  }, [fsEvent, markDirty, modelUriForPath, onCloseEditor, setEditorModel]);

  const activeTab = React.useMemo(() => tabs.find((t) => t.path === activePath) ?? null, [activePath, tabs]);
  const dirtyCount = React.useMemo(() => tabs.reduce((count, tab) => count + (tab.dirty ? 1 : 0), 0), [tabs]);
  const tabTitleCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
      const base = basename(tab.path);
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    return counts;
  }, [tabs]);

  const openTab = React.useCallback((path: string) => void openFile(path), [openFile]);
  const registerTabButton = React.useCallback((path: string, el: HTMLButtonElement | null) => {
    if (!el) tabButtonRefs.current.delete(path);
    else tabButtonRefs.current.set(path, el);
  }, []);
  const openTabMenu = React.useCallback((path: string, x: number, y: number) => {
    setTabMenu({ path, x, y });
  }, []);
  const toggleTabLock = React.useCallback(
    (path: string) => {
      updateTab(path, (tab) => ({ ...tab, locked: !tab.locked }));
    },
    [updateTab],
  );

  const focusWorkspaceTab = React.useCallback(
    (input: { tabId?: string | null; path?: string | null }): CodeEditorWorkspaceTab => {
      const resolved = resolveExistingTabPath(input);
      if (!resolved) throw new Error("tab not found");
      const tab = tabsRef.current.find((it) => it.path === resolved);
      if (!tab) throw new Error("tab not found");
      setActivePath(resolved);
      activePathRef.current = resolved;
      if (tab.viewerKind === "text") setEditorModel(resolved);
      else setEditorModel(null);
      return serializeWorkspaceTab(tab);
    },
    [resolveExistingTabPath, serializeWorkspaceTab, setEditorModel],
  );

  const closeWorkspaceTab = React.useCallback(
    (input: { tabId?: string | null; path?: string | null; force?: boolean }): CodeEditorWorkspaceTab => {
      const resolved = resolveExistingTabPath(input);
      if (!resolved) throw new Error("tab not found");
      const tab = tabsRef.current.find((it) => it.path === resolved);
      if (!tab) throw new Error("tab not found");
      const snapshot = serializeWorkspaceTab(tab);
      if (tab.locked && !input.force) throw new Error("tab is locked; pass force=true to close it");
      if ((dirtyPathsRef.current.has(resolved) || tab.dirty) && !input.force) {
        throw new Error("tab has unsaved changes; pass force=true to close it");
      }
      closeTab(resolved);
      return snapshot;
    },
    [closeTab, resolveExistingTabPath, serializeWorkspaceTab],
  );

  const browserNavigate = React.useCallback(
    async (input: { tabId?: string | null; url: string; activate?: boolean }): Promise<CodeEditorWorkspaceTab> => {
      const url = normalizeBrowserUrl(input.url);
      const path = resolveBrowserPath(input.tabId);
      if (!path) throw new Error("browser tab not found");
      const meta = browserMetaRef.current.get(path);
      if (!meta) throw new Error("browser tab not found");
      meta.url = url;
      const title = urlHost(url);
      updateTab(path, (tab) => (tab.title === title ? tab : { ...tab, title }));
      if (input.activate !== false) {
        setActivePath(path);
        activePathRef.current = path;
        setEditorModel(null);
      }
      try {
        await invoke("browser_navigate", { label: meta.label, url });
      } catch (err) {
        // A freshly opened browser tab may not have created its native webview yet.
        // Updating the stored URL is enough for the first BrowserView mount.
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("browser not found")) throw err;
      }
      const tab = tabsRef.current.find((it) => it.path === path);
      if (!tab) throw new Error("browser tab not found");
      return serializeWorkspaceTab({ ...tab, title });
    },
    [resolveBrowserPath, serializeWorkspaceTab, setEditorModel, updateTab],
  );

  const browserAction = React.useCallback(
    async (input: { tabId?: string | null; action: "back" | "forward" | "reload" }): Promise<CodeEditorWorkspaceTab> => {
      if (!["back", "forward", "reload"].includes(input.action)) throw new Error("unknown browser action");
      const path = resolveBrowserPath(input.tabId);
      if (!path) throw new Error("browser tab not found");
      const meta = browserMetaRef.current.get(path);
      if (!meta) throw new Error("browser tab not found");
      await invoke("browser_action", { label: meta.label, action: input.action });
      const tab = tabsRef.current.find((it) => it.path === path);
      if (!tab) throw new Error("browser tab not found");
      return serializeWorkspaceTab(tab);
    },
    [resolveBrowserPath, serializeWorkspaceTab],
  );

  React.useImperativeHandle(
    ref,
    () => ({
      openFind,
      workspaceSnapshot,
      openWorkspaceTab,
      focusWorkspaceTab,
      closeWorkspaceTab,
      browserNavigate,
      browserAction,
      browserSnapshot,
      fileViewerSnapshot,
    }),
    [
      browserAction,
      browserNavigate,
      browserSnapshot,
      closeWorkspaceTab,
      fileViewerSnapshot,
      focusWorkspaceTab,
      openFind,
      openWorkspaceTab,
      workspaceSnapshot,
    ],
  );

  React.useEffect(() => {
    if (!tabMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTabMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabMenu]);

  // Find (and optionally replace) across all open text models. Edits go through
  // pushEditOperations, so each model's onDidChangeContent marks its tab dirty.
  const runCrossFind = React.useCallback(
    (doReplace: boolean) => {
      if (!crossFind) {
        setCrossStatus(null);
        return;
      }
      let totalMatches = 0;
      let fileCount = 0;
      for (const [, model] of modelsRef.current) {
        if (model.isDisposed()) continue;
        const matches = model.findMatches(crossFind, false, false, crossCase, null, false);
        if (!matches.length) continue;
        fileCount += 1;
        totalMatches += matches.length;
        if (doReplace) {
          model.pushEditOperations(
            null,
            matches.map((m) => ({ range: m.range, text: crossReplace })),
            () => null,
          );
        }
      }
      setCrossStatus(
        totalMatches === 0
          ? "No matches"
          : `${doReplace ? "Replaced" : "Found"} ${totalMatches} in ${fileCount} file${fileCount === 1 ? "" : "s"}`,
      );
    },
    [crossCase, crossFind, crossReplace],
  );

  React.useLayoutEffect(() => {
    if (!activePath) return;
    const el = tabButtonRefs.current.get(activePath);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath, tabs.length]);

  return (
    <section className="codeEditorPanel" aria-label="Editor">
      <div className="codeEditorHeader">
        <div className="codeEditorTabsWrapper">
          {canScrollLeft ? (
            <button
              type="button"
              className="codeEditorTabsScrollBtn codeEditorTabsScrollBtnLeft"
              onClick={() => scrollTabs("left")}
              aria-label="Scroll tabs left"
            >
              <Icon name="chevron-left" size={14} />
            </button>
          ) : null}
          <div
            className="codeEditorTabs"
            role="tablist"
            aria-label="Open files"
            ref={tabStripRef}
            onWheel={(e) => {
              const el = tabStripRef.current;
              if (!el) return;
              if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
              if (el.scrollWidth <= el.clientWidth) return;
              el.scrollLeft += e.deltaY;
              e.preventDefault();
            }}
          >
            {tabs.map((tab) => {
              const base = basename(tab.path);
              const isDuplicate = (tabTitleCounts.get(base) ?? 0) > 1;
              const parent = dirname(tab.path);
              const parentName = parent === "/" ? "/" : parent.split("/").filter(Boolean).slice(-1)[0] ?? "";
              const suffix = isDuplicate && parentName ? ` · ${parentName}` : "";
              return (
                <EditorTab
                  key={tab.path}
                  tab={tab}
                  isActive={tab.path === activePath}
                  suffix={suffix}
                  onOpen={openTab}
                  onClose={requestCloseTab}
                  registerRef={registerTabButton}
                  onContextMenu={openTabMenu}
                />
              );
            })}
          </div>
          {canScrollRight ? (
            <button
              type="button"
              className="codeEditorTabsScrollBtn codeEditorTabsScrollBtnRight"
              onClick={() => scrollTabs("right")}
              aria-label="Scroll tabs right"
            >
              <Icon name="chevron-right" size={14} />
            </button>
          ) : null}
        </div>

        <div className="codeEditorActions">
          <button
            type="button"
            className="btnSmall btnIcon"
            onClick={() => openBrowserTab()}
            title="New browser tab"
            aria-label="New browser tab"
          >
            <Icon name="globe" />
          </button>
          <button
            type="button"
            className={`btnSmall btnIcon ${crossFindOpen ? "btnIconActive" : ""}`}
            onClick={() => setCrossFindOpen((v) => !v)}
            title="Find / replace across open files"
            aria-label="Find across open files"
          >
            ⌕
          </button>
          <div className="sidebarActionMenu">
            <button
              type="button"
              ref={tabsMenuButtonRef}
              className={`btnSmall btnIcon ${tabsMenuOpen ? "btnIconActive" : ""}`}
              onClick={() => setTabsMenuOpen((v) => !v)}
              title="Open tabs"
            >
              <Icon name="files" />
            </button>
            {tabsMenuOpen ? (
              <div className="sidebarActionMenuDropdown codeEditorTabsMenuDropdown" ref={tabsMenuRef} role="menu">
                {tabs.length === 0 ? (
                  <div className="codeEditorTabsMenuEmpty">No open files.</div>
                ) : (
                  tabs.map((tab) => (
                    <div key={`menu:${tab.path}`} className="codeEditorTabsMenuRow" role="none">
                      <button
                        type="button"
                        className={`sidebarActionMenuItem codeEditorTabsMenuItem ${tab.path === activePath ? "codeEditorTabsMenuItemActive" : ""}`}
                        role="menuitem"
                        title={tab.path}
                        onClick={() => {
                          setTabsMenuOpen(false);
                          void openFile(tab.path);
                        }}
                      >
                        <Icon name="file" size={14} />
                        <span className="codeEditorTabsMenuItemText">{shortenPathSmart(tab.path, 54)}</span>
                      </button>
                      <button
                        type="button"
                        className="btnSmall btnIcon codeEditorTabsMenuClose"
                        title="Close"
                        aria-label={`Close ${tab.title}`}
                        onClick={() => {
                          setTabsMenuOpen(false);
                          requestCloseTab(tab.path);
                        }}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="btnSmall"
            onClick={() => void saveActive()}
            disabled={!activeTab || activeTab.viewerKind !== "text" || !activeTab.dirty || activeTab.loading || Boolean(activeTab.error)}
            title="Save (Ctrl/Cmd+S)"
          >
            {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : "Save"}
          </button>
          <button type="button" className="btnSmall btnIcon" onClick={requestCloseEditor} title="Close editor">
            <Icon name="close" />
          </button>
        </div>
      </div>

      {crossFindOpen ? (
        <div className="codeEditorCrossFind">
          <input
            className="fileViewerInput fileViewerSearchInput"
            value={crossFind}
            onChange={(e) => setCrossFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runCrossFind(false);
            }}
            placeholder="find in open files"
          />
          <button
            type="button"
            className={`btnSmall ${crossCase ? "pdfViewerFitActive" : ""}`}
            onClick={() => setCrossCase((v) => !v)}
            title="Case sensitive"
          >
            Aa
          </button>
          <button type="button" className="btnSmall" onClick={() => runCrossFind(false)} disabled={!crossFind}>
            Count
          </button>
          <input
            className="fileViewerInput fileViewerSearchInput"
            value={crossReplace}
            onChange={(e) => setCrossReplace(e.target.value)}
            placeholder="replace with"
          />
          <button type="button" className="btnSmall" onClick={() => runCrossFind(true)} disabled={!crossFind}>
            Replace all
          </button>
          {crossStatus ? <span className="fileViewerMuted">{crossStatus}</span> : null}
        </div>
      ) : null}

      {activeTab && !isBrowserPath(activeTab.path) ? (
        <div className="codeEditorPathBar">
          <span className="codeEditorPathBarText" title={activeTab.path}>
            {activeTab.path}
          </span>
          {!activeTab.loading && !activeTab.error ? (
            <select
              className="codeEditorViewAs"
              title="View as"
              value={activeTab.requestedMode}
              onChange={(e) => {
                const value = e.target.value;
                if (value === "browser") {
                  void openHtmlInBrowser(activeTab.path);
                  return;
                }
                void openFile(activeTab.path, value as CodeEditorOpenMode);
              }}
            >
              <option value="auto">Auto</option>
              <option value="text">Text</option>
              <option value="markdown">Markdown</option>
              <option value="json">JSON tree</option>
              <option value="csv">CSV table</option>
              <option value="image">Image</option>
              <option value="bytes">Bytes</option>
              {isHtmlPath(activeTab.path) ? <option value="browser">Browser</option> : null}
            </select>
          ) : null}
        </div>
      ) : null}

      <div className="codeEditorBody">
        {!activeTab ? <div className="empty">No file selected.</div> : null}

        {tabs.length ? (
          <div className={`codeEditorMonaco ${activeTab?.viewerKind === "text" || !activeTab?.viewerKind ? "" : "codeEditorMonacoHidden"}`}>
            <Editor
              theme={editorTheme}
              onMount={onMount}
              keepCurrentModel
              defaultLanguage="plaintext"
              defaultPath="inmemory://model/initial"
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderWhitespace: "none",
                wordWrap: "off",
                tabSize: 2,
                fontSize: 12,
                fontLigatures: true,
                smoothScrolling: true,
                folding: true,
                foldingStrategy: "auto",
                showFoldingControls: "mouseover",
                bracketPairColorization: { enabled: true },
                guides: { bracketPairs: "active", indentation: true },
                stickyScroll: { enabled: true },
                "semanticHighlighting.enabled": true,
              }}
            />
          </div>
        ) : null}

        {activeTab && !activeTab.loading && !activeTab.error && activeTab.viewerKind === "image" ? (
          <ImageViewer
            key={`image:${activeTab.path}:${activeTab.size ?? 0}`}
            path={activeTab.path}
            size={activeTab.size ?? 0}
            mime={activeTab.mime ?? "application/octet-stream"}
            readRange={readFileRange}
            onOpenBytes={() => void openFile(activeTab.path, "bytes")}
          />
        ) : null}

        {activeTab && !activeTab.loading && !activeTab.error && activeTab.viewerKind === "bytes" ? (
          <ByteViewer
            key={`bytes:${activeTab.path}:${activeTab.size ?? 0}`}
            path={activeTab.path}
            size={activeTab.size ?? 0}
            readRange={readFileRange}
          />
        ) : null}

        {activeTab && !activeTab.loading && !activeTab.error && activeTab.viewerKind === "largeText" ? (
          <LargeTextViewer
            key={`large-text:${activeTab.path}:${activeTab.size ?? 0}`}
            path={activeTab.path}
            size={activeTab.size ?? 0}
            readRange={readFileRange}
            onOpenBytes={() => void openFile(activeTab.path, "bytes")}
          />
        ) : null}

        {activeTab && !activeTab.loading && !activeTab.error && activeTab.viewerKind === "pdf" ? (
          <React.Suspense fallback={<div className="codeEditorOverlay">Loading PDF…</div>}>
            <LazyPdfViewer
              key={`pdf:${activeTab.path}:${activeTab.size ?? 0}`}
              path={activeTab.path}
              size={activeTab.size ?? 0}
              readRange={readFileRange}
              onOpenBytes={() => void openFile(activeTab.path, "bytes")}
            />
          </React.Suspense>
        ) : null}

        {activeTab && !activeTab.loading && !activeTab.error && activeTab.viewerKind === "markdown" ? (
          <React.Suspense fallback={<div className="codeEditorOverlay">Loading…</div>}>
            <LazyMarkdownViewer
              key={`markdown:${activeTab.path}:${activeTab.size ?? 0}`}
              path={activeTab.path}
              size={activeTab.size ?? 0}
              readRange={readFileRange}
              onOpenBytes={() => void openFile(activeTab.path, "bytes")}
            />
          </React.Suspense>
        ) : null}

        {activeTab && !activeTab.loading && !activeTab.error && activeTab.viewerKind === "json" ? (
          <React.Suspense fallback={<div className="codeEditorOverlay">Loading…</div>}>
            <LazyJsonTreeViewer
              key={`json:${activeTab.path}:${activeTab.size ?? 0}`}
              path={activeTab.path}
              size={activeTab.size ?? 0}
              readRange={readFileRange}
              onOpenBytes={() => void openFile(activeTab.path, "bytes")}
            />
          </React.Suspense>
        ) : null}

        {activeTab && !activeTab.loading && !activeTab.error && activeTab.viewerKind === "csv" ? (
          <React.Suspense fallback={<div className="codeEditorOverlay">Loading…</div>}>
            <LazyCsvTableViewer
              key={`csv:${activeTab.path}:${activeTab.size ?? 0}`}
              path={activeTab.path}
              size={activeTab.size ?? 0}
              readRange={readFileRange}
              onOpenBytes={() => void openFile(activeTab.path, "bytes")}
            />
          </React.Suspense>
        ) : null}

        {activeTab && activeTab.viewerKind === "browser" && browserMetaRef.current.has(activeTab.path) ? (
          <React.Suspense fallback={<div className="codeEditorOverlay">Loading…</div>}>
            <LazyBrowserView
              key={`browser:${activeTab.path}`}
              label={browserMetaRef.current.get(activeTab.path)!.label}
              initialUrl={browserMetaRef.current.get(activeTab.path)!.url}
              suppressed={tabsMenuOpen || crossFindOpen || Boolean(tabMenu) || Boolean(pendingClose) || Boolean(saveConflictPath)}
              onUrlChange={(url) => {
                const meta = browserMetaRef.current.get(activeTab.path);
                if (meta) meta.url = url;
                const host = urlHost(url);
                updateTab(activeTab.path, (t) => (t.title === host ? t : { ...t, title: host }));
              }}
            />
          </React.Suspense>
        ) : null}

        {activeTab?.loading ? <div className="codeEditorOverlay">Loading…</div> : null}
        {activeTab?.error ? (
          <div className="codeEditorOverlay" title={activeTab.error}>
            {activeTab.error.length > 220 ? `${activeTab.error.slice(0, 220)}…` : activeTab.error}
          </div>
        ) : null}

        {saveStatus === "error" && saveError ? (
          <div className="codeEditorSaveError" role="status" title={saveError}>
            Failed to save.
          </div>
        ) : null}
      </div>

      <ConfirmActionModal
        isOpen={pendingClose != null}
        title={pendingClose?.kind === "tab" ? "Discard changes" : "Close editor"}
        message={
          pendingClose?.kind === "tab" ? (
            <>
              <div>
                Discard unsaved changes in{" "}
                <span style={{ fontFamily: "ui-monospace, monospace" }}>{basename(pendingClose.path)}</span>?
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {pendingClose.path}
              </div>
            </>
          ) : (
            <>
              <div>
                Close editor? You have{" "}
                <span style={{ fontFamily: "ui-monospace, monospace" }}>{dirtyCount}</span> unsaved file
                {dirtyCount === 1 ? "" : "s"}.
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                Unsaved changes are preserved when you reopen the editor.
              </div>
            </>
          )
        }
        confirmLabel={pendingClose?.kind === "tab" ? "Discard" : "Close"}
        confirmDanger={pendingClose?.kind === "tab"}
        onClose={() => setPendingClose(null)}
        onConfirm={() => {
          if (!pendingClose) return;
          const action = pendingClose;
          setPendingClose(null);
          if (action.kind === "tab") {
            closeTab(action.path);
            return;
          }
          onCloseEditor();
        }}
      />
      <ConfirmActionModal
        isOpen={saveConflictPath != null}
        title="File changed on disk"
        message={
          <>
            <div>This file was modified outside the editor since you opened it:</div>
            <div style={{ fontFamily: "ui-monospace, monospace", marginTop: 6, wordBreak: "break-all" }}>
              {saveConflictPath}
            </div>
            <div style={{ marginTop: 6 }}>Overwrite it with your version? (Close and reopen to keep the on-disk changes.)</div>
          </>
        }
        confirmLabel="Overwrite"
        confirmDanger
        onClose={() => setSaveConflictPath(null)}
        onConfirm={() => {
          const path = saveConflictPath;
          setSaveConflictPath(null);
          if (!path) return;
          const model = modelForPath(path);
          if (model) void performWrite(path, model);
        }}
      />
      {tabMenu ? (
        <div
          className="codeEditorTabMenuBackdrop"
          onClick={() => setTabMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setTabMenu(null);
          }}
        >
          <div
            className="codeEditorTabMenu"
            role="menu"
            style={{ left: Math.min(tabMenu.x, window.innerWidth - 190), top: Math.min(tabMenu.y, window.innerHeight - 240) }}
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const path = tabMenu.path;
              const all = tabsRef.current.map((t) => t.path);
              const idx = all.indexOf(path);
              const locked = tabs.find((t) => t.path === path)?.locked ?? false;
              const run = (fn: () => void) => {
                fn();
                setTabMenu(null);
              };
              const Item = ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => (
                <button type="button" className="codeEditorTabMenuItem" role="menuitem" disabled={disabled} onClick={() => run(onClick)}>
                  {label}
                </button>
              );
              return (
                <>
                  <Item label="Close" onClick={() => requestCloseTab(path)} />
                  <Item label="Close Others" onClick={() => closeTabs(all.filter((p) => p !== path))} disabled={all.length <= 1} />
                  <Item label="Close to the Right" onClick={() => closeTabs(all.slice(idx + 1))} disabled={idx < 0 || idx >= all.length - 1} />
                  <Item label="Close to the Left" onClick={() => closeTabs(all.slice(0, idx))} disabled={idx <= 0} />
                  <Item label="Close All" onClick={() => closeTabs(all)} disabled={all.length === 0} />
                  <div className="codeEditorTabMenuSep" />
                  <Item label={locked ? "Unlock" : "Lock"} onClick={() => toggleTabLock(path)} />
                  <Item label="Copy Path" onClick={() => void navigator.clipboard?.writeText(path)} />
                </>
              );
            })()}
          </div>
        </div>
      ) : null}
    </section>
  );
});

function ImageViewer({
  path,
  size,
  mime,
  readRange,
  onOpenBytes,
}: {
  path: string;
  size: number;
  mime: string;
  readRange: ReadRangeFn;
  onOpenBytes: () => void;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = React.useState(1);
  const [fit, setFit] = React.useState(true);
  const [checker, setChecker] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const zoomBy = React.useCallback((factor: number) => {
    setFit(false);
    setScale((prev) => Math.min(32, Math.max(0.05, prev * factor)));
  }, []);

  // Fit-to-window: recompute scale from the container and the image's natural
  // size while Fit is engaged (and on resize).
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !natural || !fit) return;
    const apply = () => {
      const availW = el.clientWidth - 28;
      const availH = el.clientHeight - 28;
      if (availW <= 0 || availH <= 0) return;
      const next = Math.min(availW / natural.w, availH / natural.h, 1);
      if (next > 0) setScale(next);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural, fit]);

  React.useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setLoaded(0);
    setError(null);
    setNatural(null);

    if (size > IMAGE_PREVIEW_MAX_BYTES) return;

    const run = async () => {
      try {
        const parts: Uint8Array[] = [];
        for (let offset = 0; offset < size; offset += RANGE_CHUNK_BYTES) {
          if (cancelled) return;
          const length = Math.min(RANGE_CHUNK_BYTES, size - offset);
          const chunk = await readRange(path, offset, length);
          if (cancelled) return;
          parts.push(chunk);
          setLoaded(Math.min(size, offset + chunk.length));
          if (chunk.length === 0 || chunk.length < length) break;
        }
        if (cancelled) return;
        const blobParts = parts.map((part) =>
          part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer,
        );
        objectUrl = URL.createObjectURL(new Blob(blobParts, { type: mime || "application/octet-stream" }));
        setUrl(objectUrl);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mime, path, readRange, size]);

  if (size > IMAGE_PREVIEW_MAX_BYTES) {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Image preview skipped</div>
        <div className="fileViewerMuted">{formatBytes(size)} exceeds the preview limit.</div>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Image failed to load</div>
        <div className="fileViewerMuted" title={error}>{error}</div>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Loading image</div>
        <div className="fileViewerMuted">
          {formatBytes(loaded)} / {formatBytes(size)}
        </div>
      </div>
    );
  }

  const dims = natural ? `${natural.w}×${natural.h}` : "";
  return (
    <div className="imageViewer">
      <div className="fileViewerToolbar">
        <span>{dims ? `${dims} · ` : ""}{formatBytes(size)}</span>
        <span className="pdfViewerSpacer" />
        <button type="button" className="btnSmall" onClick={() => zoomBy(1 / 1.25)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <span className="pdfViewerZoom">{Math.round(scale * 100)}%</span>
        <button type="button" className="btnSmall" onClick={() => zoomBy(1.25)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button
          type="button"
          className={`btnSmall ${fit ? "pdfViewerFitActive" : ""}`}
          onClick={() => setFit((prev) => !prev)}
          title="Fit to window"
        >
          Fit
        </button>
        <button
          type="button"
          className="btnSmall"
          onClick={() => {
            setFit(false);
            setScale(1);
          }}
          title="Actual size"
        >
          1:1
        </button>
        <button
          type="button"
          className={`btnSmall ${checker ? "pdfViewerFitActive" : ""}`}
          onClick={() => setChecker((prev) => !prev)}
          title="Transparency checkerboard"
          aria-label="Toggle transparency checkerboard"
        >
          ▦
        </button>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
      <div
        className="imageViewerScroll"
        ref={scrollRef}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
          }
        }}
      >
        <img
          className={`imageViewerImg ${checker ? "imageViewerChecker" : ""}`}
          src={url}
          alt={basename(path)}
          draggable={false}
          style={natural ? { width: Math.round(natural.w * scale), height: Math.round(natural.h * scale) } : undefined}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
          onError={() => setError("The image decoder rejected this file.")}
        />
      </div>
    </div>
  );
}

function ByteViewer({ path, size, readRange }: { path: string; size: number; readRange: ReadRangeFn }) {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const cacheRef = React.useRef<Map<number, { bytes: Uint8Array; lastUsed: number }>>(new Map());
  const pendingRef = React.useRef<Set<number>>(new Set());
  const cacheBytesRef = React.useRef(0);
  const [version, setVersion] = React.useState(0);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [listHeight, setListHeight] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [jumpValue, setJumpValue] = React.useState("");
  const [findValue, setFindValue] = React.useState("");
  const [findMode, setFindMode] = React.useState<"hex" | "text">("hex");
  const [findStatus, setFindStatus] = React.useState<string | null>(null);
  const [findBusy, setFindBusy] = React.useState(false);
  const findNextOffsetRef = React.useRef(0);
  const [inspectOffset, setInspectOffset] = React.useState<number | null>(null);
  const rowHeight = 22;
  const bytesPerRow = 16;
  const totalRows = Math.max(1, Math.ceil(size / bytesPerRow));
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 24);
  const endIndex = Math.min(totalRows, Math.ceil((scrollTop + listHeight) / rowHeight) + 24);

  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const sync = () => {
      setScrollTop(el.scrollTop);
      setListHeight(el.clientHeight);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, []);

  const touchChunk = React.useCallback((start: number): Uint8Array | null => {
    const item = cacheRef.current.get(start);
    if (!item) return null;
    item.lastUsed = Date.now();
    return item.bytes;
  }, []);

  const readChunk = React.useCallback(
    async (start: number) => {
      if (start >= size) return;
      if (cacheRef.current.has(start) || pendingRef.current.has(start)) return;
      pendingRef.current.add(start);
      setVersion((v) => v + 1);
      try {
        const length = Math.min(RANGE_CHUNK_BYTES, size - start);
        const bytes = await readRange(path, start, length);
        cacheRef.current.set(start, { bytes, lastUsed: Date.now() });
        cacheBytesRef.current += bytes.length;
        while (cacheBytesRef.current > MAX_VIEWER_CACHE_BYTES && cacheRef.current.size > 1) {
          let oldestKey: number | null = null;
          let oldestAt = Number.POSITIVE_INFINITY;
          for (const [key, value] of cacheRef.current.entries()) {
            if (value.lastUsed < oldestAt) {
              oldestAt = value.lastUsed;
              oldestKey = key;
            }
          }
          if (oldestKey == null) break;
          const removed = cacheRef.current.get(oldestKey);
          cacheRef.current.delete(oldestKey);
          cacheBytesRef.current -= removed?.bytes.length ?? 0;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        pendingRef.current.delete(start);
        setVersion((v) => v + 1);
      }
    },
    [path, readRange, size],
  );

  React.useEffect(() => {
    const firstByte = startIndex * bytesPerRow;
    const lastByte = Math.min(size, endIndex * bytesPerRow);
    const firstChunk = Math.floor(firstByte / RANGE_CHUNK_BYTES) * RANGE_CHUNK_BYTES;
    for (let start = firstChunk; start < lastByte; start += RANGE_CHUNK_BYTES) {
      void readChunk(start);
    }
  }, [endIndex, readChunk, size, startIndex, version]);

  const byteAt = React.useCallback(
    (offset: number): number | null => {
      if (offset >= size) return null;
      const chunkStart = Math.floor(offset / RANGE_CHUNK_BYTES) * RANGE_CHUNK_BYTES;
      const chunk = touchChunk(chunkStart);
      if (!chunk) return null;
      const idx = offset - chunkStart;
      return idx >= 0 && idx < chunk.length ? chunk[idx] : null;
    },
    [size, touchChunk],
  );

  const jumpToOffset = React.useCallback(() => {
    const trimmed = jumpValue.trim().replace(/^0x/i, "");
    const parsed = trimmed ? Number.parseInt(trimmed, 16) : 0;
    if (!Number.isFinite(parsed)) return;
    const row = Math.max(0, Math.min(totalRows - 1, Math.floor(parsed / bytesPerRow)));
    if (listRef.current) listRef.current.scrollTop = row * rowHeight;
    setInspectOffset(parsed);
  }, [jumpValue, totalRows]);

  const findFrom = React.useCallback(
    async (fromOffset: number) => {
      const needle = parseByteNeedle(findValue, findMode);
      if (!needle) {
        setFindStatus(findMode === "hex" ? "Enter hex bytes" : "Enter text");
        return;
      }
      setFindBusy(true);
      setFindStatus(null);
      try {
        let offset = Math.max(0, fromOffset);
        let overlap = new Uint8Array(0);
        while (offset < size) {
          const reqLen = Math.min(RANGE_CHUNK_BYTES, size - offset);
          const bytes = await readRange(path, offset, reqLen);
          const combined = overlap.length ? concatBytes([overlap, bytes]) : bytes;
          const found = indexOfBytes(combined, needle, 0);
          if (found >= 0) {
            const absolute = offset - overlap.length + found;
            const row = Math.max(0, Math.floor(absolute / bytesPerRow));
            if (listRef.current) listRef.current.scrollTop = row * rowHeight;
            findNextOffsetRef.current = absolute + 1;
            setFindStatus(`0x${absolute.toString(16)}`);
            return;
          }
          overlap = needle.length > 1 ? bytes.slice(Math.max(0, bytes.length - needle.length + 1)) : new Uint8Array(0);
          offset = offset + bytes.length;
          if (bytes.length === 0 || bytes.length < reqLen) break;
        }
        findNextOffsetRef.current = 0;
        setFindStatus("No match");
      } catch (err) {
        setFindStatus(err instanceof Error ? err.message : String(err));
      } finally {
        setFindBusy(false);
      }
    },
    [findMode, findValue, path, readRange, size],
  );

  const rows: React.ReactNode[] = [];
  for (let row = startIndex; row < endIndex; row++) {
    const offset = row * bytesPerRow;
    const hex: React.ReactNode[] = [];
    const ascii: React.ReactNode[] = [];
    for (let i = 0; i < bytesPerRow; i++) {
      const value = byteAt(offset + i);
      hex.push(
        <span key={`h:${i}`} className={value == null ? "byteViewerMissing" : ""}>
          {value == null ? ".." : value.toString(16).padStart(2, "0")}
        </span>,
      );
      ascii.push(
        <span key={`a:${i}`} className={value == null ? "byteViewerMissing" : ""}>
          {value == null ? "." : byteToAscii(value)}
        </span>,
      );
    }
    rows.push(
      <div className="byteViewerRow" style={{ height: rowHeight }} key={offset}>
        <span className="byteViewerOffset">{offset.toString(16).padStart(8, "0")}</span>
        <span className="byteViewerHex">{hex}</span>
        <span className="byteViewerAscii">{ascii}</span>
      </div>,
    );
  }

  // Data inspector: interpret the up-to-8 bytes at the inspect offset (little-endian).
  let inspect: string | null = null;
  if (inspectOffset != null && inspectOffset >= 0 && inspectOffset < size) {
    const buf = new Uint8Array(8);
    let have = 0;
    for (let i = 0; i < 8 && inspectOffset + i < size; i++) {
      const value = byteAt(inspectOffset + i);
      if (value == null) break;
      buf[i] = value;
      have += 1;
    }
    if (have === 0) {
      inspect = "loading…";
    } else {
      const dv = new DataView(buf.buffer);
      const parts = [`u8 ${buf[0]}`, `i8 ${dv.getInt8(0)}`];
      if (have >= 2) parts.push(`u16 ${dv.getUint16(0, true)}`, `i16 ${dv.getInt16(0, true)}`);
      if (have >= 4)
        parts.push(`u32 ${dv.getUint32(0, true)}`, `i32 ${dv.getInt32(0, true)}`, `f32 ${dv.getFloat32(0, true).toPrecision(6)}`);
      if (have >= 8) parts.push(`u64 ${dv.getBigUint64(0, true)}`, `f64 ${dv.getFloat64(0, true).toPrecision(8)}`);
      inspect = parts.join("  ");
    }
  }

  return (
    <div className="byteViewer">
      <div className="fileViewerToolbar">
        <span>{formatBytes(size)}</span>
        <input
          className="fileViewerInput"
          value={jumpValue}
          onChange={(e) => setJumpValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") jumpToOffset();
          }}
          placeholder="offset hex"
        />
        <button type="button" className="btnSmall" onClick={jumpToOffset}>
          Go
        </button>
        <button
          type="button"
          className="btnSmall"
          onClick={() => setFindMode((m) => (m === "hex" ? "text" : "hex"))}
          title="Toggle search between hex bytes and text"
        >
          {findMode === "hex" ? "hex" : "txt"}
        </button>
        <input
          className="fileViewerInput fileViewerSearchInput"
          value={findValue}
          onChange={(e) => setFindValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void findFrom(0);
          }}
          placeholder={findMode === "hex" ? "ff d8 ff" : "find text"}
        />
        <button type="button" className="btnSmall" onClick={() => void findFrom(0)} disabled={findBusy || !findValue}>
          {findBusy ? "…" : "Find"}
        </button>
        <button
          type="button"
          className="btnSmall"
          onClick={() => void findFrom(findNextOffsetRef.current)}
          disabled={findBusy || !findValue}
          title="Find next"
        >
          Next
        </button>
        {findStatus ? <span className="fileViewerMuted">{findStatus}</span> : null}
        {error ? <span className="fileViewerError" title={error}>{error}</span> : null}
      </div>
      {inspect ? (
        <div className="byteViewerInspect">
          @0x{(inspectOffset ?? 0).toString(16)} LE&nbsp;&nbsp;{inspect}
        </div>
      ) : null}
      <div className="byteViewerList" ref={listRef}>
        <div style={{ paddingTop: startIndex * rowHeight, paddingBottom: Math.max(0, (totalRows - endIndex) * rowHeight) }}>
          {rows}
        </div>
      </div>
    </div>
  );
}

type LineCheckpoint = { line: number; offset: number };

function countNewlines(bytes: Uint8Array, end = bytes.length): number {
  let count = 0;
  const limit = Math.min(end, bytes.length);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 10) count += 1;
  }
  return count;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, startAt: number): number {
  if (needle.length === 0) return -1;
  outer: for (let i = Math.max(0, startAt); i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function foldAscii(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte; // A-Z -> a-z
}

// Like indexOfBytes but optionally case-folds ASCII letters on both sides.
function indexOfBytesFold(haystack: Uint8Array, needle: Uint8Array, startAt: number, fold: boolean): number {
  if (!fold) return indexOfBytes(haystack, needle, startAt);
  if (needle.length === 0) return -1;
  outer: for (let i = Math.max(0, startAt); i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (foldAscii(haystack[i + j]) !== foldAscii(needle[j])) continue outer;
    }
    return i;
  }
  return -1;
}

// Parse a byte-search needle: "hex" mode accepts pairs like "ff d8 ff" / "FFD8";
// "text" mode encodes the literal UTF-8 bytes.
function parseByteNeedle(value: string, mode: "hex" | "text"): Uint8Array | null {
  if (mode === "text") {
    const bytes = new TextEncoder().encode(value);
    return bytes.length ? bytes : null;
  }
  const cleaned = value.replace(/0x/gi, "").replace(/[\s,]/g, "");
  if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-fA-F]/.test(cleaned)) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function LargeTextViewer({
  path,
  size,
  readRange,
  onOpenBytes,
}: {
  path: string;
  size: number;
  readRange: ReadRangeFn;
  onOpenBytes: () => void;
}) {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const readChunk = useChunkCache();
  const checkpointsRef = React.useRef<LineCheckpoint[]>([{ line: 0, offset: 0 }]);
  const [indexState, setIndexState] = React.useState({ offset: 0, lines: 0, done: size === 0, totalLines: size === 0 ? 1 : 0 });
  const [scrollTop, setScrollTop] = React.useState(0);
  const [listHeight, setListHeight] = React.useState(0);
  const [lineInput, setLineInput] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [caseInsensitive, setCaseInsensitive] = React.useState(false);
  const [searchStatus, setSearchStatus] = React.useState<string | null>(null);
  const [searchBusy, setSearchBusy] = React.useState(false);
  const lastMatchLineRef = React.useRef(-1);
  const [error, setError] = React.useState<string | null>(null);
  const [windowLines, setWindowLines] = React.useState<{ baseLine: number; lines: string[]; partial: boolean } | null>(null);
  const rowHeight = 20;
  const indexedRatio = size > 0 ? indexState.offset / size : 1;
  const estimatedRows = indexState.done
    ? Math.max(1, indexState.totalLines)
    : Math.max(indexState.lines + 2048, Math.ceil(size / Math.max(48, indexState.offset / Math.max(1, indexState.lines || 1))));
  const totalRows = Math.max(1, estimatedRows);
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 16);
  const endIndex = Math.min(totalRows, Math.ceil((scrollTop + listHeight) / rowHeight) + 16);

  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const sync = () => {
      setScrollTop(el.scrollTop);
      setListHeight(el.clientHeight);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const checkpoints: LineCheckpoint[] = [{ line: 0, offset: 0 }];
    checkpointsRef.current = checkpoints;

    const run = async () => {
      let offset = 0;
      let line = 0;
      let lastByte: number | null = null;
      let lastPublish = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        while (offset < size && !cancelled) {
          const reqLen = Math.min(RANGE_CHUNK_BYTES, size - offset);
          const bytes = await readRange(path, offset, reqLen);
          if (cancelled) return;
          const eof = bytes.length < reqLen;
          // Validate UTF-8 as a stream so multibyte characters split across ranges are accepted.
          decoder.decode(bytes, { stream: !(eof || offset + bytes.length >= size) });
          for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 10) {
              line += 1;
              if (line % 1024 === 0) checkpoints.push({ line, offset: offset + i + 1 });
            }
          }
          if (bytes.length > 0) lastByte = bytes[bytes.length - 1];
          offset = offset + bytes.length;
          const now = Date.now();
          if (now - lastPublish > 120 || eof) {
            lastPublish = now;
            checkpointsRef.current = checkpoints.slice();
            setIndexState({
              offset,
              lines: line,
              done: eof || offset >= size,
              totalLines: eof || offset >= size ? Math.max(1, line + (lastByte === 10 ? 0 : 1)) : 0,
            });
          }
          if (bytes.length === 0 || eof) break;
        }
        decoder.decode();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [path, readRange, size]);

  const findCheckpoint = React.useCallback((line: number): LineCheckpoint => {
    const checkpoints = checkpointsRef.current;
    let lo = 0;
    let hi = checkpoints.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (checkpoints[mid].line <= line) lo = mid + 1;
      else hi = mid - 1;
    }
    return checkpoints[Math.max(0, hi)] ?? { line: 0, offset: 0 };
  }, []);

  React.useEffect(() => {
    if (error) return;
    if (!indexState.done && startIndex > indexState.lines) {
      setWindowLines(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const checkpoint = findCheckpoint(startIndex);
      try {
        const result = await readChunk(readRange, path, checkpoint.offset, Math.min(MAX_RANGE_BYTES, size - checkpoint.offset));
        if (cancelled) return;
        const bytes = result.bytes;
        const decoded = new TextDecoder("utf-8").decode(bytes);
        const rawLines = decoded.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
        const skip = Math.max(0, startIndex - checkpoint.line);
        setWindowLines({
          baseLine: checkpoint.line + skip,
          lines: rawLines.slice(skip, skip + Math.max(32, endIndex - startIndex + 32)),
          partial: !result.eof && checkpoint.offset + bytes.length < size,
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [endIndex, error, findCheckpoint, indexState.done, indexState.lines, path, readChunk, readRange, size, startIndex]);

  const scrollToLine = React.useCallback((line: number) => {
    const target = Math.max(0, Math.min(totalRows - 1, line));
    if (listRef.current) listRef.current.scrollTop = target * rowHeight;
  }, [totalRows]);

  const submitLineJump = React.useCallback(() => {
    const parsed = Number.parseInt(lineInput.trim(), 10);
    if (!Number.isFinite(parsed)) return;
    scrollToLine(Math.max(0, parsed - 1));
  }, [lineInput, scrollToLine]);

  const findFromLine = React.useCallback(
    async (minLine: number) => {
      const needle = new TextEncoder().encode(query);
      if (needle.length === 0) return;
      setSearchBusy(true);
      setSearchStatus(null);
      try {
        const start = findCheckpoint(Math.max(0, minLine));
        let offset = start.offset;
        let line = start.line;
        let overlap = new Uint8Array(0);
        while (offset < size) {
          const reqLen = Math.min(RANGE_CHUNK_BYTES, size - offset);
          const bytes = await readRange(path, offset, reqLen);
          const combined = overlap.length ? concatBytes([overlap, bytes]) : bytes;
          const baseLine = line - countNewlines(overlap);
          let from = 0;
          for (;;) {
            const found = indexOfBytesFold(combined, needle, from, caseInsensitive);
            if (found < 0) break;
            const matchedLine = baseLine + countNewlines(combined, found);
            if (matchedLine >= minLine) {
              scrollToLine(matchedLine);
              lastMatchLineRef.current = matchedLine;
              setSearchStatus(`Line ${matchedLine + 1}`);
              return;
            }
            from = found + 1;
          }
          line += countNewlines(bytes);
          overlap = needle.length > 1 ? bytes.slice(Math.max(0, bytes.length - needle.length + 1)) : new Uint8Array(0);
          offset = offset + bytes.length;
          if (bytes.length === 0 || bytes.length < reqLen) break;
        }
        lastMatchLineRef.current = -1;
        setSearchStatus("No match");
      } catch (err) {
        setSearchStatus(err instanceof Error ? err.message : String(err));
      } finally {
        setSearchBusy(false);
      }
    },
    [caseInsensitive, findCheckpoint, path, query, readRange, scrollToLine, size],
  );

  const rows: React.ReactNode[] = [];
  for (let row = startIndex; row < endIndex; row++) {
    const text =
      windowLines && row >= windowLines.baseLine && row < windowLines.baseLine + windowLines.lines.length
        ? windowLines.lines[row - windowLines.baseLine]
        : !indexState.done && row > indexState.lines
          ? "Indexing..."
          : "";
    rows.push(
      <div className="largeTextRow" style={{ height: rowHeight }} key={row}>
        <span className="largeTextLineNo">{row + 1}</span>
        <span className="largeTextLine">{text}</span>
      </div>,
    );
  }

  if (error) {
    return (
      <div className="fileViewerCenter">
        <div className="fileViewerTitle">Text viewer stopped</div>
        <div className="fileViewerMuted" title={error}>{error}</div>
        <button type="button" className="btnSmall" onClick={onOpenBytes}>
          Open bytes
        </button>
      </div>
    );
  }

  return (
    <div className="largeTextViewer">
      <div className="fileViewerToolbar">
        <span>{formatBytes(size)}</span>
        <span>{indexState.done ? `${indexState.totalLines} lines` : `Indexed ${Math.round(indexedRatio * 100)}%`}</span>
        <input
          className="fileViewerInput"
          value={lineInput}
          onChange={(e) => setLineInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitLineJump();
          }}
          placeholder="line"
        />
        <button type="button" className="btnSmall" onClick={submitLineJump}>
          Go
        </button>
        <button type="button" className="btnSmall" onClick={() => scrollToLine(totalRows - 1)}>
          Tail
        </button>
        <input
          className="fileViewerInput fileViewerSearchInput"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void findFromLine(0);
          }}
          placeholder="find text"
        />
        <button
          type="button"
          className={`btnSmall ${caseInsensitive ? "pdfViewerFitActive" : ""}`}
          onClick={() => setCaseInsensitive((prev) => !prev)}
          title="Case-insensitive"
          aria-label="Toggle case-insensitive search"
        >
          Aa
        </button>
        <button type="button" className="btnSmall" onClick={() => void findFromLine(0)} disabled={searchBusy || !query}>
          {searchBusy ? "Finding..." : "Find"}
        </button>
        <button
          type="button"
          className="btnSmall"
          onClick={() => void findFromLine(lastMatchLineRef.current + 1)}
          disabled={searchBusy || !query}
          title="Find next"
        >
          Next
        </button>
        {searchStatus ? <span className="fileViewerMuted">{searchStatus}</span> : null}
      </div>
      <div className="largeTextList" ref={listRef}>
        <div style={{ paddingTop: startIndex * rowHeight, paddingBottom: Math.max(0, (totalRows - endIndex) * rowHeight) }}>
          {rows}
        </div>
      </div>
    </div>
  );
}

export default CodeEditorPanel;
