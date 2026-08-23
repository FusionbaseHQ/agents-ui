import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import cssWorker from "monaco-editor/languages/features/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/languages/features/html/html.worker.js?worker";
import tsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";

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
