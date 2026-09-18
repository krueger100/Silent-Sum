import sodium from 'libsodium-wrappers-sumo';

// react-native-gesture-handler installs a JSI binding at import time, which does not exist under
// Jest. Its own setup file replaces the native module with a working mock; without it, rendering
// GestureHandlerRootView throws "install is not a function".
require('react-native-gesture-handler/jestSetup');

// SafeAreaProvider measures itself with a native onLayout and renders nothing until it has
// metrics, so under Jest the whole tree would be empty. The library ships a mock with fixed
// metrics for exactly this.
jest.mock('react-native-safe-area-context', () =>
   
  require('react-native-safe-area-context/jest/mock').default,
);

// The libsodium WASM/asm.js build initialises asynchronously; the native binding is synchronous.
// Wait once per test file so the shim in test/shims/react-native-libsodium.ts can be called synchronously.
beforeAll(async () => {
  await sodium.ready;
});
