import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS,
  canEditParticipant,
  checkEventScope,
  eventAccess,
  type Viewer,
} from './access.js';

const user = (id: string, roles: Viewer['roles'] = {}, isAdmin = false): Viewer => ({
  id,
  isAdmin,
  roles,
});
const flags = (a: { canView: boolean; canUpload: boolean; canEdit: boolean }) =>
  `${a.canView ? 'V' : '-'}${a.canUpload ? 'U' : '-'}${a.canEdit ? 'E' : '-'}`;

describe('eventAccess', () => {
  const stage = { scope: 'championship' as const, groupId: 'club1', ownerId: 'judge' };
  const training = { scope: 'club' as const, groupId: 'club1', ownerId: 'coach' };
  const personal = { scope: 'personal' as const, groupId: 'fam', ownerId: 'me', shareToken: 'tok' };

  it('championship stage: every signed-in user views and adds a track; club staff edit', () => {
    expect(flags(eventAccess(user('x'), stage))).toBe('VU-');
    expect(flags(eventAccess(user('j', { club1: 'judge' }), stage))).toBe('VUE');
    expect(flags(eventAccess(user('m', { club1: 'member' }), stage))).toBe('VU-');
    expect(flags(eventAccess(ANONYMOUS, stage))).toBe('---');
  });

  it('club training: members only; admins and judges edit', () => {
    expect(flags(eventAccess(user('x'), training))).toBe('---');
    expect(flags(eventAccess(user('m', { club1: 'member' }), training))).toBe('VU-');
    expect(flags(eventAccess(user('a', { club1: 'admin' }), training))).toBe('VUE');
    expect(flags(eventAccess(user('coach'), training))).toBe('VUE');
  });

  it('personal: owner and family; a share link only lets others look', () => {
    expect(flags(eventAccess(user('me'), personal))).toBe('VUE');
    expect(flags(eventAccess(user('wife', { fam: 'member' }), personal))).toBe('VUE');
    expect(flags(eventAccess(user('x'), personal))).toBe('---');
    expect(flags(eventAccess(user('x'), personal, 'tok'))).toBe('V--');
    expect(flags(eventAccess(ANONYMOUS, personal, 'tok'))).toBe('V--');
    expect(flags(eventAccess(ANONYMOUS, personal, 'wrong'))).toBe('---');
    expect(flags(eventAccess(ANONYMOUS, { ...personal, shareToken: undefined }, undefined))).toBe('---');
  });

  it('site admins see everything, also events from before accounts', () => {
    expect(flags(eventAccess(user('adm', {}, true), {}))).toBe('VUE');
    expect(flags(eventAccess(user('x'), {}))).toBe('---');
  });
});

describe('canEditParticipant', () => {
  it('the uploader may change their own track without edit rights on the event', () => {
    const access = { canView: true, canUpload: true, canEdit: false };
    expect(canEditParticipant(user('me'), access, { uploadedBy: 'me' })).toBe(true);
    expect(canEditParticipant(user('me'), access, { uploadedBy: 'other' })).toBe(false);
    expect(canEditParticipant(ANONYMOUS, access, { uploadedBy: undefined })).toBe(false);
  });
});

describe('checkEventScope', () => {
  const kinds = { club1: 'club' as const, fam: 'family' as const };
  it('who may create what', () => {
    expect(checkEventScope(user('m', { club1: 'member' }), 'championship', 'club1', kinds)).not.toBeNull();
    expect(checkEventScope(user('j', { club1: 'judge' }), 'championship', 'club1', kinds)).toBeNull();
    expect(checkEventScope(user('a', {}, true), 'championship', undefined, kinds)).toBeNull();
    expect(checkEventScope(user('m', { club1: 'member' }), 'club', 'club1', kinds)).not.toBeNull();
    expect(checkEventScope(user('c', { club1: 'admin' }), 'club', 'club1', kinds)).toBeNull();
    expect(checkEventScope(user('me'), 'personal', undefined, kinds)).toBeNull();
    expect(checkEventScope(user('me', { fam: 'member' }), 'personal', 'fam', kinds)).toBeNull();
    expect(checkEventScope(user('me', { club1: 'admin' }), 'personal', 'club1', kinds)).not.toBeNull();
    expect(checkEventScope(ANONYMOUS, 'personal', undefined, kinds)).not.toBeNull();
  });
});
