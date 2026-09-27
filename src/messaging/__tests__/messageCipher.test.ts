import { SequentialRandom } from '@/crypto/random';
import { openMessage, sealMessage, type MessageBinding } from '@/messaging/messageCipher';

const KEY = new Uint8Array(32).fill(7);
const BINDING: MessageBinding = { conversationId: 'a__b', from: 'a', createdAt: 1_700_000_000_000 };

function random() {
  return new SequentialRandom();
}

describe('sealMessage / openMessage', () => {
  it('round-trips, and stores nothing readable', () => {
    const sealed = sealMessage('are you available?', KEY, BINDING, random());
    expect(sealed.box).not.toContain('available');
    expect(openMessage(sealed, KEY, BINDING)).toBe('are you available?');
  });

  it('survives a message that is all unicode', () => {
    const sealed = sealMessage('ñ 東京 🙂', KEY, BINDING, random());
    expect(openMessage(sealed, KEY, BINDING)).toBe('ñ 東京 🙂');
  });

  it('refuses a different key', () => {
    const sealed = sealMessage('hello', KEY, BINDING, random());
    expect(openMessage(sealed, new Uint8Array(32).fill(8), BINDING)).toBeNull();
  });

  it('refuses a message moved to another conversation', () => {
    const sealed = sealMessage('hello', KEY, BINDING, random());
    expect(openMessage(sealed, KEY, { ...BINDING, conversationId: 'a__c' })).toBeNull();
  });

  it('refuses a re-attributed sender or an edited timestamp', () => {
    const sealed = sealMessage('hello', KEY, BINDING, random());
    expect(openMessage(sealed, KEY, { ...BINDING, from: 'b' })).toBeNull();
    expect(openMessage(sealed, KEY, { ...BINDING, createdAt: BINDING.createdAt + 1 })).toBeNull();
  });

  it('refuses tampered ciphertext, a bad nonce and garbage, without throwing', () => {
    const sealed = sealMessage('hello', KEY, BINDING, random());
    const flipped = 'A' + sealed.box.slice(1);
    expect(openMessage({ ...sealed, box: flipped }, KEY, BINDING)).toBeNull();
    expect(openMessage({ ...sealed, nonce: 'AAAA' }, KEY, BINDING)).toBeNull();
    expect(openMessage({ box: 'not base64 !!', nonce: '!!' }, KEY, BINDING)).toBeNull();
  });
});
