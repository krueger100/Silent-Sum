/**
 * One spelling of keyboard avoidance, everywhere.
 *
 * This is a source-level test rather than a rendering one on purpose. `KeyboardAvoidingView`
 * destructures `behavior` and `keyboardVerticalOffset` out of its props before spreading the rest
 * onto the `View` underneath, so neither value ever reaches the host element and no query can read
 * it back; and the React Native Testing Library v14 that this project uses removed the `UNSAFE_*`
 * queries that could once reach the composite. `measureInWindow` is not implemented by the test
 * renderer either, so the measured offset cannot be exercised in JS at all. Simulating a real IME
 * would test React Native, not this app.
 *
 * What is worth defending is narrower. Two bugs have now come out of these wrappers:
 *
 *  1. One wrapper out of four written as `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`
 *     -- the conventional advice, which edge-to-edge quietly invalidated -- while the other three
 *     had been corrected. Nothing failed, because `undefined` is a legal value that does nothing.
 *  2. Every wrapper leaving `keyboardVerticalOffset` at its default of 0. RN's
 *     `_relativeKeyboardHeight` compares a PARENT-relative frame against a SCREEN-absolute keyboard
 *     position, so a wrapper mounted below a status bar and a header under-lifts by exactly their
 *     combined height, and the input it is meant to reveal stays covered.
 *
 * Both are invisible at runtime and invisible to a rendering test. Reading the source is the only
 * place they show up, so the rule enforced here is simply: nothing constructs a raw
 * `KeyboardAvoidingView` except the one component whose job is to get these two props right.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { KEYBOARD_BEHAVIOR } from '@/components/keyboardAvoidance';

const SRC = join(__dirname, '..', '..');
/** The single place a raw `KeyboardAvoidingView` is allowed to be constructed. */
const OWNER = 'components/keyboardAvoidance.tsx';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== '__mocks__') sourceFiles(full, out);
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** The text of a JSX opening tag, brace-aware so a nested `{...}` does not end it early. */
function openingTag(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(from, i + 1);
  }
  return src.slice(from);
}

function tagsNamed(name: string): { file: string; tag: string }[] {
  const found: { file: string; tag: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    const re = new RegExp('<' + name + '(?=[\\s/>])', 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
      found.push({
        file: file.slice(SRC.length + 1).replace(/\\/g, '/'),
        tag: openingTag(src, match.index),
      });
    }
  }
  return found;
}

describe('keyboard avoidance', () => {
  it('is padding, on both platforms', () => {
    // Not a tautology in the way it looks: this is the line to change if the policy ever changes,
    // and the comment in keyboardAvoidance.tsx is the argument for why it is this and not the
    // usual iOS-only advice.
    expect(KEYBOARD_BEHAVIOR).toBe('padding');
  });

  it('is applied by at least the screens known to need it', () => {
    // Guards the scan itself. A regex that silently matched nothing would make the tests below
    // pass for the wrong reason.
    const files = tagsNamed('KeyboardAvoider').map((w) => w.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'components/Dialog.tsx',
        'components/Screen.tsx',
        'messaging/screens/ConversationScreen.tsx',
        'messaging/screens/ConversationsScreen.tsx',
      ]),
    );
  });

  it('constructs a raw KeyboardAvoidingView in exactly one place', () => {
    // The whole point. A screen that reaches for the React Native component directly gets
    // `keyboardVerticalOffset = 0` by default, which is the bug that left the message composer
    // under the keyboard on a screen that has a header above it.
    const offenders = tagsNamed('KeyboardAvoidingView')
      .filter((w) => w.file !== OWNER)
      .map((w) => w.file);
    expect(offenders).toEqual([]);
  });

  it('gives that wrapper both a shared behaviour and a measured offset', () => {
    const [owner, ...rest] = tagsNamed('KeyboardAvoidingView');
    expect(rest).toEqual([]);
    expect(owner).toBeDefined();
    const tag = (owner?.tag ?? '').replace(/\s+/g, ' ');
    // A literal "padding" is as much a failure as `undefined`: both are a wrapper deciding for
    // itself, which is the shape of the first bug even when the answer happens to agree.
    expect(tag).toMatch(/behavior=\{KEYBOARD_BEHAVIOR\}/);
    // And a hardcoded number is as much a failure as leaving it out: the offset depends on the
    // status bar and header of whatever screen the wrapper lands in, so it has to be measured.
    expect(tag).toMatch(/keyboardVerticalOffset=\{[A-Za-z_$][\w$]*\}/);
  });
});
