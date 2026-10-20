import { createHash, randomBytes } from 'node:crypto';

import { AppError } from './errors.js';

export type PhotoKind = 'avatar' | 'plate';

export interface UploadTicket {
  uploadUrl: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  publicId: string;
  /** Send these two fields only when true (they are part of the signature). */
  overwrite: boolean;
  invalidate: boolean;
}

/**
 * Photos go from the phone straight to Cloudinary. This server only signs the
 * upload (the API secret never leaves it) and later checks that an address
 * saved on a profile or journey really is that user's own Cloudinary image.
 */
export interface Cloudinary {
  readonly enabled: boolean;
  ticket(userId: string, kind?: PhotoKind): UploadTicket;
  isOwnAvatar(url: string, userId: string): boolean;
  isOwnPlate(url: string, userId: string): boolean;
}

export const noCloudinary: Cloudinary = {
  enabled: false,
  ticket() {
    throw new AppError(503, 'uploads_unavailable', 'Photo upload is not set up on the server yet.');
  },
  isOwnAvatar: () => false,
  isOwnPlate: () => false,
};

export function cloudinary(opts: { cloudName: string; apiKey: string; apiSecret: string }): Cloudinary {
  const base = `https://res.cloudinary.com/${opts.cloudName}/image/upload/`;
  const avatarId = (userId: string) => `arrivo/avatars/${userId}`;
  return {
    enabled: true,
    ticket(userId, kind = 'avatar') {
      const timestamp = Math.floor(Date.now() / 1000);
      // A profile photo replaces the old one. Every plate photo is a new file.
      const replace = kind === 'avatar';
      const publicId = replace ? avatarId(userId) : `arrivo/plates/${userId}/${randomBytes(8).toString('hex')}`;
      // Cloudinary signs the sorted "key=value" pairs plus the API secret (SHA-1).
      const toSign = `${replace ? 'invalidate=true&overwrite=true&' : ''}public_id=${publicId}&timestamp=${timestamp}${opts.apiSecret}`;
      return {
        uploadUrl: `https://api.cloudinary.com/v1_1/${opts.cloudName}/image/upload`,
        apiKey: opts.apiKey,
        timestamp,
        signature: createHash('sha1').update(toSign).digest('hex'),
        publicId,
        overwrite: replace,
        invalidate: replace,
      };
    },
    isOwnAvatar: (url, userId) => url.startsWith(base) && url.includes(`/${avatarId(userId)}`),
    isOwnPlate: (url, userId) => url.startsWith(base) && url.includes(`/arrivo/plates/${userId}/`),
  };
}
