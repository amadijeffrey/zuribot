import 'http';
import 'express';

declare module 'http' {
  interface IncomingMessage {
    // Raw request body buffer, captured by express.json's verify callback.
    // Used to verify webhook HMAC signatures against the exact bytes sent.
    rawBody?: Buffer;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    // Correlation id for this request, set by requestLogger and echoed to the
    // caller as the X-Request-Id response header.
    id?: string;
    // Set by authMiddleware when the request carries a valid admin session.
    // Absent on legacy shared-key requests, which have no identity.
    admin?: { id: string; email: string; name: string | null };
    // Set by userAuthMiddleware on member-authenticated routes.
    member?: { id: string; email: string | null; name: string | null };
  }
}
