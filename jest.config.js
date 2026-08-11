// Default run: unit tests only — fully mocked, no database, safe in CI.
// Integration tests exercise real Postgres semantics (row locks, conditional
// updates, unique constraints) that a mock cannot reproduce, so they are opt-in
// and require TEST_DATABASE_URL pointing at a throwaway database.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup.ts'],
  testTimeout: 10000,
};
