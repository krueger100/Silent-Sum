import {
  AUTO_LOCK_SUSPENSION_GRACE_MS,
  AutoLockSuspension,
} from '@/privacy/autoLockSuspension';
import { AUTO_LOCK_SUSPENSION_GRACE_MS as GRACE_FROM_TYPES } from '@/privacy/types';

describe('AutoLockSuspension', () => {
  let suspension: AutoLockSuspension;

  beforeEach(() => {
    suspension = new AutoLockSuspension();
  });

  it('starts unsuspended', () => {
    expect(suspension.isSuspended).toBe(false);
    expect(suspension.count).toBe(0);
  });

  it('suspends and resumes', () => {
    suspension.suspend();
    expect(suspension.isSuspended).toBe(true);
    suspension.resume();
    expect(suspension.isSuspended).toBe(false);
  });

  it('stays suspended until every nested flow has resumed', () => {
    suspension.suspend();
    suspension.suspend();
    expect(suspension.count).toBe(2);

    suspension.resume();
    expect(suspension.isSuspended).toBe(true);

    suspension.resume();
    expect(suspension.isSuspended).toBe(false);
    expect(suspension.count).toBe(0);
  });

  it('never goes below zero on a stray resume', () => {
    suspension.resume();
    expect(suspension.count).toBe(0);
    expect(suspension.isSuspended).toBe(false);
  });

  it('never goes below zero however many strays arrive', () => {
    suspension.resume();
    suspension.resume();
    suspension.resume();
    expect(suspension.count).toBe(0);
  });

  it('does not let a stray resume swallow the next real suspend', () => {
    suspension.suspend();
    suspension.resume();
    suspension.resume(); // unbalanced: a picker reporting its cancel twice
    suspension.resume();

    suspension.suspend();
    expect(suspension.isSuspended).toBe(true);
    expect(suspension.count).toBe(1);
  });

  it('drops every outstanding suspension on reset', () => {
    suspension.suspend();
    suspension.suspend();
    suspension.reset();
    expect(suspension.count).toBe(0);
    expect(suspension.isSuspended).toBe(false);
  });

  it('is unsuspended again after a reset, without going negative', () => {
    suspension.reset();
    suspension.resume();
    suspension.suspend();
    expect(suspension.isSuspended).toBe(true);
  });
});

describe('AUTO_LOCK_SUSPENSION_GRACE_MS', () => {
  it('is five minutes', () => {
    expect(AUTO_LOCK_SUSPENSION_GRACE_MS).toBe(5 * 60_000);
  });

  it('is the constant declared in @/privacy/types, not a copy', () => {
    expect(AUTO_LOCK_SUSPENSION_GRACE_MS).toBe(GRACE_FROM_TYPES);
  });
});
