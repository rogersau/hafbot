import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type SetupCheckDirtyState = {
  hasUnsavedChanges: boolean;
  setHasUnsavedChanges: (hasUnsavedChanges: boolean) => void;
};

const SetupCheckDirtyStateContext = createContext<SetupCheckDirtyState>({
  hasUnsavedChanges: false,
  setHasUnsavedChanges: () => undefined,
});

export function SetupCheckDirtyStateProvider({ children }: { children: ReactNode }) {
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const value = useMemo(() => ({ hasUnsavedChanges, setHasUnsavedChanges }), [hasUnsavedChanges]);
  return (
    <SetupCheckDirtyStateContext.Provider value={value}>
      {children}
    </SetupCheckDirtyStateContext.Provider>
  );
}

export function useSetupCheckDirtyState() {
  return useContext(SetupCheckDirtyStateContext);
}

export function useRegisterSetupCheckDirtyState(hasUnsavedChanges: boolean) {
  const { setHasUnsavedChanges } = useSetupCheckDirtyState();

  // eslint-disable-next-line custom/no-use-effect -- Registers editor dirty state with the route-level Setup check.
  useEffect(() => {
    setHasUnsavedChanges(hasUnsavedChanges);
    return () => setHasUnsavedChanges(false);
  }, [hasUnsavedChanges, setHasUnsavedChanges]);
}
