const expoPreset = require('jest-expo/jest-preset');

/**
 * The Expo preset already whitelists every `expo*`, `react-native*` and `@react-native*` package
 * for transformation (prefix match, no trailing slash), which covers expo-modules-core,
 * react-native-libsodium and @react-native-firebase. Replacing that list outright breaks Expo's
 * own modules, so extras are appended to it instead.
 */
const transformIgnorePatterns = [
  expoPreset.transformIgnorePatterns[0].replace(
    '|standard-navigation',
    '|standard-navigation|zustand',
  ),
  ...expoPreset.transformIgnorePatterns.slice(1),
];

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)', '**/?(*.)+(test).[jt]s?(x)'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // The native libsodium binding is replaced by the pure-JS sumo build in tests.
    '^react-native-libsodium$': '<rootDir>/test/shims/react-native-libsodium.ts',
    // expo-video touches its native view at import time, so importing it at all fails under Jest.
    '^expo-video$': '<rootDir>/test/shims/expo-video.tsx',
    // Same story: expo-media-library subclasses native classes at import time.
    '^expo-media-library$': '<rootDir>/test/shims/expo-media-library.ts',
    // The local native module cannot load under Jest; specs inject their own picker.
    '(\.\./)+modules/vault-media$': '<rootDir>/test/shims/vault-media.ts',
  },
  transformIgnorePatterns,
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts', '!src/**/index.ts'],
  testTimeout: 30000,
};
