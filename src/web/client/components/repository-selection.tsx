import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export interface RepositorySelectionState {
  readonly recordId: string | null;
  readonly nodeId: string | null;
  selectRecord(recordId: string): void;
  selectRepositoryNode(nodeId: string): void;
  clearSelection(): void;
}

const RepositorySelectionContext = createContext<RepositorySelectionState | null>(null);

export function RepositorySelectionProvider({ children }: { readonly children: ReactNode }) {
  const [selection, setSelection] = useState<{
    readonly recordId: string | null;
    readonly nodeId: string | null;
  }>({ recordId: null, nodeId: null });
  const selectRecord = useCallback((recordId: string) => {
    setSelection({ recordId, nodeId: null });
  }, []);
  const selectRepositoryNode = useCallback((nodeId: string) => {
    setSelection({ recordId: null, nodeId });
  }, []);
  const clearSelection = useCallback(() => {
    setSelection({ recordId: null, nodeId: null });
  }, []);
  const value = useMemo(() => ({
    ...selection,
    selectRecord,
    selectRepositoryNode,
    clearSelection,
  }), [clearSelection, selectRecord, selectRepositoryNode, selection]);
  return (
    <RepositorySelectionContext.Provider value={value}>
      {children}
    </RepositorySelectionContext.Provider>
  );
}

export function useRepositorySelection(): RepositorySelectionState {
  const selection = useContext(RepositorySelectionContext);
  if (selection === null) {
    throw new Error("Repository selection requires RepositorySelectionProvider");
  }
  return selection;
}
