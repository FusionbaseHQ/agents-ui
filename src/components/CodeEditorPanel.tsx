import "../monaco/monacoEnv";
import { invoke } from "@tauri-apps/api/core";
import Editor, { loader } from "@monaco-editor/react";
import * as bundledMonaco from "monaco-editor";
import React from "react";
import { shortenPathSmart } from "../pathDisplay";
import { Icon } from "./Icon";

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

type Tab = {
  path: string;
  title: string;
  dirty: boolean;
  loading: boolean;
  error: string | null;
};

function basename(path: string): string {
  const cleaned = path.trim().replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
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
  rootDir,
  openFileRequest,
  persistedState,
  onPersistState,
  onConsumeOpenFileRequest,
  onActiveFilePathChange,
  onCloseEditor,
}: {
  rootDir: string;
  openFileRequest: CodeEditorOpenFileRequest | null;
  persistedState: CodeEditorPersistedState | null;
  onPersistState: (state: CodeEditorPersistedState) => void;
  onConsumeOpenFileRequest?: () => void;
  onActiveFilePathChange: (path: string | null) => void;
  onCloseEditor: () => void;
}) {
  const [tabs, setTabs] = React.useState<Tab[]>([]);
  const [activePath, setActivePath] = React.useState<string | null>(null);
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const saveTimerRef = React.useRef<number | null>(null);

  const restoredRef = React.useRef(false);
  const lastOpenRequestRef = React.useRef<string | null>(null);
  const tabsRef = React.useRef<Tab[]>([]);
  React.useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const openPathsRef = React.useRef<Set<string>>(new Set());
  const dirtyPathsRef = React.useRef<Set<string>>(new Set());
  const modelsRef = React.useRef<Map<string, import("monaco-editor").editor.ITextModel>>(new Map());
  const pendingContentRef = React.useRef<Map<string, string>>(new Map());
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

  const activePathRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    activePathRef.current = activePath;
    onActiveFilePathChange(activePath);
  }, [activePath, onActiveFilePathChange]);

  const readModelValue = React.useCallback((path: string): string | null => {
    const monaco = monacoRef.current;
    if (monaco) {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      if (model) return model.getValue();
    }
    const model = modelsRef.current.get(path);
    if (model) return model.getValue();
    const pending = pendingContentRef.current.get(path);
    return pending ?? null;
  }, []);

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

      const uri = monaco.Uri.file(path);
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
    [markDirty],
  );

  const setEditorModel = React.useCallback((path: string | null) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    if (!path) {
      editor.setModel(null);
      return;
    }
    const model = modelsRef.current.get(path) ?? monaco.editor.getModel(monaco.Uri.file(path));
    if (!model) return;
    modelsRef.current.set(path, model);
    editor.setModel(model);
  }, []);

  const openFile = React.useCallback(
    async (path: string) => {
      const normalized = path.trim();
      if (!normalized) return;

      if (openPathsRef.current.has(normalized)) {
        setActivePath(normalized);
        const monaco = monacoRef.current;
        const hasModel =
          modelsRef.current.has(normalized) ||
          (monaco ? Boolean(monaco.editor.getModel(monaco.Uri.file(normalized))) : false);
        if (hasModel) {
          setEditorModel(normalized);
          return;
        }
        updateTab(normalized, (tab) => ({ ...tab, loading: true, error: null }));
        try {
          const content = await invoke<string>("read_text_file", { root: rootDir, path: normalized });
          ensureModel(normalized, content);
          updateTab(normalized, (tab) => ({ ...tab, loading: false, error: null }));
          setEditorModel(normalized);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          updateTab(normalized, (tab) => ({ ...tab, loading: false, error: message }));
        }
        return;
      }

      openPathsRef.current.add(normalized);
      setTabs((prev) => [
        ...prev,
        { path: normalized, title: basename(normalized), dirty: false, loading: true, error: null },
      ]);
      setActivePath(normalized);

      try {
        const content = await invoke<string>("read_text_file", { root: rootDir, path: normalized });
        ensureModel(normalized, content);
        updateTab(normalized, (tab) => ({ ...tab, loading: false, error: null }));
        setEditorModel(normalized);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        updateTab(normalized, (tab) => ({ ...tab, loading: false, error: message }));
      }
    },
    [ensureModel, rootDir, setEditorModel, updateTab],
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
    if (desiredActive) void openFile(desiredActive);
  }, [ensureModel, openFile, persistedState]);

  React.useEffect(() => {
    if (!openFileRequest) return;
    const key = `${openFileRequest.nonce}:${openFileRequest.path}`;
    if (lastOpenRequestRef.current === key) return;
    lastOpenRequestRef.current = key;
    // Consume immediately to avoid duplicate tabs in React StrictMode double-mount.
    onConsumeOpenFileRequestRef.current?.();
    void openFile(openFileRequest.path);
  }, [openFile, openFileRequest]);

  React.useEffect(() => {
    if (!activePath) {
      setEditorModel(null);
      return;
    }
    const monaco = monacoRef.current;
    const hasModel =
      modelsRef.current.has(activePath) || (monaco ? Boolean(monaco.editor.getModel(monaco.Uri.file(activePath))) : false);
    if (!hasModel) {
      setEditorModel(null);
      return;
    }
    setEditorModel(activePath);
  }, [activePath, setEditorModel]);

  const closeTab = React.useCallback(
    (path: string) => {
      const isDirty = dirtyPathsRef.current.has(path);
      if (isDirty) {
        const ok = window.confirm(`Discard unsaved changes in "${basename(path)}"?`);
        if (!ok) return;
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

      const prevTabs = tabsRef.current;
      const next = prevTabs.filter((t) => t.path !== path);
      setTabs(next);
      if (next.length === 0) {
        setActivePath(null);
        onCloseEditor();
        return;
      }
      if (activePathRef.current === path) {
        const nextActive = next[next.length - 1].path;
        setActivePath(nextActive);
        setEditorModel(nextActive);
      }
    },
    [onCloseEditor, setEditorModel],
  );

  const saveActive = React.useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;
    if (!dirtyPathsRef.current.has(path)) return;

    const monaco = monacoRef.current;
    const model = monaco ? monaco.editor.getModel(monaco.Uri.file(path)) : modelsRef.current.get(path);
    if (!model) return;

    setSaveStatus("saving");
    setSaveError(null);
    try {
      await invoke("write_text_file", { root: rootDir, path, content: model.getValue() });
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
  }, [rootDir, updateTab]);

  const requestCloseEditor = React.useCallback(() => {
    if (dirtyPathsRef.current.size > 0) {
      const ok = window.confirm("Close editor and discard unsaved changes?");
      if (!ok) return;
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
      for (const [path, content] of pendingContentRef.current.entries()) {
        ensureModel(path, content);
      }
      pendingContentRef.current.clear();
      if (activePathRef.current) setEditorModel(activePathRef.current);
    },
    [ensureModel, saveActive, setEditorModel],
  );

  const activeTab = React.useMemo(() => tabs.find((t) => t.path === activePath) ?? null, [activePath, tabs]);

  return (
    <section className="codeEditorPanel" aria-label="Editor">
      <div className="codeEditorHeader">
        <div className="codeEditorTabs" role="tablist" aria-label="Open files">
          {tabs.map((tab) => (
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
                title={tab.path}
              >
                <span className="codeEditorTabTitle">{tab.title}</span>
                {tab.dirty ? <span className="codeEditorTabDirty" aria-label="Unsaved changes" /> : null}
              </button>
              <button
                type="button"
                className="codeEditorTabClose"
                onClick={() => closeTab(tab.path)}
                title="Close"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="codeEditorActions">
          {activeTab ? (
            <div className="codeEditorPath" title={activeTab.path}>
              {shortenPathSmart(activeTab.path, 44)}
            </div>
          ) : null}
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
                Failed to open file.
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
    </section>
  );
}

export default CodeEditorPanel;
