/**
 * Login codes by e-mail. SMTP_URL, e.g. smtps://user:app-password@smtp.yandex.ru:465, and
 * MAIL_FROM ("Retrace <user@yandex.ru>"). Without SMTP_URL e-mail login is off — except in
 * development (NODE_ENV not production), where the code is printed to the server log.
 */

export interface Mailer {
  enabled: boolean;
  sendLoginCode(email: string, code: string): Promise<void>;
}

export async function createMailer(env = process.env): Promise<Mailer> {
  const url = env.SMTP_URL;
  if (!url) {
    const dev = env.NODE_ENV !== 'production';
    return {
      enabled: dev,
      sendLoginCode: async (email, code) => {
        if (!dev) throw new Error('E-mail login is not configured');
        console.log(`[dev] login code for ${email}: ${code}`);
      },
    };
  }
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport(url);
  const from = env.MAIL_FROM || new URL(url).username || 'retrace';
  return {
    enabled: true,
    sendLoginCode: async (email, code) => {
      await transport.sendMail({
        from,
        to: email,
        subject: `Код входа в Retrace: ${code}`,
        text:
          `Ваш код входа в Retrace: ${code}\n\n` +
          'Код действует 15 минут. Если вы не входили — просто удалите это письмо.',
      });
    },
  };
}
