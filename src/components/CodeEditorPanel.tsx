import "../monaco/monacoEnv";
import { invoke } from "@tauri-apps/api/core";
import Editor, { loader } from "@monaco-editor/react";
import * as bundledMonaco from "monaco-editor";
import React from "react";
import { shortenPathSmart } from "../pathDisplay";
import { Icon } from "./Icon";
import { ConfirmActionModal } from "./modals/ConfirmActionModal";

type MonacoType = typeof import("monaco-editor");

export type CodeEditorOpenFileRequest = { path: string; nonce: number };

loader.config({ monaco: bundledMonaco });

export type CodeEditorPersistedTab = {
  path: string;
  dirty: boolean;
  content: string | null;
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
  dirty: boolean;
  loading: boolean;
  error: string | null;
};

type PendingCloseAction =
  | { kind: "editor" }
  | { kind: "tab"; path: string };

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

function inferLanguageId(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
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
      return "plaintext";
  }
}

export function CodeEditorPanel({
  provider,
  sshTarget,
  rootDir,
  openFileRequest,
  persistedState,
  fsEvent,
  onPersistState,
  onConsumeOpenFileRequest,
  onActiveFilePathChange,
  onCloseEditor,
}: {
  provider: "local" | "ssh";
  sshTarget?: string | null;
  rootDir: string;
  openFileRequest: CodeEditorOpenFileRequest | null;
  persistedState: CodeEditorPersistedState | null;
  fsEvent?: CodeEditorFsEvent | null;
  onPersistState: (state: CodeEditorPersistedState) => void;
  onConsumeOpenFileRequest?: () => void;
  onActiveFilePathChange: (path: string | null) => void;
  onCloseEditor: () => void;
}) {
  const [tabs, setTabs] = React.useState<Tab[]>([]);
  const [activePath, setActivePath] = React.useState<string | null>(null);
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [pendingClose, setPendingClose] = React.useState<PendingCloseAction | null>(null);
  const saveTimerRef = React.useRef<number | null>(null);
  const sshTargetValue = React.useMemo(() => (sshTarget ?? "").trim() || null, [sshTarget]);
  const tabStripRef = React.useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());
  const [tabsMenuOpen, setTabsMenuOpen] = React.useState(false);
  const tabsMenuRef = React.useRef<HTMLDivElement | null>(null);
  const tabsMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);

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

  const onPersistStateRef = React.useRef(onPersistState);
  React.useEffect(() => {
    onPersistStateRef.current = onPersistState;
  }, [onPersistState]);

  const onConsumeOpenFileRequestRef = React.useRef(onConsumeOpenFileRequest);
  React.useEffect(() => {
    onConsumeOpenFileRequestRef.current = onConsumeOpenFileRequest;
  }, [onConsumeOpenFileRequest]);

  const onActiveFilePathChangeRef = React.useRef(onActiveFilePathChange);
  React.useEffect(() => {
    onActiveFilePathChangeRef.current = onActiveFilePathChange;
  }, [onActiveFilePathChange]);

  const activePathRef = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    activePathRef.current = activePath;
    onActiveFilePathChangeRef.current(activePath);
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
    const currentTabs = tabsRef.current;
    const outTabs: CodeEditorPersistedTab[] = currentTabs.map((tab) => {
      const dirty = dirtyPathsRef.current.has(tab.path) || tab.dirty;
      const content = dirty ? readModelValue(tab.path) ?? "" : null;
      return { path: tab.path, dirty, content };
    });
    return { tabs: outTabs, activePath: activePathRef.current };
  }, [readModelValue]);

  React.useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      try {
        onPersistStateRef.current(serializeState());
      } catch {
        // Best-effort: preserve editor state when possible.
      }
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

  const openFile = React.useCallback(
    async (path: string) => {
      const normalized = path.trim();
      if (!normalized) return;

      if (openPathsRef.current.has(normalized)) {
        setActivePath(normalized);
        activePathRef.current = normalized;
        const monaco = monacoRef.current;
        const hasModel =
          modelsRef.current.has(normalized) ||
          (monaco ? Boolean(monaco.editor.getModel(modelUriForPath(monaco, normalized))) : false);
        if (hasModel) {
          setEditorModel(normalized);
          return;
        }
        if (loadNonceByPathRef.current.has(normalized)) {
          return;
        }
        updateTab(normalized, (tab) => ({ ...tab, loading: true, error: null }));
        const loadNonce = nextLoadNonceRef.current++;
        loadNonceByPathRef.current.set(normalized, loadNonce);
        try {
          const content = await readTextFile(normalized);
          if (!openPathsRef.current.has(normalized)) return;
          if (loadNonceByPathRef.current.get(normalized) !== loadNonce) return;
          ensureModel(normalized, content);
          updateTab(normalized, (tab) => ({ ...tab, loading: false, error: null }));
          if (activePathRef.current === normalized) setEditorModel(normalized);
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
        return;
      }

      openPathsRef.current.add(normalized);
      setTabs((prev) => {
        const next = [
          ...prev,
          { path: normalized, title: basename(normalized), dirty: false, loading: true, error: null },
        ];
        tabsRef.current = next;
        return next;
      });
      setActivePath(normalized);
      activePathRef.current = normalized;

      const loadNonce = nextLoadNonceRef.current++;
      loadNonceByPathRef.current.set(normalized, loadNonce);
      try {
        const content = await readTextFile(normalized);
        if (!openPathsRef.current.has(normalized)) return;
        if (loadNonceByPathRef.current.get(normalized) !== loadNonce) return;
        ensureModel(normalized, content);
        updateTab(normalized, (tab) => ({ ...tab, loading: false, error: null }));
        if (activePathRef.current === normalized) setEditorModel(normalized);
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
    },
    [ensureModel, modelUriForPath, readTextFile, setEditorModel, updateTab],
  );

  React.useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!persistedState) return;
    if (!persistedState.tabs.length) return;

    const nextTabs: Tab[] = persistedState.tabs.map((it) => ({
      path: it.path,
      title: basename(it.path),
      dirty: it.dirty,
      loading: it.content == null,
      error: null,
    }));
    setTabs(nextTabs);
    openPathsRef.current = new Set(persistedState.tabs.map((t) => t.path));
    dirtyPathsRef.current = new Set(persistedState.tabs.filter((t) => t.dirty).map((t) => t.path));

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
    const key = `${openFileRequest.nonce}:${openFileRequest.path}`;
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
      void openFile(openFileRequest.path);
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

  const saveActive = React.useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;
    if (!dirtyPathsRef.current.has(path)) return;

    const monaco = monacoRef.current;
    const model = monaco ? monaco.editor.getModel(modelUriForPath(monaco, path)) : modelsRef.current.get(path);
    if (!model) return;

    setSaveStatus("saving");
    setSaveError(null);
    try {
      await writeTextFile(path, model.getValue());
      dirtyPathsRef.current.delete(path);
      updateTab(path, (tab) => ({ ...tab, dirty: false }));
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
  }, [modelUriForPath, updateTab, writeTextFile]);

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
                <div
                  key={tab.path}
                  className={`codeEditorTab ${tab.path === activePath ? "codeEditorTabActive" : ""}`}
                  role="tab"
                  aria-selected={tab.path === activePath}
                >
                  <button
                    type="button"
                    className="codeEditorTabMain"
                    onClick={() => void openFile(tab.path)}
                    onAuxClick={(e) => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      requestCloseTab(tab.path);
                    }}
                    ref={(el) => {
                      if (!el) tabButtonRefs.current.delete(tab.path);
                      else tabButtonRefs.current.set(tab.path, el);
                    }}
                    title={tab.path}
                  >
                    <span className="codeEditorTabTitle">
                      {tab.title}
                      {suffix ? <span className="codeEditorTabTitleSuffix">{suffix}</span> : null}
                    </span>
                    {tab.dirty ? <span className="codeEditorTabDirty" aria-label="Unsaved changes" /> : null}
                  </button>
                  <button
                    type="button"
                    className="codeEditorTabClose"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestCloseTab(tab.path);
                    }}
                    title="Close"
                    aria-label={`Close ${tab.title}`}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
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
            disabled={!activeTab || !activeTab.dirty || activeTab.loading || Boolean(activeTab.error)}
            title="Save (Ctrl/Cmd+S)"
          >
            {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : "Save"}
          </button>
          <button type="button" className="btnSmall btnIcon" onClick={requestCloseEditor} title="Close editor">
            <Icon name="close" />
          </button>
        </div>
      </div>

      {activeTab ? (
        <div className="codeEditorPathBar" title={activeTab.path}>
          {activeTab.path}
        </div>
      ) : null}

      <div className="codeEditorBody">
        {!activeTab ? <div className="empty">No file selected.</div> : null}

        {tabs.length ? (
          <div className="codeEditorMonaco">
          <Editor
            theme="vs-dark"
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
              }}
            />
            {activeTab?.loading ? <div className="codeEditorOverlay">Loading…</div> : null}
            {activeTab?.error ? (
              <div className="codeEditorOverlay" title={activeTab.error}>
                {activeTab.error.length > 220 ? `${activeTab.error.slice(0, 220)}…` : activeTab.error}
              </div>
            ) : null}
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
    </section>
  );
}

export default CodeEditorPanel;
