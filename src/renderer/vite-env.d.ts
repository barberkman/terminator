// Vite's `?url` imports: the asset's URL as a string. Declared here rather than
// through `vite/client`, which tsconfig.web.json's `"types": ["node"]` keeps out —
// and in a file of its own because a wildcard module declaration only works in a
// script, and global.d.ts is a module (it imports).
declare module '*?url' {
  const url: string
  export default url
}

// Stylesheets imported for their side effect, the way pdf.js's viewer CSS is pulled
// in only when a PDF pane first needs it (pdf/load.ts).
declare module '*.css' {}
