import type {
  FamilyMember,
  AdminNotificationRow,
  AdminUser,
  AuthUser,
  BillingTicket,
  Household,
  PlanKey,
  Subscription,
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

export interface ProfilePatch {
  displayName?: string;
  phone?: string | null;
  avatarUrl?: string | null;
  countryCode?: string | null;
}

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
  updateProfile(id: string, patch: ProfilePatch): Promise<Profile>;
  /** Everyone, newest first, with journey counts. Only the admin routes call this. */
  listUsersForAdmin(): Promise<AdminUser[]>;
  /** Everyone's notifications, newest first. Admin routes only. */
  listNotificationsForAdmin(limit: number): Promise<AdminNotificationRow[]>;
  /** Everyone's journeys, newest first. Admin routes only. */
  listJourneysForAdmin(limit: number): Promise<(Journey & { ownerId: string })[]>;
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
  /** Every journey in progress (any owner), for the scheduled sweep. */
  listOpenJourneysForSweep(): Promise<(Journey & { ownerId: string })[]>;
  /** Compare-and-set like [claimProgressUpdate], so one quiet spell is reported once. */
  claimStaleAlert(journeyId: string, previous: string | null, nowIso: string): Promise<boolean>;
  setSharingPaused(journeyId: string, paused: boolean): Promise<void>;
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

  /** Shared lookup cache (places and areas, never people). Null when missing or older than [maxAgeMs]. */
  getCache(key: string, maxAgeMs: number): Promise<unknown | null>;
  setCache(key: string, value: unknown): Promise<void>;

  setSafetyTimer(ownerId: string, endsAt: string): Promise<void>;
  getSafetyTimer(ownerId: string): Promise<string | null>;
  clearSafetyTimer(ownerId: string): Promise<void>;

  upsertDevice(ownerId: string, platform: 'ios' | 'android' | 'web', pushToken: string): Promise<void>;
  getSubscription(userId: string): Promise<Subscription | null>;
  getSubscriptionByDodoId(dodoSubscriptionId: string): Promise<Subscription | null>;
  upsertSubscription(sub: Subscription): Promise<void>;

  createBillingTicket(t: BillingTicket): Promise<void>;
  getBillingTicket(tokenHash: string): Promise<BillingTicket | null>;
  deleteExpiredBillingTickets(nowIso: string): Promise<void>;
  /** Remembers a checkout we started, to tie the payment back to the person. */
  recordCheckout(c: { userId: string; email: string; planKey: PlanKey; sessionId: string | null }): Promise<void>;
  /** The newest checkout started with this email since [sinceIso]. */
  findLatestCheckoutByEmail(email: string, sinceIso: string): Promise<{ userId: string; planKey: PlanKey } | null>;

  /** Arrivo Plus Family: everyone the owner invited, newest last (cancelled ones too). */
  listFamilyMembers(ownerId: string): Promise<FamilyMember[]>;
  addFamilyMember(ownerId: string, email: string): Promise<FamilyMember>;
  getFamilyMember(id: string): Promise<FamilyMember | null>;
  /** Pending invitations for this email (lower case). */
  listFamilyInvitesByEmail(email: string): Promise<FamilyMember[]>;
  /** The Family this person accepted, if any. */
  getFamilyMembershipOf(userId: string): Promise<FamilyMember | null>;
  /** Only an invitation still waiting changes; returns null otherwise. */
  answerFamilyInvite(id: string, userId: string, status: 'accepted' | 'declined'): Promise<FamilyMember | null>;
  /** The owner withdraws an invitation nobody answered yet. Null when it cannot. */
  cancelFamilyInvite(ownerId: string, id: string): Promise<FamilyMember | null>;

  getHousehold(ownerId: string): Promise<Household | null>;
  /** Creates or replaces the owner's household. */
  saveHousehold(ownerId: string, name: string, contactIds: string[]): Promise<Household>;
  deleteHousehold(ownerId: string): Promise<void>;

  listPushTokens(ownerId: string): Promise<string[]>;
  /** Removes the token. With [ownerId] only that person's copy goes (sign-out). */
  deletePushToken(pushToken: string, ownerId?: string): Promise<void>;

  /** Optional: a hint shown to the client when a token is rejected. */
  rejectHint?(token: string): string | undefined;
}
