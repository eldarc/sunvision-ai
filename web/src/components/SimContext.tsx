import { createContext, useContext, type ReactNode } from 'react';
import { usePendingSelection, useReconstruction } from '../lib/useSim';

type Sim = ReturnType<typeof useReconstruction>;
const Ctx = createContext<Sim>(null);

/**
 * Runs the (multi-view) reconstruction once for the whole workspace and resolves
 * store.pendingSelection (landing → sample apartment) as soon as it exists.
 */
export function SimProvider({ children }: { children: ReactNode }) {
  const sim = useReconstruction();
  usePendingSelection(sim);
  return <Ctx.Provider value={sim}>{children}</Ctx.Provider>;
}

export const useSimContext = () => useContext(Ctx);
