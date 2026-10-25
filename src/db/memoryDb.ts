import { randomUUID } from 'node:crypto';

import type {
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
import type { Db, JourneyPatch, ListJourneysOptions } from './types.js';

const OPEN: JourneyStatus[] = ['active', 'overdue'];

/**
 * In-memory Db for tests and local demos (no Supabase needed).
 * Accepts tokens of the form "dev:<name>". Refuses to run in production
 * (enforced in config).
 */
export class MemoryDb implements Db {
  profiles = new Map<string, Profile & { deletionRequested?: boolean }>();
  contacts = new Map<string, Contact & { ownerId: string; contactUserId?: string | null }>();
  journeys = new Map<string, Journey & { ownerId: string }>();
  points = new Map<string, LocationPoint[]>();
  links = new Map<string, WatchLink>();
  sos: (SosEvent & { ownerId: string })[] = [];
  timers = new Map<string, string>();
  saved = new Map<string, SavedPlace & { ownerId: string }>();
  notifications: (AppNotification & { userId: string })[] = [];
  recents = new Map<string, RecentPlace & { ownerId: string }>();
  devices = new Map<string, { ownerId: string; platform: string }>();

  rejectHint(token: string): string | undefined {
    return token.split('.').length === 3
      ? 'This server is running in demo (memory) mode and only accepts dev tokens. Set DB_DRIVER=supabase in backend/.env and restart it.'
      : undefined;
  }

  async authenticate(token: string): Promise<AuthUser | null> {
    if (!token.startsWith('dev:') || token.length < 5) return null;
    const name = token.slice(4);
    return { id: `dev-${name}`, email: `${name}@example.test`, emailVerified: true, displayName: name };
  }

  async upsertProfile(user: AuthUser): Promise<Profile> {
    const existing = this.profiles.get(user.id);
    if (existing) return existing;
    const p: Profile = {
      id: user.id,
      displayName: user.displayName ?? '',
      phone: null,
      avatarUrl: null,
      createdAt: new Date().toISOString(),
    };
    this.profiles.set(user.id, p);
    return p;
  }

  async updateProfile(id: string, patch: { displayName?: string; phone?: string | null; avatarUrl?: string | null }): Promise<Profile> {
    const p = this.profiles.get(id);
    if (!p) throw new Error('profile missing');
    if (patch.displayName !== undefined) p.displayName = patch.displayName;
    if (patch.phone !== undefined) p.phone = patch.phone;
    if (patch.avatarUrl !== undefined) p.avatarUrl = patch.avatarUrl;
    return p;
  }

  async getDisplayName(id: string): Promise<string> {
    return this.profiles.get(id)?.displayName ?? '';
  }

  async requestAccountDeletion(id: string): Promise<void> {
    const p = this.profiles.get(id);
    if (p) p.deletionRequested = true;
  }

  async listContacts(ownerId: string): Promise<Contact[]> {
    return [...this.contacts.values()]
      .filter((c) => c.ownerId === ownerId && c.status !== 'removed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((c) => ({ ...strip(c), avatarUrl: (c.contactUserId && this.profiles.get(c.contactUserId)?.avatarUrl) || null }));
  }

  async createContact(
    ownerId: string,
    input: { name: string; phone: string | null; email: string | null; inviteCode: string },
  ): Promise<Contact> {
    const c = { id: randomUUID(), ownerId, ...input, status: 'invited' as ContactStatus, createdAt: new Date().toISOString() };
    this.contacts.set(c.id, c);
    return strip(c);
  }

  async getContact(ownerId: string, id: string): Promise<Contact | null> {
    const c = this.contacts.get(id);
    return c && c.ownerId === ownerId ? strip(c) : null;
  }

  async updateContactStatus(ownerId: string, id: string, status: ContactStatus): Promise<Contact | null> {
    const c = this.contacts.get(id);
    if (!c || c.ownerId !== ownerId) return null;
    c.status = status;
    return strip(c);
  }

  async removeContactFromOpenJourneys(ownerId: string, contactId: string): Promise<void> {
    for (const j of this.journeys.values()) {
      if (j.ownerId === ownerId && OPEN.includes(j.status)) j.contactIds = j.contactIds.filter((id) => id !== contactId);
    }
  }

  async getInviteByCode(code: string): Promise<InviteInfo | null> {
    for (const c of this.contacts.values()) {
      if (c.inviteCode === code) return { contact: strip(c) as Contact, ownerId: c.ownerId, contactUserId: c.contactUserId ?? null };
    }
    return null;
  }

  async listPendingInvitesByEmail(email: string, excludeOwnerId: string): Promise<InviteInfo[]> {
    const want = email.toLowerCase();
    return [...this.contacts.values()]
      .filter((c) => c.email?.toLowerCase() === want && c.status === 'invited' && !c.contactUserId && c.ownerId !== excludeOwnerId)
      .map((c) => ({ contact: strip(c) as Contact, ownerId: c.ownerId, contactUserId: null }));
  }

  async answerInvite(contactId: string, userId: string, status: 'accepted' | 'declined'): Promise<Contact | null> {
    const c = this.contacts.get(contactId);
    if (!c) return null;
    c.status = status;
    c.contactUserId = userId;
    return strip(c) as Contact;
  }

  async createNotification(userId: string, n: NewNotification): Promise<void> {
    this.notifications.push({
      id: randomUUID(),
      userId,
      type: n.type,
      title: n.title,
      body: n.body,
      data: n.data ?? {},
      read: false,
      createdAt: new Date().toISOString(),
    });
  }

  async listNotifications(userId: string, limit: number): Promise<AppNotification[]> {
    return this.notifications
      .filter((n) => n.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ userId: _u, ...n }) => n);
  }

  async countUnreadNotifications(userId: string): Promise<number> {
    return this.notifications.filter((n) => n.userId === userId && !n.read).length;
  }

  async markNotificationsRead(userId: string, ids?: string[]): Promise<void> {
    for (const n of this.notifications) {
      if (n.userId === userId && (!ids || ids.includes(n.id))) n.read = true;
    }
  }

  async listContactUserIds(ownerId: string, contactIds?: string[]): Promise<string[]> {
    return [...this.contacts.values()]
      .filter((c) => c.ownerId === ownerId && c.status === 'accepted' && c.contactUserId && (!contactIds || contactIds.includes(c.id)))
      .map((c) => c.contactUserId as string);
  }

  async listRecentPlaces(ownerId: string, limit: number): Promise<RecentPlace[]> {
    return [...this.recents.values()]
      .filter((p) => p.ownerId === ownerId)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .slice(0, limit)
      .map(({ ownerId: _o, ...p }) => p);
  }

  async upsertRecentPlace(ownerId: string, p: NewRecentPlace): Promise<RecentPlace> {
    const same = [...this.recents.values()].find(
      (r) =>
        r.ownerId === ownerId &&
        ((p.googlePlaceId && r.googlePlaceId === p.googlePlaceId) || (Math.abs(r.lat - p.lat) < 1e-4 && Math.abs(r.lng - p.lng) < 1e-4)),
    );
    const now = new Date().toISOString();
    if (same) {
      same.useCount += 1;
      same.lastUsedAt = now;
      same.name = p.name;
      same.address = p.address;
      const { ownerId: _o, ...out } = same;
      return out;
    }
    const row = { ...p, id: randomUUID(), useCount: 1, lastUsedAt: now, ownerId };
    this.recents.set(row.id, row);
    const { ownerId: _o, ...out } = row;
    return out;
  }

  async clearRecentPlaces(ownerId: string): Promise<void> {
    for (const [id, p] of this.recents) if (p.ownerId === ownerId) this.recents.delete(id);
  }

  async listSavedPlaces(ownerId: string): Promise<SavedPlace[]> {
    return [...this.saved.values()]
      .filter((p) => p.ownerId === ownerId)
      .map(({ ownerId: _o, ...p }) => p);
  }

  async createSavedPlace(ownerId: string, p: NewSavedPlace): Promise<SavedPlace> {
    const row = { ...p, id: randomUUID(), createdAt: new Date().toISOString(), ownerId };
    this.saved.set(row.id, row);
    const { ownerId: _o, ...out } = row;
    return out;
  }

  async deleteSavedPlace(ownerId: string, id: string): Promise<boolean> {
    const p = this.saved.get(id);
    if (!p || p.ownerId !== ownerId) return false;
    return this.saved.delete(id);
  }

  async listTrustedBy(userId: string): Promise<{ ownerId: string; since: string }[]> {
    return [...this.contacts.values()]
      .filter((c) => c.contactUserId === userId && c.status === 'accepted')
      .map((c) => ({ ownerId: c.ownerId, since: new Date().toISOString() }));
  }

  async listFollowing(userId: string): Promise<FollowedJourney[]> {
    const mine = [...this.contacts.values()].filter((c) => c.contactUserId === userId && c.status === 'accepted');
    const out: FollowedJourney[] = [];
    for (const j of this.journeys.values()) {
      if (!OPEN.includes(j.status)) continue;
      const owner = mine.find((c) => c.ownerId === j.ownerId && j.contactIds.includes(c.id));
      if (!owner) continue;
      const last = await this.getLastLocation(j.id);
      out.push({
        journeyId: j.id,
        travellerName: this.profiles.get(j.ownerId)?.displayName ?? 'Traveller',
        travellerAvatarUrl: this.profiles.get(j.ownerId)?.avatarUrl ?? null,
        destinationName: j.destinationName,
        status: j.status,
        expectedArrival: j.expectedArrival,
        startedAt: j.startedAt,
        vehicle: j.vehicle,
        note: j.note,
        mode: j.mode,
        destinationLat: j.destinationLat,
        destinationLng: j.destinationLng,
        routePolyline: j.routePolyline,
        routeSteps: j.routeSteps,
        vehicleImageUrl: j.vehicleImageUrl,
        lastLocation: last ? { lat: last.lat, lng: last.lng, recordedAt: last.recordedAt } : null,
      });
    }
    return out;
  }

  async getOpenJourney(ownerId: string): Promise<Journey | null> {
    for (const j of this.journeys.values()) if (j.ownerId === ownerId && OPEN.includes(j.status)) return strip(j);
    return null;
  }

  async createJourney(ownerId: string, input: NewJourney): Promise<Journey> {
    const j = {
      id: randomUUID(),
      ownerId,
      ...input,
      status: 'active' as JourneyStatus,
      startedAt: new Date().toISOString(),
      arrivedAt: null,
      endedAt: null,
      lastProgressAt: input.updateIntervalMinutes ? new Date().toISOString() : null,
    };
    this.journeys.set(j.id, j);
    return strip(j);
  }

  async claimProgressUpdate(journeyId: string, previous: string | null, nowIso: string): Promise<boolean> {
    const j = this.journeys.get(journeyId);
    if (!j || j.lastProgressAt !== previous) return false;
    j.lastProgressAt = nowIso;
    return true;
  }

  async getJourney(ownerId: string, id: string): Promise<Journey | null> {
    const j = this.journeys.get(id);
    return j && j.ownerId === ownerId ? strip(j) : null;
  }

  async getJourneyByTrackToken(token: string): Promise<{ journey: Journey; ownerId: string } | null> {
    for (const j of this.journeys.values()) if (j.trackToken === token) return { journey: strip(j), ownerId: j.ownerId };
    return null;
  }

  async getAvatarUrls(userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of userIds) {
      const url = this.profiles.get(id)?.avatarUrl;
      if (url) out.set(id, url);
    }
    return out;
  }

  async getJourneyForWatch(id: string): Promise<{ journey: Journey; ownerId: string } | null> {
    const j = this.journeys.get(id);
    return j ? { journey: strip(j), ownerId: j.ownerId } : null;
  }

  async listJourneys(ownerId: string, opts: ListJourneysOptions): Promise<Journey[]> {
    return [...this.journeys.values()]
      .filter((j) => j.ownerId === ownerId)
      .filter((j) => !opts.status || opts.status.includes(j.status))
      .filter((j) => !opts.before || j.startedAt < opts.before)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, opts.limit)
      .map(strip);
  }

  async updateJourney(ownerId: string, id: string, patch: JourneyPatch, fromStatuses: JourneyStatus[]): Promise<Journey | null> {
    const j = this.journeys.get(id);
    if (!j || j.ownerId !== ownerId || !fromStatuses.includes(j.status)) return null;
    Object.assign(j, patch);
    return strip(j);
  }

  async markOverdue(nowIso: string): Promise<number> {
    let n = 0;
    for (const j of this.journeys.values()) {
      const due = new Date(j.expectedArrival).getTime() + j.graceMinutes * 60_000;
      if (j.status === 'active' && due < new Date(nowIso).getTime()) {
        j.status = 'overdue';
        n++;
      }
    }
    return n;
  }

  async addLocationPoints(journeyId: string, points: LocationPoint[]): Promise<void> {
    const list = this.points.get(journeyId) ?? [];
    list.push(...points);
    this.points.set(journeyId, list);
  }

  async getLastLocation(journeyId: string): Promise<LocationPoint | null> {
    const list = this.points.get(journeyId) ?? [];
    return [...list].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0] ?? null;
  }

  async createWatchLink(link: Omit<WatchLink, 'revokedAt'>): Promise<WatchLink> {
    const l: WatchLink = { ...link, revokedAt: null };
    this.links.set(l.token, l);
    return l;
  }

  async revokeWatchLinks(journeyId: string, ownerId: string): Promise<void> {
    for (const l of this.links.values()) {
      if (l.journeyId === journeyId && l.ownerId === ownerId) l.revokedAt = new Date().toISOString();
    }
  }

  async getWatchLink(token: string): Promise<WatchLink | null> {
    return this.links.get(token) ?? null;
  }

  async createSos(ownerId: string, input: { journeyId: string | null; lat: number | null; lng: number | null }): Promise<SosEvent> {
    const e = { id: randomUUID(), ownerId, journeyId: input.journeyId, createdAt: new Date().toISOString() };
    this.sos.push(e);
    return { id: e.id, journeyId: e.journeyId, createdAt: e.createdAt };
  }

  async setSafetyTimer(ownerId: string, endsAt: string): Promise<void> {
    this.timers.set(ownerId, endsAt);
  }

  async getSafetyTimer(ownerId: string): Promise<string | null> {
    return this.timers.get(ownerId) ?? null;
  }

  async clearSafetyTimer(ownerId: string): Promise<void> {
    this.timers.delete(ownerId);
  }

  async upsertDevice(ownerId: string, platform: 'ios' | 'android' | 'web', pushToken: string): Promise<void> {
    this.devices.set(pushToken, { ownerId, platform });
  }

  subscriptions = new Map<string, Subscription>();
  tickets = new Map<string, BillingTicket>();
  checkouts: { userId: string; email: string; planKey: PlanKey; sessionId: string | null; at: string }[] = [];
  households = new Map<string, Household>();

  async getSubscription(userId: string): Promise<Subscription | null> {
    return this.subscriptions.get(userId) ?? null;
  }

  async getSubscriptionByDodoId(id: string): Promise<Subscription | null> {
    return [...this.subscriptions.values()].find((s) => s.dodoSubscriptionId === id) ?? null;
  }

  async upsertSubscription(sub: Subscription): Promise<void> {
    this.subscriptions.set(sub.userId, { ...sub });
  }

  async createBillingTicket(t: BillingTicket): Promise<void> {
    this.tickets.set(t.tokenHash, { ...t });
  }

  async getBillingTicket(tokenHash: string): Promise<BillingTicket | null> {
    return this.tickets.get(tokenHash) ?? null;
  }

  async deleteExpiredBillingTickets(nowIso: string): Promise<void> {
    for (const [k, t] of this.tickets) if (t.expiresAt < nowIso) this.tickets.delete(k);
  }

  async recordCheckout(c: { userId: string; email: string; planKey: PlanKey; sessionId: string | null }): Promise<void> {
    this.checkouts.push({ ...c, at: new Date().toISOString() });
  }

  async findLatestCheckoutByEmail(email: string, sinceIso: string): Promise<{ userId: string; planKey: PlanKey } | null> {
    const found = this.checkouts
      .filter((c) => c.email.toLowerCase() === email.toLowerCase() && c.at >= sinceIso)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    return found ? { userId: found.userId, planKey: found.planKey } : null;
  }

  async getHousehold(ownerId: string): Promise<Household | null> {
    const h = this.households.get(ownerId);
    return h ? { ...h, contactIds: [...h.contactIds] } : null;
  }

  async saveHousehold(ownerId: string, name: string, contactIds: string[]): Promise<Household> {
    const h: Household = { name, contactIds: [...new Set(contactIds)], updatedAt: new Date().toISOString() };
    this.households.set(ownerId, h);
    return { ...h, contactIds: [...h.contactIds] };
  }

  async deleteHousehold(ownerId: string): Promise<void> {
    this.households.delete(ownerId);
  }

  async listPushTokens(ownerId: string): Promise<string[]> {
    return [...this.devices].filter(([, d]) => d.ownerId === ownerId).map(([token]) => token);
  }

  async deletePushToken(pushToken: string, ownerId?: string): Promise<void> {
    const d = this.devices.get(pushToken);
    if (d && (ownerId === undefined || d.ownerId === ownerId)) this.devices.delete(pushToken);
  }
}

function strip<T extends { ownerId?: string }>(v: T): Omit<T, 'ownerId'> {
  const { ownerId: _ownerId, ...rest } = v;
  return rest;
}
