// Unit-test runner (`npm test`). Picks up *.spec.ts under src/ only; the e2e suite
// has its own config (test/jest-e2e.json, *.e2e-spec.ts) so the two never overlap.
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.spec.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testEnvironment: 'node',
};
