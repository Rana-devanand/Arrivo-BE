import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import { logInfo } from './log.js';

export interface PushMessage {
  title: string;
  body: string;
  /** Strings only (an FCM rule). Ids to open the right screen, never a location. */
  data?: Record<string, string>;
}

/** Sends a message to phones. Returns the tokens Firebase says are dead, so they can be removed. */
export interface PushSender {
  send(tokens: string[], msg: PushMessage): Promise<string[]>;
}

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Firebase Cloud Messaging through the Admin SDK. [serviceAccount] is the JSON of a
 * Firebase service account key, as plain JSON or base64 (easier in hosting dashboards).
 */
export function fcmSender(serviceAccount: string): PushSender {
  const json = serviceAccount.trim().startsWith('{')
    ? serviceAccount
    : Buffer.from(serviceAccount, 'base64').toString('utf8');
  const app = getApps()[0] ?? initializeApp({ credential: cert(JSON.parse(json)) });
  const messaging = getMessaging(app);

  return {
    async send(tokens, msg) {
      if (tokens.length === 0) return [];
      const res = await messaging.sendEachForMulticast({
        tokens,
        notification: { title: msg.title, body: msg.body },
        data: msg.data,
        android: { priority: 'high', notification: { channelId: 'arrivo_alerts' } },
      });
      const dead: string[] = [];
      const errors = new Map<string, number>();
      res.responses.forEach((r, i) => {
        const token = tokens[i];
        if (!r.success && r.error) errors.set(r.error.code, (errors.get(r.error.code) ?? 0) + 1);
        if (token && !r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) dead.push(token);
      });
      // Counts and Firebase error codes only: never the tokens or the text sent.
      const why = errors.size ? ` errors=${[...errors].map(([code, n]) => `${code}x${n}`).join(',')}` : '';
      logInfo(`[push] fcm type=${msg.data?.type ?? '-'} sent=${res.successCount} failed=${res.failureCount}${why}`);
      return dead;
    },
  };
}

let sender: PushSender | null = null;

/** Called once at start-up (and by tests). Without a sender, push is simply off. */
export function setPushSender(s: PushSender | null): void {
  sender = s;
}

export function getPushSender(): PushSender | null {
  return sender;
}
