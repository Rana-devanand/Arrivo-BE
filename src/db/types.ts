import type {
  AuthUser,
  Contact,
  ContactStatus,
  FollowedJourney,
  InviteInfo,
  Journey,
  JourneyStatus,
  LocationPoint,
  NewJourney,
  AppNotification,
  NewNotification,
  NewRecentPlace,
  NewSavedPlace,
  Profile,
  RecentPlace,
  SavedPlace,
  SosEvent,
  WatchLink,
} from '../types.js';

export interface JourneyPatch {
  status?: JourneyStatus;
  expectedArrival?: string;
  arrivedAt?: string | null;
  endedAt?: string | null;
}

export interface ListJourneysOptions {
  status?: JourneyStatus[];
  limit: number;
  /** ISO timestamp: only journeys started before this. */
  before?: string;
}

/**
 * Everything the API needs from storage. Authorization is enforced by always
 * scoping to `ownerId`. Implemented by Supabase (real) and memory (demo/tests).
 */
export interface Db {
  authenticate(token: string): Promise<AuthUser | null>;

  upsertProfile(user: AuthUser): Promise<Profile>;
  updateProfile(id: string, patch: { displayName?: string; phone?: string | null; avatarUrl?: string | null }): Promise<Profile>;
  getDisplayName(id: string): Promise<string>;
  requestAccountDeletion(id: string): Promise<void>;

  listContacts(ownerId: string): Promise<Contact[]>;
  createContact(
    ownerId: string,
    input: { name: string; phone: string | null; email: string | null; inviteCode: string },
  ): Promise<Contact>;
  getContact(ownerId: string, id: string): Promise<Contact | null>;
  updateContactStatus(ownerId: string, id: string, status: ContactStatus): Promise<Contact | null>;
  removeContactFromOpenJourneys(ownerId: string, contactId: string): Promise<void>;
  getInviteByCode(code: string): Promise<InviteInfo | null>;
  /** Open invitations addressed to this email that nobody has answered yet. */
  listPendingInvitesByEmail(email: string, excludeOwnerId: string): Promise<InviteInfo[]>;
  /** Links the invited person to the contact and sets accepted or declined. */
  answerInvite(contactId: string, userId: string, status: 'accepted' | 'declined'): Promise<Contact | null>;
  listFollowing(userId: string): Promise<FollowedJourney[]>;
  /** People whose trusted contact I am (they invited me and I accepted). */
  listTrustedBy(userId: string): Promise<{ ownerId: string; since: string }[]>;

  listSavedPlaces(ownerId: string): Promise<SavedPlace[]>;
  createSavedPlace(ownerId: string, input: NewSavedPlace): Promise<SavedPlace>;
  deleteSavedPlace(ownerId: string, id: string): Promise<boolean>;

  createNotification(userId: string, n: NewNotification): Promise<void>;
  listNotifications(userId: string, limit: number): Promise<AppNotification[]>;
  countUnreadNotifications(userId: string): Promise<number>;
  /** Marks the given ids read, or everything when [ids] is not given. */
  markNotificationsRead(userId: string, ids?: string[]): Promise<void>;
  /** User ids of accepted contacts that have the app. Limited to [contactIds] when given. */
  listContactUserIds(ownerId: string, contactIds?: string[]): Promise<string[]>;

  listRecentPlaces(ownerId: string, limit: number): Promise<RecentPlace[]>;
  /** Adds the place, or bumps its use count when it is already there. */
  upsertRecentPlace(ownerId: string, p: NewRecentPlace): Promise<RecentPlace>;
  clearRecentPlaces(ownerId: string): Promise<void>;

  getOpenJourney(ownerId: string): Promise<Journey | null>;
  createJourney(ownerId: string, input: NewJourney): Promise<Journey>;
  getJourney(ownerId: string, id: string): Promise<Journey | null>;
  getJourneyByTrackToken(token: string): Promise<{ journey: Journey; ownerId: string } | null>;
  /** Profile photos by user id (only users that have one). */
  getAvatarUrls(userIds: string[]): Promise<Map<string, string>>;
  getJourneyForWatch(id: string): Promise<{ journey: Journey; ownerId: string } | null>;
  listJourneys(ownerId: string, opts: ListJourneysOptions): Promise<Journey[]>;
  /** Applies the patch only if the journey is currently in one of `fromStatuses`. Returns null otherwise. */
  updateJourney(ownerId: string, id: string, patch: JourneyPatch, fromStatuses: JourneyStatus[]): Promise<Journey | null>;
  markOverdue(nowIso: string): Promise<number>;
  /**
   * Takes the right to send the next progress update: succeeds only if
   * `lastProgressAt` still equals [previous], so concurrent callers send once.
   */
  claimProgressUpdate(journeyId: string, previous: string | null, nowIso: string): Promise<boolean>;

  addLocationPoints(journeyId: string, points: LocationPoint[]): Promise<void>;
  getLastLocation(journeyId: string): Promise<LocationPoint | null>;

  createWatchLink(link: Omit<WatchLink, 'revokedAt'>): Promise<WatchLink>;
  revokeWatchLinks(journeyId: string, ownerId: string): Promise<void>;
  getWatchLink(token: string): Promise<WatchLink | null>;

  createSos(ownerId: string, input: { journeyId: string | null; lat: number | null; lng: number | null }): Promise<SosEvent>;

  setSafetyTimer(ownerId: string, endsAt: string): Promise<void>;
  getSafetyTimer(ownerId: string): Promise<string | null>;
  clearSafetyTimer(ownerId: string): Promise<void>;

  upsertDevice(ownerId: string, platform: 'ios' | 'android' | 'web', pushToken: string): Promise<void>;
  listPushTokens(ownerId: string): Promise<string[]>;
  /** Removes the token. With [ownerId] only that person's copy goes (sign-out). */
  deletePushToken(pushToken: string, ownerId?: string): Promise<void>;

  /** Optional: a hint shown to the client when a token is rejected. */
  rejectHint?(token: string): string | undefined;
}
