/**
 * Web unit-test runner (issue #34). jest-preset-angular transforms the Angular
 * standalone components/services via ts-jest using tsconfig.spec.json; the headless
 * application-layer logic (signal stores, the questionnaire FormGroup mapping) is the
 * primary target, per the slice's "testable without mounting a component" stance.
 */
module.exports = {
  preset: 'jest-preset-angular',
  setupFilesAfterEnv: ['<rootDir>/setup-jest.ts'],
  testEnvironment: 'jsdom',
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/dist/'],
  moduleFileExtensions: ['ts', 'html', 'js', 'json', 'mjs'],
  transform: {
    '^.+\\.(ts|mjs|js|html)$': [
      'jest-preset-angular',
      { tsconfig: '<rootDir>/tsconfig.spec.json', stringifyContentPathRegex: '\\.(html|svg)$' },
    ],
  },
};
