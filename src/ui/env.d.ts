declare module '*.css'
// Vite ?worker&url query — resolves to a public URL string at build time.
declare module '*?worker&url' {
  const src: string
  export default src
}
