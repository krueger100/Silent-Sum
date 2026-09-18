import { writeFileAtomically, isTemporaryArtifact, temporaryNameFor } from '@/storage/atomicWrite';
import { FileNotFoundError, joinUri, uriBasename, uriDirname } from '@/storage/fileSystem';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import { bytesEqual, containsSequence, utf8Encode } from '@/utils/bytes';

describe('URI helpers', () => {
  it('joins, and reads basenames and directories', () => {
    expect(joinUri('file:///a', 'b', 'c.enc')).toBe('file:///a/b/c.enc');
    expect(joinUri('file:///a/', '/b/', 'c')).toBe('file:///a/b/c');
    expect(uriBasename('file:///a/b/c.enc')).toBe('c.enc');
    expect(uriBasename('file:///a/b/')).toBe('b');
    expect(uriDirname('file:///a/b/c.enc')).toBe('file:///a/b');
  });
});

describe('InMemoryFileSystem', () => {
  it('writes, reads, lists and deletes', async () => {
    const fs = new InMemoryFileSystem();
    const uri = joinUri(fs.documentDirectory, 'vault', 'a.enc');
    const bytes = utf8Encode('hello');

    await fs.writeBytes(uri, bytes);

    expect(await fs.exists(uri)).toBe(true);
    expect(await fs.size(uri)).toBe(5);
    expect(bytesEqual(await fs.readBytes(uri), bytes)).toBe(true);
    expect((await fs.list(joinUri(fs.documentDirectory, 'vault'))).map((e) => e.name)).toEqual([
      'a.enc',
    ]);

    await fs.deleteFile(uri);
    expect(await fs.exists(uri)).toBe(false);
    await expect(fs.readBytes(uri)).rejects.toThrow(FileNotFoundError);
  });

  it('stores copies, so a caller cannot mutate the contents afterwards', async () => {
    const fs = new InMemoryFileSystem();
    const uri = joinUri(fs.documentDirectory, 'x.enc');
    const bytes = utf8Encode('original');

    await fs.writeBytes(uri, bytes);
    bytes.fill(0);

    expect(Buffer.from(await fs.readBytes(uri)).toString()).toBe('original');
  });

  it('overwrites in place without changing the length', async () => {
    const fs = new InMemoryFileSystem();
    const uri = joinUri(fs.documentDirectory, 'x.enc');
    await fs.writeBytes(uri, utf8Encode('abcdefgh'));

    await fs.overwriteInPlace(uri, utf8Encode('ZZZZ'));

    expect(await fs.size(uri)).toBe(8);
    expect(Buffer.from(await fs.readBytes(uri)).toString()).toBe('ZZZZefgh');
  });

  it('moves files and reports missing sources', async () => {
    const fs = new InMemoryFileSystem();
    const from = joinUri(fs.documentDirectory, 'from.enc');
    const to = joinUri(fs.documentDirectory, 'nested', 'to.enc');
    await fs.writeBytes(from, utf8Encode('payload'));

    await fs.move(from, to);

    expect(await fs.exists(from)).toBe(false);
    expect(Buffer.from(await fs.readBytes(to)).toString()).toBe('payload');
    await expect(fs.move(from, to)).rejects.toThrow(FileNotFoundError);
  });

  it('deletes directory trees', async () => {
    const fs = new InMemoryFileSystem();
    const root = joinUri(fs.documentDirectory, 'vault');
    await fs.writeBytes(joinUri(root, 'photos', 'a.enc'), utf8Encode('a'));
    await fs.writeBytes(joinUri(root, 'index.enc'), utf8Encode('i'));

    await fs.deleteDirectory(root);

    expect(await fs.exists(joinUri(root, 'index.enc'))).toBe(false);
    expect(await fs.list(root)).toEqual([]);
  });
});

describe('atomic write', () => {
  it('replaces the target and leaves no temporary file behind', async () => {
    const fs = new InMemoryFileSystem();
    const target = joinUri(fs.documentDirectory, 'vault', 'index.enc');

    await writeFileAtomically(fs, target, utf8Encode('first'));
    await writeFileAtomically(fs, target, utf8Encode('second'));

    expect(Buffer.from(await fs.readBytes(target)).toString()).toBe('second');
    const leftovers = [...fs.allFiles.keys()].filter(isTemporaryArtifact);
    expect(leftovers).toEqual([]);
  });

  it('cleans up the temporary file when the rename fails', async () => {
    const fs = new InMemoryFileSystem();
    const target = joinUri(fs.documentDirectory, 'index.enc');
    jest.spyOn(fs, 'move').mockRejectedValueOnce(new Error('rename failed'));

    await expect(writeFileAtomically(fs, target, utf8Encode('data'))).rejects.toThrow(
      'rename failed',
    );

    expect([...fs.allFiles.keys()].filter(isTemporaryArtifact)).toEqual([]);
    expect(await fs.exists(target)).toBe(false);
  });

  it('does not damage an existing target when the write fails', async () => {
    const fs = new InMemoryFileSystem();
    const target = joinUri(fs.documentDirectory, 'index.enc');
    await writeFileAtomically(fs, target, utf8Encode('good'));
    jest.spyOn(fs, 'move').mockRejectedValueOnce(new Error('rename failed'));

    await expect(writeFileAtomically(fs, target, utf8Encode('bad'))).rejects.toThrow();

    expect(Buffer.from(await fs.readBytes(target)).toString()).toBe('good');
  });

  it('generates unique temporary names', () => {
    const target = 'file:///a/index.enc';
    const names = new Set(Array.from({ length: 200 }, () => temporaryNameFor(target)));
    expect(names.size).toBe(200);
    for (const name of names) expect(isTemporaryArtifact(name)).toBe(true);
  });
});

describe('SecureDelete', () => {
  it('overwrites the contents before unlinking', async () => {
    const fs = new InMemoryFileSystem();
    const uri = joinUri(fs.documentDirectory, 'secret.bin');
    const secret = utf8Encode('the quick brown fox jumps over the lazy dog');
    await fs.writeBytes(uri, secret);
    const raw = fs.peek(uri);
    expect(raw).toBeDefined();

    await new SecureDelete(fs).file(uri);

    expect(await fs.exists(uri)).toBe(false);
    // `raw` is the exact buffer the fake disk held; it must no longer contain the plaintext.
    expect(raw === undefined || !containsSequence(raw, secret)).toBe(true);
  });

  it('overwrites files larger than one chunk', async () => {
    const fs = new InMemoryFileSystem();
    const uri = joinUri(fs.documentDirectory, 'big.bin');
    const marker = utf8Encode('NEEDLE');
    const payload = new Uint8Array(200 * 1024);
    payload.set(marker, 150 * 1024);
    await fs.writeBytes(uri, payload);
    const raw = fs.peek(uri);

    await new SecureDelete(fs, 64 * 1024).file(uri);

    expect(raw === undefined || !containsSequence(raw, marker)).toBe(true);
    expect(await fs.exists(uri)).toBe(false);
  });

  it('is a no-op for a missing file and never throws', async () => {
    const fs = new InMemoryFileSystem();
    await expect(
      new SecureDelete(fs).file(joinUri(fs.documentDirectory, 'ghost.bin')),
    ).resolves.toBeUndefined();
  });

  it('still unlinks when the overwrite fails', async () => {
    const fs = new InMemoryFileSystem();
    const uri = joinUri(fs.documentDirectory, 'readonly.bin');
    await fs.writeBytes(uri, utf8Encode('data'));
    jest.spyOn(fs, 'overwriteInPlace').mockRejectedValueOnce(new Error('read-only volume'));

    await new SecureDelete(fs).file(uri);

    expect(await fs.exists(uri)).toBe(false);
  });

  it('wipes a directory tree depth first', async () => {
    const fs = new InMemoryFileSystem();
    const root = joinUri(fs.documentDirectory, 'vault');
    await fs.writeBytes(joinUri(root, 'photos', 'a.enc'), utf8Encode('aaaa'));
    await fs.writeBytes(joinUri(root, 'photos', 'b.enc'), utf8Encode('bbbb'));
    await fs.writeBytes(joinUri(root, 'index.enc'), utf8Encode('iiii'));

    await new SecureDelete(fs).directoryContents(root);

    expect(await fs.list(root)).toEqual([]);
    expect(fs.allFiles.size).toBe(0);
  });

  it('produces a different overwrite pattern than the original data', async () => {
    const fs = new InMemoryFileSystem();
    const uri = joinUri(fs.documentDirectory, 'zeros.bin');
    const zeros = new Uint8Array(4096);
    await fs.writeBytes(uri, zeros);
    const raw = fs.peek(uri);
    jest.spyOn(fs, 'deleteFile').mockResolvedValueOnce(undefined);

    await new SecureDelete(fs).file(uri);

    const nonZero = raw === undefined ? 0 : raw.reduce((n, b) => n + (b === 0 ? 0 : 1), 0);
    expect(nonZero).toBeGreaterThan(3000);
  });
});
