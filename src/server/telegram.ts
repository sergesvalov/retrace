import { confirmTelegramLogin, type AdminList, type TelegramProfile } from './accounts.js';
import type { Db } from './db.js';

/**
 * Login through a Telegram bot (TELEGRAM_BOT_TOKEN from @BotFather). The site opens
 * t.me/<bot>?start=<token>; the user presses Start; the bot — which polls Telegram itself,
 * so no public address or HTTPS is needed — ties the token to their Telegram account and
 * the waiting browser gets signed in.
 */

export interface TelegramBot {
  username: string;
  stop(): void;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; from?: TelegramProfile; text?: string };
}

export async function startTelegramBot(
  db: Db,
  token: string,
  admins: AdminList,
  publicUrl: string | undefined
): Promise<TelegramBot> {
  const api = async <T>(method: string, body?: object): Promise<T> => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    return data.result;
  };

  const me = await api<{ username: string }>('getMe');
  // Polling and a webhook exclude each other
  await api('deleteWebhook');

  let stopped = false;
  let offset = 0;
  const reply = (chatId: number, text: string) =>
    api('sendMessage', { chat_id: chatId, text }).catch((err) =>
      console.error('Telegram sendMessage:', err)
    );

  const handle = async (u: Update) => {
    const msg = u.message;
    if (!msg?.text || !msg.from) return;
    const m = /^\/start(?:\s+(\S+))?/.exec(msg.text.trim());
    if (!m) {
      await reply(msg.chat.id, 'Этот бот только помогает войти в Retrace. Нажмите «Войти через Telegram» на сайте.');
      return;
    }
    if (!m[1]) {
      await reply(
        msg.chat.id,
        `Чтобы войти, нажмите «Войти через Telegram» на сайте${publicUrl ? ` ${publicUrl}` : ''}.`
      );
      return;
    }
    const ok = await confirmTelegramLogin(db, m[1], msg.from, admins);
    await reply(
      msg.chat.id,
      ok
        ? '✅ Вход выполнен — вернитесь на сайт Retrace.'
        : 'Ссылка для входа устарела. Нажмите «Войти через Telegram» на сайте ещё раз.'
    );
  };

  const loop = async () => {
    while (!stopped) {
      try {
        const updates = await api<Update[]>('getUpdates', {
          offset,
          timeout: 50,
          allowed_updates: ['message'],
        });
        for (const u of updates) {
          offset = u.update_id + 1;
          await handle(u).catch((err) => console.error('Telegram update:', err));
        }
      } catch (err) {
        console.error('Telegram polling:', (err as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();

  return {
    username: me.username,
    stop: () => {
      stopped = true;
    },
  };
}
