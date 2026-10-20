export interface InviteEmail {
  to: string;
  inviterName: string;
  contactName: string;
  code: string;
}

export interface Mailer {
  /** Returns true when the email was handed to the provider. Never throws. */
  sendInvite(mail: InviteEmail): Promise<boolean>;
}

/** Used when no email provider is configured (local dev, tests). */
export const noopMailer: Mailer = { sendInvite: async () => false };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Sends through Resend (https://resend.com). The key stays on the server. */
export function resendMailer(opts: { apiKey: string; from: string }): Mailer {
  return {
    async sendInvite({ to, inviterName, contactName, code }) {
      const display = `${code.slice(0, 4)}-${code.slice(4)}`;
      const inviter = esc(inviterName);
      const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1b1f3b">
  <h2 style="margin:0 0 12px">${inviter} invited you to Arrivo</h2>
  <p>Hi ${esc(contactName)}, ${inviter} would like you to be a trusted contact on Arrivo, so you know they reached their destination safely.</p>
  <p><b>To accept:</b> install Arrivo and sign in with this email address. The invitation shows up on your Home screen.</p>
  <p>No luck? In the app open Contacts, tap "Got an invite code?" and enter:</p>
  <p style="font-size:26px;letter-spacing:4px;font-weight:bold;background:#f2f3fa;padding:14px;text-align:center;border-radius:12px">${display}</p>
  <p style="color:#6b7090;font-size:12px">If you do not know ${inviter}, ignore this email. Nothing happens unless you accept.</p>
</div>`;
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: opts.from,
            to: [to],
            subject: `${inviterName} invited you to Arrivo`,
            html,
            text: `${inviterName} invited you to be a trusted contact on Arrivo. Install the app and sign in with this email to accept, or enter the code ${display} under Contacts > Got an invite code?`,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) console.error(`[mail] provider rejected the message (${res.status})`);
        return res.ok;
      } catch {
        console.error('[mail] could not reach the provider');
        return false;
      }
    },
  };
}
