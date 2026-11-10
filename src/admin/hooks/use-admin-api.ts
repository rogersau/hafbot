import { useCallback, useReducer, useRef } from "react";
import { initialAdminRequest, transitionAdminRequest } from "../lib/request-workflow";

export function useAdminApi() {
  const requestRef = useRef(0);
  const [state, dispatch] = useReducer(transitionAdminRequest, initialAdminRequest);
  const setError = useCallback(
    (error: string | null) => dispatch({ type: "error-set", error }),
    [],
  );

  const run = useCallback(
    async <T>(
      action: () => Promise<T>,
      onSuccess?: (data: T) => void,
      onError?: (message: string) => void,
    ) => {
      const id = ++requestRef.current;
      dispatch({ type: "started", requestId: id });
      try {
        const data = await action();
        if (requestRef.current === id) {
          onSuccess?.(data);
          dispatch({ type: "succeeded", requestId: id });
        }
      } catch (err) {
        if (requestRef.current === id) {
          const message = err instanceof Error ? err.message : String(err);
          dispatch({ type: "failed", requestId: id, error: onError ? null : message });
          onError?.(message);
        }
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    dispatch({ type: "cancelled", requestId: ++requestRef.current });
  }, []);

  return { run, cancel, state, loading: state.kind === "running", error: state.error, setError };
}
