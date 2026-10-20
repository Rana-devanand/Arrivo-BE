import { randomInt } from 'node:crypto';

// No 0/O/1/I/L so a code read out loud or typed from a screenshot is hard to get wrong.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 8 characters, about 10^11 possibilities. */
export function newInviteCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Accepts "abcd-efgh", " ABCD EFGH " etc. */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const isValidInviteCode = (code: string) => code.length === 8;
