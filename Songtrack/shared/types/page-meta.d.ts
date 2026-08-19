declare module '#app' {
  interface PageMeta {
    /** Hides the global footer PlayerBar on this route — set by pages with their own transport UI. */
    hidePlayerBar?: boolean
  }
}

export {}
