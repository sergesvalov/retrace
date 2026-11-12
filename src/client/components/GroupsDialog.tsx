import React, { useEffect, useState } from 'react';
import { Check, Copy, LogOut, Plus, Trash2, UserMinus, X } from 'lucide-react';
import { GROUP_ROLES, type GroupKind, type GroupRole } from '../../shared/types.js';
import { api, ROLE_LABELS, type Me, type MyGroup } from '../session.js';

interface Member {
  userId: string;
  name: string;
  role: GroupRole;
  email: string | null;
  telegramUsername: string | null;
}

interface Props {
  me: Me;
  onChanged: () => void;
  onClose: () => void;
}

const KIND_LABEL: Record<GroupKind, string> = { club: 'Клуб', family: 'Семья' };

/**
 * Profile, clubs and families: members and their roles, invitation links. Clubs are created
 * by site admins; anyone may create a family to share personal events with.
 */
export const GroupsDialog: React.FC<Props> = ({ me, onChanged, onClose }) => {
  const user = me.user!;
  const [name, setName] = useState(user.name);
  const [selectedId, setSelectedId] = useState<string | null>(me.groups[0]?.id ?? null);
  const [members, setMembers] = useState<Member[]>([]);
  const [inviteRole, setInviteRole] = useState<GroupRole>('member');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected: MyGroup | undefined = me.groups.find((g) => g.id === selectedId);
  const canManage = Boolean(selected && (selected.role === 'admin' || user.isAdmin));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    setInviteUrl(null);
    setMembers([]);
    if (!selectedId) return;
    api<{ members: Member[] }>('GET', `/api/groups/${selectedId}/members`)
      .then((r) => setMembers(r.members))
      .catch((err) => setError(err.message));
  }, [selectedId]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const createGroup = (kind: GroupKind) =>
    run(async () => {
      const title = window.prompt(
        kind === 'club' ? 'Название клуба' : 'Название семьи (видно только её членам)',
        kind === 'family' ? `Семья ${user.name}` : ''
      );
      if (!title?.trim()) return;
      const res = await api<{ id: string }>('POST', '/api/groups', { kind, name: title.trim() });
      setSelectedId(res.id);
      onChanged();
    });

  const makeInvite = () =>
    run(async () => {
      const { token } = await api<{ token: string }>('POST', `/api/groups/${selectedId}/invites`, {
        role: inviteRole,
      });
      setInviteUrl(`${window.location.origin}/?invite=${token}`);
      setCopied(false);
    });

  const roleChange = (userId: string, role: GroupRole) =>
    run(async () => {
      const r = await api<{ members: Member[] }>('PATCH', `/api/groups/${selectedId}/members/${userId}`, {
        role,
      });
      setMembers(r.members);
      onChanged();
    });

  const removeMember = (m: Member) =>
    run(async () => {
      const self = m.userId === user.id;
      if (!window.confirm(self ? `Выйти из «${selected?.name}»?` : `Убрать ${m.name} из «${selected?.name}»?`))
        return;
      await api('DELETE', `/api/groups/${selectedId}/members/${m.userId}`);
      if (self) setSelectedId(null);
      else setMembers((list) => list.filter((x) => x.userId !== m.userId));
      onChanged();
    });

  const groupList = (kind: GroupKind) => me.groups.filter((g) => g.kind === kind);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl flex flex-col">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Профиль, клубы и семья</h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[240px_1fr] overflow-auto">
          {/* Left: profile + groups */}
          <div className="p-4 border-b md:border-b-0 md:border-r border-slate-800 space-y-4">
            <form
              className="space-y-1"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api('PATCH', '/api/me', { name });
                  onChanged();
                });
              }}
            >
              <div className="text-xs text-slate-400">Ваше имя (видно в клубах)</div>
              <div className="flex gap-1">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={40}
                  className="min-w-0 flex-1 px-2 py-1 rounded-lg bg-slate-950 border border-slate-700 text-sm"
                />
                <button
                  disabled={!name.trim() || name === user.name}
                  className="px-2 rounded-lg bg-emerald-600 disabled:opacity-40 text-white"
                  title="Сохранить"
                >
                  <Check className="w-4 h-4" />
                </button>
              </div>
              <div className="text-[11px] text-slate-500">
                {user.email ?? (user.telegramUsername ? `@${user.telegramUsername}` : 'Telegram')}
                {user.isAdmin && ' · администратор сайта'}
              </div>
            </form>

            {(['club', 'family'] as GroupKind[]).map((kind) => (
              <div key={kind} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    {kind === 'club' ? 'Клубы' : 'Семья'}
                  </span>
                  {(kind === 'family' || user.isAdmin) && (
                    <button
                      onClick={() => void createGroup(kind)}
                      className="inline-flex items-center gap-0.5 text-xs text-emerald-400 hover:text-emerald-300"
                      title={kind === 'club' ? 'Новый клуб' : 'Семейная группа: ей видны ваши личные события'}
                    >
                      <Plus className="w-3 h-3" />
                      {kind === 'club' ? 'Клуб' : 'Семья'}
                    </button>
                  )}
                </div>
                {groupList(kind).length === 0 && (
                  <div className="text-[11px] text-slate-500">
                    {kind === 'club'
                      ? 'Пока ни одного — в клуб приглашают ссылкой.'
                      : 'Создайте семью и пригласите близких: им будут видны ваши личные события.'}
                  </div>
                )}
                {groupList(kind).map((g) => (
                  <button
                    key={g.id}
                    onClick={() => setSelectedId(g.id)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg border text-sm transition ${
                      g.id === selectedId
                        ? 'bg-emerald-600/20 border-emerald-500 text-white'
                        : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:border-slate-500'
                    }`}
                  >
                    <div className="font-medium truncate">{g.name}</div>
                    <div className="text-[11px] text-slate-400">
                      {ROLE_LABELS[g.role]} · {g.memberCount} чел.
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Right: the selected group */}
          <div className="p-4 space-y-4">
            {!selected ? (
              <div className="text-sm text-slate-400">Выберите клуб или семью слева.</div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">
                      {KIND_LABEL[selected.kind]}
                    </div>
                    <div className="text-lg font-semibold text-white">{selected.name}</div>
                  </div>
                  {canManage && (
                    <div className="flex gap-1">
                      <button
                        onClick={() =>
                          void run(async () => {
                            const n = window.prompt('Название', selected.name)?.trim();
                            if (!n) return;
                            await api('PATCH', `/api/groups/${selected.id}`, { name: n });
                            onChanged();
                          })
                        }
                        className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-300 hover:text-white"
                      >
                        Переименовать
                      </button>
                      <button
                        onClick={() =>
                          void run(async () => {
                            if (
                              !window.confirm(
                                `Удалить «${selected.name}»? События останутся, но станут видны только их авторам.`
                              )
                            )
                              return;
                            await api('DELETE', `/api/groups/${selected.id}`);
                            setSelectedId(null);
                            onChanged();
                          })
                        }
                        className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-rose-300"
                        title="Удалить"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {canManage && (
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                    <div className="text-sm font-medium text-slate-200">Пригласить</div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-slate-400">как</span>
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as GroupRole)}
                        className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1"
                      >
                        {GROUP_ROLES.filter((r) => selected.kind === 'club' || r !== 'judge').map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => void makeInvite()}
                        className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                      >
                        Создать ссылку
                      </button>
                    </div>
                    {inviteUrl && (
                      <div className="flex items-center gap-1">
                        <input
                          readOnly
                          value={inviteUrl}
                          onFocus={(e) => e.target.select()}
                          className="min-w-0 flex-1 px-2 py-1 rounded bg-slate-900 border border-slate-700 text-xs font-mono"
                        />
                        <button
                          onClick={() => {
                            void navigator.clipboard.writeText(inviteUrl);
                            setCopied(true);
                          }}
                          className="p-1.5 rounded bg-slate-800 border border-slate-700 text-slate-300"
                          title="Скопировать"
                        >
                          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    )}
                    <div className="text-[11px] text-slate-500">
                      Ссылка действует 14 дней, по ней может вступить любой, у кого она есть.
                      {selected.kind === 'club' &&
                        ' Судьи и тренеры ведут события клуба: трасса, карта, треки всех.'}
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Участники ({members.length})
                  </div>
                  {members.map((m) => (
                    <div
                      key={m.userId}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-slate-800/50 border border-slate-800"
                    >
                      <div className="min-w-0">
                        <div className="text-sm text-slate-100 truncate">
                          {m.name}
                          {m.userId === user.id && <span className="text-slate-500"> (вы)</span>}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {m.email ?? (m.telegramUsername ? `@${m.telegramUsername}` : 'Telegram')}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {canManage ? (
                          <select
                            value={m.role}
                            onChange={(e) => void roleChange(m.userId, e.target.value as GroupRole)}
                            className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs"
                          >
                            {GROUP_ROLES.filter((r) => selected.kind === 'club' || r !== 'judge').map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs text-slate-400">{ROLE_LABELS[m.role]}</span>
                        )}
                        {(canManage || m.userId === user.id) && (
                          <button
                            onClick={() => void removeMember(m)}
                            className="p-1 text-slate-500 hover:text-rose-300"
                            title={m.userId === user.id ? 'Выйти' : 'Убрать'}
                          >
                            {m.userId === user.id ? (
                              <LogOut className="w-3.5 h-3.5" />
                            ) : (
                              <UserMinus className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {error && <div className="text-sm text-rose-300">{error}</div>}
          </div>
        </div>
      </div>
    </div>
  );
};
