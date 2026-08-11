process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-characters!!';
process.env.NODE_ENV = 'test';

// Integration tests must never run against the live database. Point
// TEST_DATABASE_URL at a throwaway one; without it they refuse to start.
if (process.env.INTEGRATION === '1') {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is required for integration tests — refusing to use DATABASE_URL');
  }
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.TEST_DATABASE_URL;
}
