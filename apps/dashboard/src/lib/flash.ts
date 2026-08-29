import { useEffect, useState } from "react";

/**
 * Reports work only once it has lasted long enough to be worth reporting.
 *
 * A request that resolves in 40ms and a spinner that appears for those 40ms are
 * not the same event: the second one is a flicker the reader has to interpret.
 * Healthy steady state is silent (DESIGN.md § Interaction Architecture), so
 * pending work announces itself only past the flash threshold.
 */
export function usePastFlashThreshold(active: boolean, delayMs = 220): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && elapsed;
}
