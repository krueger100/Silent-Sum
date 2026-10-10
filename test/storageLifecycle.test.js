/**
 * The bucket lifecycle rules, guarded as configuration, because that is where they can be lost.
 *
 * Two invariants live in this one small file and neither is visible from the app. A build with
 * both broken looks and behaves exactly like a build with both intact, right up until somebody
 * either loses their photos or reads a bill.
 *
 * ONE: no `SetStorageClass`, ever. Lapsed Cloud backups are reclaimed by Autoclass -- objects
 * descend to Archive as they go unread and come back free when read, so a lapsed account's data
 * costs about a twentieth of Standard and nothing is destroyed. Autoclass and `SetStorageClass`
 * lifecycle rules are MUTUALLY EXCLUSIVE: adding one silently disables the other. Age-based
 * tiering looks like a harmless optimisation and is the single edit that would undo the fix, so
 * it fails here rather than in a bill three months later. (See `firebase/README.md`.)
 *
 * TWO: nothing under `users/` may acquire an expiry. Those are the encrypted vault backups, and
 * for some accounts the cloud copy is the only copy -- a `Delete` rule reaching them would be
 * irreversible and silent. The 30-day rule is aimed at `messages/` alone, and `matchesPrefix` is
 * the only thing aiming it; drop it and the same rule deletes every backup in the project.
 *
 * Deletion was considered for lapsed accounts and rejected: `SILENTSUM_SUPPORT_FROM` is Resend's
 * shared test sender, which delivers only to the Resend account's own address, so there is no way
 * to warn a user who has stopped opening the app. Destroying data you cannot give notice about is
 * not a cost measure.
 */
const fs = require('fs');
const path = require('path');

const LIFECYCLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'firebase', 'storage-lifecycle.json'), 'utf8'),
);

const rules = () => LIFECYCLE.rule ?? [];

/**
 * The checks as predicates, so they can be run against the real file AND against deliberately
 * bad configurations further down.
 *
 * Proving a guard by editing the file it guards would mean writing `Delete` over `users/` to
 * disk, even for one test run -- the exact rule that would destroy every backup in the project
 * if it were ever applied. A guard that has to become the hazard in order to demonstrate itself
 * is the wrong shape. These run on values instead, and nothing dangerous is ever written.
 */
const faults = {
  tiering: (config) =>
    (config.rule ?? []).some((r) => r.action?.type === 'SetStorageClass'),
  reachesBackups: (config) =>
    (config.rule ?? []).some((r) =>
      (r.condition?.matchesPrefix ?? []).some((p) => p.startsWith('users/')),
    ),
  unaimed: (config) =>
    (config.rule ?? []).some((r) => (r.condition?.matchesPrefix ?? []).length === 0),
  ageless: (config) =>
    (config.rule ?? []).some((r) => typeof r.condition?.age !== 'number'),
};

describe('bucket lifecycle configuration', () => {
  it('is a set of rules at all', () => {
    expect(Array.isArray(LIFECYCLE.rule)).toBe(true);
    expect(rules().length).toBeGreaterThan(0);
  });

  /** The one that would quietly switch Autoclass off and put the lapsed-account bill back. */
  it('uses no SetStorageClass action, which would disable Autoclass', () => {
    const tiering = rules().filter((r) => r.action?.type === 'SetStorageClass');
    expect(tiering).toEqual([]);
    for (const rule of rules()) expect(rule.action?.type).toBe('Delete');
  });

  it('still expires chat media after 30 days', () => {
    const messages = rules().filter((r) =>
      (r.condition?.matchesPrefix ?? []).includes('messages/'),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].action).toEqual({ type: 'Delete' });
    expect(messages[0].condition.age).toBe(30);
  });

  /**
   * `matchesPrefix` is the whole aim of the delete rule. A rule without one deletes everything in
   * the bucket old enough, backups included, and reads as a tidy-up in review.
   */
  it('aims every delete at a prefix, and never at the vault backups', () => {
    for (const rule of rules()) {
      const prefixes = rule.condition?.matchesPrefix ?? [];
      expect(prefixes.length).toBeGreaterThan(0);
      for (const prefix of prefixes) {
        expect(prefix).not.toBe('');
        expect(prefix.startsWith('users/')).toBe(false);
      }
    }
  });

  /** A delete rule with no age would take effect on upload. */
  it('gives every delete an age', () => {
    for (const rule of rules()) expect(typeof rule.condition?.age).toBe('number');
  });

  /** The live file, through the same predicates the cases below are judged by. */
  it('passes every check it is judged by', () => {
    expect(faults.tiering(LIFECYCLE)).toBe(false);
    expect(faults.reachesBackups(LIFECYCLE)).toBe(false);
    expect(faults.unaimed(LIFECYCLE)).toBe(false);
    expect(faults.ageless(LIFECYCLE)).toBe(false);
  });
});

/**
 * A guard nobody has watched fail is a guard nobody has tested. These are the four edits that
 * would each be waved through in review, and each predicate has to catch its own.
 */
describe('the edits this guard exists to catch', () => {
  const MESSAGES_RULE = {
    action: { type: 'Delete' },
    condition: { age: 30, matchesPrefix: ['messages/'] },
  };

  it('catches age-based tiering, which switches Autoclass off', () => {
    const config = {
      rule: [
        MESSAGES_RULE,
        {
          action: { type: 'SetStorageClass', storageClass: 'COLDLINE' },
          condition: { age: 120, matchesPrefix: ['users/'] },
        },
      ],
    };
    expect(faults.tiering(config)).toBe(true);
  });

  it('catches a delete rule that reaches the vault backups', () => {
    const config = {
      rule: [MESSAGES_RULE, { action: { type: 'Delete' }, condition: { age: 365, matchesPrefix: ['users/'] } }],
    };
    expect(faults.reachesBackups(config)).toBe(true);
  });

  it('catches a delete rule with no prefix, which would reach the whole bucket', () => {
    const config = { rule: [{ action: { type: 'Delete' }, condition: { age: 30 } }] };
    expect(faults.unaimed(config)).toBe(true);
  });

  it('catches a delete rule with no age, which would fire on upload', () => {
    const config = {
      rule: [{ action: { type: 'Delete' }, condition: { matchesPrefix: ['messages/'] } }],
    };
    expect(faults.ageless(config)).toBe(true);
  });
});
