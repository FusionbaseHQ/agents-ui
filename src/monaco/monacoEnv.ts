import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type WorkerConstructor = new () => Worker;

(globalThis as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new (jsonWorker as WorkerConstructor)();
    if (label === "css" || label === "scss" || label === "less") return new (cssWorker as WorkerConstructor)();
    if (label === "html" || label === "handlebars" || label === "razor") return new (htmlWorker as WorkerConstructor)();
    if (label === "typescript" || label === "javascript") return new (tsWorker as WorkerConstructor)();
    return new (editorWorker as WorkerConstructor)();
  },
};

