/**
 * One spelling of the keyboard behaviour, everywhere.
 *
 * This is a source-level test rather than a rendering one on purpose. `KeyboardAvoidingView`
 * destructures `behavior` out of its props before spreading the rest onto the `View` underneath,
 * so the value never reaches the host element and no query can read it back; and the React Native
 * Testing Library v14 that this project uses removed the `UNSAFE_*` queries that could once reach
 * the composite. Simulating a real IME would test React Native, not this app.
 *
 * What is actually worth defending is narrower than any of that. The bug this replaces was one
 * wrapper out of four written as `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` -- the
 * conventional advice, which edge-to-edge quietly invalidated -- while the other three had already
 * been corrected. Nothing failed, because `undefined` is a legal value that simply does nothing.
 * Reading the source is the only place that disagreement is visible.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { KEYBOARD_BEHAVIOR } from '@/components/keyboardAvoidance';

const SRC = join(__dirname, '..', '..');

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

function wrappers(): { file: string; tag: string }[] {
  const found: { file: string; tag: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    const re = /<KeyboardAvoidingView(?=[\s/>])/g;
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
    // and the comment in keyboardAvoidance.ts is the argument for why it is this and not the
    // usual iOS-only advice.
    expect(KEYBOARD_BEHAVIOR).toBe('padding');
  });

  it('is applied by at least the wrappers known to need it', () => {
    // Guards the scan itself. A regex that silently matched nothing would make the test below
    // pass for the wrong reason.
    const files = wrappers().map((w) => w.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'components/Dialog.tsx',
        'components/Screen.tsx',
        'messaging/screens/ConversationScreen.tsx',
        'messaging/screens/ConversationsScreen.tsx',
      ]),
    );
  });

  it('takes its behaviour from the shared constant at every wrapper', () => {
    const offenders = wrappers()
      .filter((w) => !/behavior=\{KEYBOARD_BEHAVIOR\}/.test(w.tag))
      .map((w) => w.file + ': ' + w.tag.replace(/\s+/g, ' ').slice(0, 120));

    // A literal "padding" is as much a failure as `undefined` here. Both are a wrapper deciding
    // for itself, which is the shape of the original bug even when the answer happens to agree.
    expect(offenders).toEqual([]);
  });
});
