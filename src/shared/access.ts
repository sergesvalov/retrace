import type {
  EventAccess,
  EventScope,
  GroupKind,
  GroupRole,
  ParticipantTrack,
  RaceEvent,
} from './types.js';

/**
 * Who may see and change what. Used by the server on every request; the client only hides
 * buttons by the flags the server sends.
 *
 * | scope        | view / add own track      | edit (course, map, everyone's tracks) |
 * |--------------|---------------------------|---------------------------------------|
 * | championship | every signed-in user      | organising club's admins and judges   |
 * | club         | members of the club       | the club's admins and judges          |
 * | personal     | owner + their family      | owner + their family                  |
 * The owner and site admins may do everything; a share link opens a personal event for viewing.
 */

export interface Viewer {
  /** null: not signed in */
  id: string | null;
  isAdmin: boolean;
  /** Role in each group the user belongs to (group id → role) */
  roles: Record<string, GroupRole>;
}

export const ANONYMOUS: Viewer = { id: null, isAdmin: false, roles: {} };

type EventAccessFields = Pick<RaceEvent, 'scope' | 'groupId' | 'ownerId' | 'shareToken'>;

const NONE: EventAccess = { canView: false, canUpload: false, canEdit: false };
const ALL: EventAccess = { canView: true, canUpload: true, canEdit: true };

export function eventAccess(
  v: Viewer,
  evt: EventAccessFields,
  shareToken?: string | null
): EventAccess {
  const viaLink = Boolean(evt.shareToken && shareToken && shareToken === evt.shareToken);
  if (v.isAdmin || (v.id !== null && evt.ownerId === v.id)) return ALL;
  const role = evt.groupId ? v.roles[evt.groupId] : undefined;
  const staff = role === 'admin' || role === 'judge';
  let access = NONE;
  switch (evt.scope) {
    case 'championship':
      access = v.id ? { canView: true, canUpload: true, canEdit: staff } : NONE;
      break;
    case 'club':
      access = role ? { canView: true, canUpload: true, canEdit: staff } : NONE;
      break;
    case 'personal':
      // the family shares everything
      access = role ? ALL : NONE;
      break;
    default:
      // events from before accounts: site admins only (handled above)
      access = NONE;
  }
  return viaLink && !access.canView ? { ...access, canView: true } : access;
}

/** Change or delete a track: event editors, and whoever uploaded it */
export function canEditParticipant(
  v: Viewer,
  access: EventAccess,
  p: Pick<ParticipantTrack, 'uploadedBy'>
): boolean {
  return access.canEdit || (v.id !== null && p.uploadedBy === v.id);
}

/**
 * May the user create (or move) an event with this audience? Returns an error message or null.
 * `groupKinds`: kind of every group the user belongs to.
 */
export function checkEventScope(
  v: Viewer,
  scope: EventScope,
  groupId: string | undefined,
  groupKinds: Record<string, GroupKind>
): string | null {
  if (!v.id) return 'Войдите, чтобы создавать события';
  const role = groupId ? v.roles[groupId] : undefined;
  const staff = role === 'admin' || role === 'judge';
  switch (scope) {
    case 'championship':
      if (groupId && groupKinds[groupId] !== 'club' && !v.isAdmin) return 'Организатор этапа — клуб';
      if (v.isAdmin || staff) return null;
      return 'Этап чемпионата создают админы и судьи клуба';
    case 'club':
      if (!groupId || (groupKinds[groupId] !== 'club' && !v.isAdmin)) return 'Выберите клуб';
      if (v.isAdmin || staff) return null;
      return 'Тренировку клуба создают админы и тренеры клуба';
    case 'personal':
      if (!groupId) return null;
      if (groupKinds[groupId] === 'family' && role) return null;
      return 'Личное событие можно открыть только своей семье';
    default:
      return 'Неизвестный тип события';
  }
}
