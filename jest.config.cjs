module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.(test|spec).ts'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  extensionsToTreatAsEsm: ['.ts'],
  globals: { 'ts-jest': { useESM: true } },
  watchman: false,
};
