import 'http';

declare module 'http' {
  interface IncomingMessage {
    // Raw request body buffer, captured by express.json's verify callback.
    // Used to verify webhook HMAC signatures against the exact bytes sent.
    rawBody?: Buffer;
  }
}
