// Vercel serverless entry point.
//
// Vercel invokes the default export as the request handler. An Express app is
// itself a (req, res) function, so it plugs straight in — every route defined
// in src/app.ts is served. The vercel.json rewrite sends all paths here.
//
// Note: src/server.ts (app.listen + graceful shutdown) is NOT used on Vercel;
// it remains the entry point for local `npm run dev` and the Docker/VM deploy.
import app from '../src/app';
import { installProcessGuards } from '../src/utils/process-guards';

// Because server.ts is skipped here, its process-level handlers were skipped
// too: an unhandled rejection would terminate the instance with nothing logged,
// killing every in-flight request on it without a response. No onFatal hook —
// there is no listener of our own to close, so an uncaught exception should end
// the instance immediately and let the platform serve the next request on a
// fresh one.
installProcessGuards();

export default app;
