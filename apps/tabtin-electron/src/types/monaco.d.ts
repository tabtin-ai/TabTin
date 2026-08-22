declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor'
}

declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
  const MonacoEditorWorker: { new (): Worker }
  export default MonacoEditorWorker
}

declare module 'monaco-editor/esm/vs/language/json/json.worker?worker' {
  const MonacoJsonWorker: { new (): Worker }
  export default MonacoJsonWorker
}

declare module 'monaco-editor/esm/vs/language/css/css.worker?worker' {
  const MonacoCssWorker: { new (): Worker }
  export default MonacoCssWorker
}

declare module 'monaco-editor/esm/vs/language/html/html.worker?worker' {
  const MonacoHtmlWorker: { new (): Worker }
  export default MonacoHtmlWorker
}

declare module 'monaco-editor/esm/vs/language/typescript/ts.worker?worker' {
  const MonacoTsWorker: { new (): Worker }
  export default MonacoTsWorker
}
