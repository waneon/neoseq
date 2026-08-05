import {
  createContext,
  Profiler,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  diagnostics,
  DiagnosticsCoordinator,
} from "../../diagnostics/coordinator";
import type { DiagnosticsViewState } from "../../diagnostics/types";
import { DiagnosticsDialog } from "./DiagnosticsDialog";

const DiagnosticsContext = createContext<DiagnosticsCoordinator>(diagnostics);

export function DiagnosticsProvider({
  children,
  coordinator = diagnostics,
}: {
  children: ReactNode;
  coordinator?: DiagnosticsCoordinator;
}) {
  useEffect(() => {
    void coordinator.recover();
  }, [coordinator]);

  return (
    <DiagnosticsContext.Provider value={coordinator}>
      <Profiler
        id="application"
        onRender={(_id, phase, actualDuration) => {
          coordinator.recordRender(actualDuration, phase);
        }}
      >
        {children}
      </Profiler>
      <DiagnosticsDialog />
    </DiagnosticsContext.Provider>
  );
}

export function useDiagnostics(): DiagnosticsCoordinator {
  return useContext(DiagnosticsContext);
}

export function useDiagnosticsState(): DiagnosticsViewState {
  const coordinator = useDiagnostics();
  return useSyncExternalStore(coordinator.subscribe, coordinator.getState, coordinator.getState);
}
