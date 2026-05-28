// Vercel serverless entry point.
//
// Vercel invokes the default export as the request handler. An Express app is
// itself a (req, res) function, so it plugs straight in — every route defined
// in src/app.ts is served. The vercel.json rewrite sends all paths here.
//
// Note: src/server.ts (app.listen + graceful shutdown) is NOT used on Vercel;
// it remains the entry point for local `npm run dev` and the Docker/VM deploy.
import app from '../src/app';

export default app;
