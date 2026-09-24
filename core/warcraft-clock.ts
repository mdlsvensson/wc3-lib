import { Scheduler } from "./scheduler.ts";

/** Explicitly owns one Warcraft timer; importing this module allocates nothing. */
export function startWarcraftClock(clock: Scheduler): () => void {
  let handle: timer | undefined = CreateTimer();
  TimerStart(handle, clock.stepSeconds, true, () => clock.advance());
  return () => {
    if (!handle) return;
    PauseTimer(handle);
    DestroyTimer(handle);
    handle = undefined;
  };
}
