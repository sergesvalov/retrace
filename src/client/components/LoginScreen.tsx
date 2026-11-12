import React, { useEffect, useRef, useState } from 'react';
import { Compass, Mail, Send } from 'lucide-react';
import { api, type Me } from '../session.js';

interface Props {
  login: Me['login'];
  /** "Вас пригласили в клуб «…»" when the page was opened by an invitation link */
  inviteNote?: string | null;
  onSignedIn: () => void;
}

/**
 * Sign in or sign up with an e-mail or a nickname and a password. Sign-in through the Telegram bot and by a
 * 6-digit e-mail code is kept below; it shows only when the server switches it on.
 */
export const LoginScreen: React.FC<Props> = ({ login, inviteNote, onSignedIn }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  /** e-mail or nickname for the password form */
  const [account, setAccount] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tgWaiting, setTgWaiting] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
  }, []);

  async function startTelegram() {
    setError(null);
    try {
      const { token, url } = await api<{ token: string; url: string }>('POST', 'api/auth/telegram/start');
      window.open(url, '_blank', 'noopener');
      setTgWaiting(url);
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        const res = await api<{ status: string }>(
          'GET',
          `api/auth/telegram/poll?token=${encodeURIComponent(token)}`
        ).catch(() => ({ status: 'pending' }));
        if (res.status === 'done') {
          window.clearInterval(pollRef.current!);
          onSignedIn();
        } else if (res.status === 'expired') {
          window.clearInterval(pollRef.current!);
          setTgWaiting(null);
          setError('Время на вход вышло — нажмите ещё раз');
        }
      }, 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'register' && password !== password2) {
      setError('Пароли не совпадают');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') {
        await api('POST', 'api/auth/register', { login: account, name, password });
      } else {
        await api('POST', 'api/auth/login', { login: account, password });
      }
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', 'api/auth/email/start', { email });
      setCodeSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', 'api/auth/email/verify', { email, code });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input =
    'w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-emerald-500';

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center gap-2.5 justify-center">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
            <Compass className="w-6 h-6" />
          </div>
          <span className="text-xl font-bold tracking-tight">Retrace</span>
        </div>
        <p className="text-center text-sm text-slate-400">
          Разбор GPS-треков: этапы чемпионата, тренировки клуба, личные пробежки.
        </p>
        {inviteNote && (
          <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-500/40 text-sm text-emerald-100">
            {inviteNote} Войдите, чтобы вступить.
          </div>
        )}

        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-700 space-y-4">
          {login.password && (
            <form onSubmit={(e) => void submitPassword(e)} className="space-y-2.5">
              <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-950 border border-slate-800 text-sm">
                {(['login', 'register'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setMode(m);
                      setError(null);
                    }}
                    className={`py-1.5 rounded-lg transition ${
                      mode === m ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m === 'login' ? 'Вход' : 'Регистрация'}
                  </button>
                ))}
              </div>
              {mode === 'register' && (
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Имя (видно в клубе и в треках)"
                  maxLength={40}
                  autoComplete="name"
                  className={input}
                />
              )}
              <input
                required
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="Почта или ник"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={200}
                className={input}
              />
              {mode === 'register' && (
                <div className="text-[11px] text-slate-500">
                  Ник — 3–30 букв или цифр, можно «_», «.» и «-». Писем сайт не шлёт: забытый пароль задаёт
                  администратор.
                </div>
              )}
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? 'Пароль (от 8 символов)' : 'Пароль'}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                className={input}
              />
              {mode === 'register' && (
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  placeholder="Пароль ещё раз"
                  autoComplete="new-password"
                  className={input}
                />
              )}
              <button
                disabled={busy}
                className="w-full px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
              >
                {mode === 'register' ? 'Зарегистрироваться' : 'Войти'}
              </button>
              {mode === 'login' && (
                <div className="text-[11px] text-slate-500 text-center">
                  Забыли пароль? Администратор сайта может задать новый.
                </div>
              )}
            </form>
          )}

          {login.password && (login.telegram || login.email) && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <div className="h-px flex-1 bg-slate-800" />
              или
              <div className="h-px flex-1 bg-slate-800" />
            </div>
          )}

          {login.telegram && (
            <div className="space-y-2">
              <button
                onClick={() => void startTelegram()}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold"
              >
                <Send className="w-4 h-4" />
                Войти через Telegram
              </button>
              {tgWaiting && (
                <div className="text-xs text-slate-400">
                  В Telegram откроется бот @{login.telegram.bot} — нажмите в нём «Start» и
                  вернитесь сюда, страница войдёт сама. Не открылся?{' '}
                  <a href={tgWaiting} target="_blank" rel="noopener" className="text-sky-400 underline">
                    Открыть бота
                  </a>
                </div>
              )}
            </div>
          )}

          {login.telegram && login.email && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <div className="h-px flex-1 bg-slate-800" />
              или
              <div className="h-px flex-1 bg-slate-800" />
            </div>
          )}

          {login.email &&
            (!codeSent ? (
              <form onSubmit={(e) => void sendCode(e)} className="space-y-2">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Почта"
                  autoComplete="email"
                  className={input}
                />
                <button
                  disabled={busy || !email}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-sm font-medium disabled:opacity-50"
                >
                  <Mail className="w-4 h-4" />
                  Прислать код на почту
                </button>
              </form>
            ) : (
              <form onSubmit={(e) => void verifyCode(e)} className="space-y-2">
                <div className="text-xs text-slate-400">
                  Код отправлен на {email}. Письмо могло попасть в «Спам».
                </div>
                <input
                  inputMode="numeric"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="6 цифр"
                  className={`${input} tracking-[0.4em] text-center font-mono text-lg`}
                />
                <button
                  disabled={busy || code.length !== 6}
                  className="w-full px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
                >
                  Войти
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCodeSent(false);
                    setCode('');
                  }}
                  className="w-full text-xs text-slate-400 hover:text-slate-200"
                >
                  Другая почта
                </button>
              </form>
            ))}

          {!login.password && !login.email && !login.telegram && (
            <div className="text-sm text-amber-300">
              Вход ещё не настроен: администратору нужно указать TELEGRAM_BOT_TOKEN или SMTP_URL.
            </div>
          )}
          {error && <div className="text-sm text-rose-300">{error}</div>}
        </div>
      </div>
    </div>
  );
};
