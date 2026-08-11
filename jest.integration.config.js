module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup.ts'],
  // Money paths share rows; parallel workers would make results depend on
  // interleaving rather than on the code under test.
  maxWorkers: 1,
  testTimeout: 60000,
};
