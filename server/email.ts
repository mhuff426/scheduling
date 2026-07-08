export function inviteLink(rawToken: string): string {
  const base = process.env.APP_BASE_URL || 'http://localhost:5173';
  return `${base}/register?token=${rawToken}`;
}

export async function sendInviteEmail(opts: {
  to: string;
  name: string;
  link: string;
}): Promise<{ delivered: boolean }> {
  const { to, name, link } = opts;

  if (process.env.SMTP_HOST) {
    // Dynamic import so nodemailer is only loaded when SMTP is configured.
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    } as any);
    await transport.sendMail({
      from: process.env.SMTP_FROM || 'scheduler@localhost',
      to,
      subject: 'Finish setting up your Shift Scheduler account',
      text: `Hi ${name},\n\nYou have been added to the Shift Scheduler. Click the link below to set your password and get started:\n\n${link}\n\nThis link expires in 7 days.\n`,
    });
    return { delivered: true };
  }

  // Dev default: log to console; caller may surface the link in the UI.
  console.log(`[invite] for ${to}: ${link}`);
  return { delivered: false };
}
