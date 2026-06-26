import type { TerminatorApi } from '../shared/types'

declare global {
  interface Window {
    terminator: TerminatorApi
  }
}

export {}
