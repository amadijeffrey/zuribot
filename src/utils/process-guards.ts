import { logger } from './logger';

// Process-level safety net, shared by both entry points.
//
// This app is started two different ways: src/server.ts (app.listen, used by the
// Docker/VM deploy and `npm run dev`) and api/index.ts (Vercel, which imports
// src/app directly and never touches server.ts). Handlers registered inside
// server.ts therefore did not exist on Vercel at all — the platform where an
// unlogged crash is hardest to investigate. Keeping them here lets each entry
// point install the same guards while supplying its own shutdown behaviour.
let installed = false;

interface Options {
  /**
   * Called on an uncaught exception instead of exiting immediately — used by the
   * long-lived server to close its listener first. Must terminate the process
   * itself; a watchdog exit fires ten seconds later regardless.
   */
  onFatal?: () => void;
}

export const installProcessGuards = ({ onFatal }: Options = {}): void => {
  // Both entry points may reach this in the same process (server.ts imports
  // app.ts). Registering twice would double every log line.
  if (installed) return;
  installed = true;

  // Route handlers are wrapped in asyncHandler, so a rejection reaching here
  // comes from work started outside the request lifecycle — a fire-and-forget
  // email, a timer, a stray .then().
  //
  // We log and keep serving rather than exiting: Node's default for an unhandled
  // rejection is to terminate, which would drop every in-flight request
  // (including a Paystack webhook mid-activation) over an error that may have
  // nothing to do with them. The log line is what makes the leak findable
  // instead of the process silently restarting.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection — investigate, this is a bug', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  // An uncaught exception leaves the process in an undefined state, so unlike a
  // rejection this one does exit — but only after the reason is logged, so the
  // restart brings back a clean process rather than one with corrupt state.
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception — shutting down', {
      error: error.message,
      stack: error.stack,
    });

    if (!onFatal) {
      process.exit(1);
      return;
    }

    onFatal();
    // Watchdog: if the graceful path stalls (a socket that never closes), exit
    // anyway. unref'd so it cannot by itself hold the process open.
    setTimeout(() => process.exit(1), 10000).unref();
  });
};
