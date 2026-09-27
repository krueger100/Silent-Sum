/**
 * Every libsodium function the app imports must exist in the NATIVE binding.
 *
 * `react-native-libsodium` ships two different builds. `lib.ts` (web, and the shape
 * `libsodium-wrappers-sumo` has) exposes most of libsodium; `lib.native.ts`, the one that runs on
 * a phone, bridges a hand-written list of functions through JSI and is much smaller. Importing
 * something only the first one has compiles, type checks, and passes every other test in this
 * repo -- because the Jest shim delegates to the sumo build -- and then throws `undefined is not
 * a function` on a real device.
 *
 * That has now happened twice: once on the AAD-type difference that broke vault creation, and
 * once on `crypto_box_beforenm`, which left every conversation reporting "messaging is not
 * available in this build". This test reads both files and compares them, so the third time is
 * caught here instead of on a phone.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const NATIVE_BINDING = 'node_modules/react-native-libsodium/src/lib.native.ts';
const SODIUM_MODULE = 'src/crypto/sodium.ts';
const SHIM = 'test/shims/react-native-libsodium.ts';

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

/** The names `@/crypto/sodium` pulls out of the binding -- the only file allowed to. */
function importedNames(source: string): string[] {
  const block = /import\s*\{([^}]*)\}\s*from\s*'react-native-libsodium'/.exec(source);
  if (block === null) throw new Error('no react-native-libsodium import found');
  return (block[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/** `export function x`, `export const x`, and the re-exported `export { x, y } from '...'`. */
function exportsName(source: string, name: string): boolean {
  const declared = new RegExp(String.raw`export\s+(?:const|function)\s+${name}\b`);
  if (declared.test(source)) return true;
  return source
    .split('\n')
    .filter((line) => line.startsWith('export {'))
    .some((line) => line.includes(name));
}

describe('the native libsodium surface', () => {
  const native = read(NATIVE_BINDING);
  const imported = importedNames(read(SODIUM_MODULE));

  it('has something to check', () => {
    expect(imported.length).toBeGreaterThan(5);
  });

  it.each(imported)('bridges %s to the device', (name) => {
    expect(exportsName(native, name)).toBe(true);
  });

  /**
   * The shim may be smaller than the native binding -- it implements what the tests need and no
   * more -- but it must never offer a FUNCTION the phone does not have, which is the whole
   * failure mode above: a primitive that exists only in the double.
   *
   * Constants are left out on purpose. The shim hardcodes byte lengths rather than reading them
   * off a JSI global, and one that drifted would fail the round-trip tests immediately.
   */
  it('offers the tests no function the phone lacks', () => {
    const shimFunctions = [...read(SHIM).matchAll(/export\s+function\s+([A-Za-z0-9_]+)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(shimFunctions.length).toBeGreaterThan(5);
    expect(shimFunctions.filter((name) => !exportsName(native, name))).toEqual([]);
  });
});
