import { createContext, useContext } from 'react'

// openHelp(sectionId?) — opens the Help panel, optionally at a section from
// help/helpContent.js. Provided by App; a no-op outside it.
export const HelpContext = createContext(() => {})

export function useHelp() {
  return useContext(HelpContext)
}
