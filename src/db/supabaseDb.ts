import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { AppError } from '../lib/errors.js';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function check<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new AppError(500, 'db_error', `${what} failed`, { reason: res.error.message, code: res.error.code });
  return res.data as T;
}

const toProfile = (r: Row): Profile => ({
  id: r.id,
  displayName: r.display_name ?? '',
  phone: r.phone ?? null,
  avatarUrl: r.avatar_url ?? null,
  createdAt: r.created_at,
});

const toSaved = (r: Row): SavedPlace => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  name: r.name,
  address: r.address ?? '',
  lat: r.lat,
  lng: r.lng,
  googlePlaceId: r.google_place_id ?? null,
  createdAt: r.created_at,
});

const toNotification = (r: Row): AppNotification => ({
  id: r.id,
  type: r.type,
  title: r.title,
  body: r.body ?? '',
  data: r.data ?? {},
  read: r.read_at != null,
  createdAt: r.created_at,
});

const toRecent = (r: Row): RecentPlace => ({
  id: r.id,
  googlePlaceId: r.google_place_id ?? null,
  name: r.name,
  address: r.address ?? '',
  lat: r.lat,
  lng: r.lng,
  useCount: r.use_count,
  lastUsedAt: r.last_used_at,
});

const toSubscription = (r: Row): Subscription => ({
  userId: r.user_id,
  status: r.status,
  intervalMonths: r.interval_months ?? null,
  dodoSubscriptionId: r.dodo_subscription_id ?? null,
  dodoCustomerId: r.dodo_customer_id ?? null,
  currentPeriodEnd: r.current_period_end ?? null,
  lastEventAt: r.last_event_at,
});

const toContact = (r: Row): Contact => ({
  id: r.id,
  name: r.name,
  phone: r.phone ?? null,
  email: r.email ?? null,
  status: r.status,
  inviteCode: r.invite_code ?? null,
  createdAt: r.created_at,
});

const toJourney = (r: Row, contactIds: string[]): Journey => ({
  id: r.id,
  destinationName: r.destination_name,
  destinationLat: r.destination_lat ?? null,
  destinationLng: r.destination_lng ?? null,
  originName: r.origin_name ?? '',
  mode: r.mode,
  status: r.status,
  startedAt: r.started_at,
  expectedArrival: r.expected_arrival,
  arrivedAt: r.arrived_at ?? null,
  endedAt: r.ended_at ?? null,
  vehicle: r.vehicle ?? '',
  note: r.note ?? '',
  lateCheckIn: r.late_check_in,
  graceMinutes: r.grace_minutes,
  autoArrival: r.auto_arrival,
  notifyOnStart: r.notify_on_start,
  distanceKm: Number(r.distance_km ?? 0),
  originLat: r.origin_lat ?? null,
  originLng: r.origin_lng ?? null,
  routePolyline: r.route_polyline ?? null,
  routeSteps: r.route_steps ?? null,
  vehicleImageUrl: r.vehicle_image_url ?? null,
  trackToken: r.track_token ?? null,
  updateIntervalMinutes: r.update_interval_minutes ?? null,
  lastProgressAt: r.last_progress_at ?? null,
  contactIds,
});

/**
 * Supabase implementation. Uses the service role key (server only), so every
 * query is explicitly scoped to the owner. Row level security in the migration
 * is defence in depth for anything that talks to the database directly.
 */
export class SupabaseDb implements Db {
  private readonly sb: SupabaseClient;
  private readonly cache = new Map<string, { user: AuthUser; at: number }>();

  constructor(url: string, serviceRoleKey: string) {
    this.sb = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async authenticate(token: string): Promise<AuthUser | null> {
    const hit = this.cache.get(token);
    if (hit && Date.now() - hit.at < 30_000) return hit.user;
    const { data, error } = await this.sb.auth.getUser(token);
    if (error || !data.user) return null;
    const meta = (data.user.user_metadata ?? {}) as Row;
    const user: AuthUser = {
      id: data.user.id,
      email: data.user.email ?? null,
      emailVerified: !!data.user.email_confirmed_at,
      displayName: meta.full_name ?? meta.name ?? null,
    };
    this.cache.set(token, { user, at: Date.now() });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
    return user;
  }

  async upsertProfile(user: AuthUser): Promise<Profile> {
    const existing = await this.sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    const row = check(existing, 'read profile');
    if (row) return toProfile(row);
    const created = await this.sb
      .from('profiles')
      .insert({ id: user.id, display_name: user.displayName ?? '' })
      .select('*')
      .single();
    return toProfile(check(created, 'create profile'));
  }

  async updateProfile(id: string, patch: { displayName?: string; phone?: string | null; avatarUrl?: string | null }): Promise<Profile> {
    const update: Row = { updated_at: new Date().toISOString() };
    if (patch.displayName !== undefined) update.display_name = patch.displayName;
    if (patch.phone !== undefined) update.phone = patch.phone;
    if (patch.avatarUrl !== undefined) update.avatar_url = patch.avatarUrl;
    const res = await this.sb.from('profiles').update(update).eq('id', id).select('*').single();
    return toProfile(check(res, 'update profile'));
  }

  async getDisplayName(id: string): Promise<string> {
    const res = await this.sb.from('profiles').select('display_name').eq('id', id).maybeSingle();
    return (check(res, 'read profile') as Row | null)?.display_name ?? '';
  }

  async requestAccountDeletion(id: string): Promise<void> {
    check(
      await this.sb.from('profiles').update({ deletion_requested_at: new Date().toISOString() }).eq('id', id),
      'request deletion',
    );
  }

  async listContacts(ownerId: string): Promise<Contact[]> {
    const res = await this.sb
      .from('contacts')
      .select('*')
      .eq('owner_id', ownerId)
      .neq('status', 'removed')
      .order('created_at', { ascending: true });
    const rows = check(res, 'list contacts') as Row[];
    // Show each contact's own profile photo once they have joined.
    const avatars = await this.getAvatarUrls(rows.map((r) => r.contact_user_id).filter(Boolean));
    return rows.map((r) => ({ ...toContact(r), avatarUrl: avatars.get(r.contact_user_id) ?? null }));
  }

  async createContact(
    ownerId: string,
    input: { name: string; phone: string | null; email: string | null; inviteCode: string },
  ): Promise<Contact> {
    const res = await this.sb
      .from('contacts')
      .insert({ owner_id: ownerId, name: input.name, phone: input.phone, email: input.email, invite_code: input.inviteCode })
      .select('*')
      .single();
    if (res.error?.code === '23505') throw new AppError(409, 'conflict', 'You already added this contact');
    return toContact(check(res, 'create contact'));
  }

  async getContact(ownerId: string, id: string): Promise<Contact | null> {
    const res = await this.sb.from('contacts').select('*').eq('owner_id', ownerId).eq('id', id).maybeSingle();
    const row = check(res, 'read contact') as Row | null;
    return row ? toContact(row) : null;
  }

  async updateContactStatus(ownerId: string, id: string, status: ContactStatus): Promise<Contact | null> {
    const res = await this.sb
      .from('contacts')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('owner_id', ownerId)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    const row = check(res, 'update contact') as Row | null;
    return row ? toContact(row) : null;
  }

  async removeContactFromOpenJourneys(ownerId: string, contactId: string): Promise<void> {
    const open = check(
      await this.sb.from('journeys').select('id').eq('owner_id', ownerId).in('status', OPEN),
      'read open journeys',
    ) as Row[];
    if (open.length === 0) return;
    check(
      await this.sb.from('journey_contacts').delete().eq('contact_id', contactId).in('journey_id', open.map((o) => o.id)),
      'revoke contact access',
    );
  }

  async getInviteByCode(code: string): Promise<InviteInfo | null> {
    const res = await this.sb.from('contacts').select('*').eq('invite_code', code).maybeSingle();
    const row = check(res, 'read invitation') as Row | null;
    return row ? { contact: toContact(row), ownerId: row.owner_id, contactUserId: row.contact_user_id ?? null } : null;
  }

  async listPendingInvitesByEmail(email: string, excludeOwnerId: string): Promise<InviteInfo[]> {
    const res = await this.sb
      .from('contacts')
      .select('*')
      .eq('email', email.toLowerCase())
      .eq('status', 'invited')
      .is('contact_user_id', null)
      .neq('owner_id', excludeOwnerId);
    const rows = check(res, 'read pending invitations') as Row[];
    return rows.map((row) => ({ contact: toContact(row), ownerId: row.owner_id, contactUserId: null }));
  }

  async answerInvite(contactId: string, userId: string, status: 'accepted' | 'declined'): Promise<Contact | null> {
    const res = await this.sb
      .from('contacts')
      .update({ status, contact_user_id: userId, updated_at: new Date().toISOString() })
      .eq('id', contactId)
      .select('*')
      .maybeSingle();
    const row = check(res, 'answer invitation') as Row | null;
    return row ? toContact(row) : null;
  }

  async createNotification(userId: string, n: NewNotification): Promise<void> {
    check(
      await this.sb.from('notifications').insert({ user_id: userId, type: n.type, title: n.title, body: n.body, data: n.data ?? {} }),
      'save notification',
    );
  }

  async listNotifications(userId: string, limit: number): Promise<AppNotification[]> {
    const rows = check(
      await this.sb.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit),
      'read notifications',
    ) as Row[];
    return rows.map(toNotification);
  }

  async countUnreadNotifications(userId: string): Promise<number> {
    const res = await this.sb.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('read_at', null);
    if (res.error) throw new AppError(500, 'db_error', 'count notifications failed', { reason: res.error.message });
    return res.count ?? 0;
  }

  async markNotificationsRead(userId: string, ids?: string[]): Promise<void> {
    let q = this.sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', userId).is('read_at', null);
    if (ids) q = q.in('id', ids);
    check(await q, 'mark notifications read');
  }

  async listContactUserIds(ownerId: string, contactIds?: string[]): Promise<string[]> {
    let q = this.sb.from('contacts').select('contact_user_id').eq('owner_id', ownerId).eq('status', 'accepted').not('contact_user_id', 'is', null);
    if (contactIds) q = q.in('id', contactIds);
    const rows = check(await q, 'read followers') as Row[];
    return rows.map((r) => r.contact_user_id as string);
  }

  async listRecentPlaces(ownerId: string, limit: number): Promise<RecentPlace[]> {
    const rows = check(
      await this.sb.from('recent_places').select('*').eq('owner_id', ownerId).order('last_used_at', { ascending: false }).limit(limit),
      'read recent places',
    ) as Row[];
    return rows.map(toRecent);
  }

  async upsertRecentPlace(ownerId: string, p: NewRecentPlace): Promise<RecentPlace> {
    // Same Google place, or the same spot (within about 10 m): just bump it.
    let existing: Row | null = null;
    if (p.googlePlaceId) {
      existing = check(
        await this.sb.from('recent_places').select('*').eq('owner_id', ownerId).eq('google_place_id', p.googlePlaceId).maybeSingle(),
        'read recent place',
      ) as Row | null;
    }
    if (!existing) {
      const near = check(
        await this.sb
          .from('recent_places')
          .select('*')
          .eq('owner_id', ownerId)
          .gte('lat', p.lat - 1e-4)
          .lte('lat', p.lat + 1e-4)
          .gte('lng', p.lng - 1e-4)
          .lte('lng', p.lng + 1e-4)
          .limit(1),
        'read recent place',
      ) as Row[];
      existing = near[0] ?? null;
    }
    const now = new Date().toISOString();
    if (existing) {
      const res = await this.sb
        .from('recent_places')
        .update({ use_count: existing.use_count + 1, last_used_at: now, name: p.name, address: p.address })
        .eq('id', existing.id)
        .select('*')
        .single();
      return toRecent(check(res, 'update recent place') as Row);
    }
    const res = await this.sb
      .from('recent_places')
      .insert({ owner_id: ownerId, google_place_id: p.googlePlaceId, name: p.name, address: p.address, lat: p.lat, lng: p.lng })
      .select('*')
      .single();
    const row = toRecent(check(res, 'save recent place') as Row);
    // Keep the list small: drop everything beyond the newest 50.
    const old = check(
      await this.sb.from('recent_places').select('id').eq('owner_id', ownerId).order('last_used_at', { ascending: false }).range(50, 200),
      'trim recent places',
    ) as Row[];
    if (old.length) await this.sb.from('recent_places').delete().in('id', old.map((o) => o.id));
    return row;
  }

  async clearRecentPlaces(ownerId: string): Promise<void> {
    check(await this.sb.from('recent_places').delete().eq('owner_id', ownerId), 'clear recent places');
  }

  async listSavedPlaces(ownerId: string): Promise<SavedPlace[]> {
    const rows = check(
      await this.sb.from('saved_places').select('*').eq('owner_id', ownerId).order('created_at', { ascending: true }),
      'read saved places',
    ) as Row[];
    return rows.map(toSaved);
  }

  async createSavedPlace(ownerId: string, p: NewSavedPlace): Promise<SavedPlace> {
    const res = await this.sb
      .from('saved_places')
      .insert({
        owner_id: ownerId,
        kind: p.kind,
        label: p.label,
        name: p.name,
        address: p.address,
        lat: p.lat,
        lng: p.lng,
        google_place_id: p.googlePlaceId,
      })
      .select('*')
      .single();
    return toSaved(check(res, 'save place') as Row);
  }

  async deleteSavedPlace(ownerId: string, id: string): Promise<boolean> {
    const res = await this.sb.from('saved_places').delete().eq('owner_id', ownerId).eq('id', id).select('id');
    return (check(res, 'delete saved place') as Row[]).length > 0;
  }

  async listTrustedBy(userId: string): Promise<{ ownerId: string; since: string }[]> {
    const rows = check(
      await this.sb.from('contacts').select('owner_id, updated_at').eq('contact_user_id', userId).eq('status', 'accepted'),
      'read trusted-by',
    ) as Row[];
    return rows.map((r) => ({ ownerId: r.owner_id, since: r.updated_at }));
  }

  async listFollowing(userId: string): Promise<FollowedJourney[]> {
    const mine = check(
      await this.sb.from('contacts').select('id, owner_id').eq('contact_user_id', userId).eq('status', 'accepted'),
      'read followed contacts',
    ) as Row[];
    if (mine.length === 0) return [];
    const links = check(
      await this.sb.from('journey_contacts').select('journey_id').in('contact_id', mine.map((m) => m.id)),
      'read followed journeys',
    ) as Row[];
    if (links.length === 0) return [];
    const journeys = check(
      await this.sb.from('journeys').select('*').in('id', links.map((l) => l.journey_id)).in('status', OPEN),
      'read followed journeys',
    ) as Row[];
    const out: FollowedJourney[] = [];
    for (const j of journeys) {
      const name = await this.getDisplayName(j.owner_id);
      const last = await this.getLastLocation(j.id);
      out.push({
        journeyId: j.id,
        travellerName: name || 'Traveller',
        travellerAvatarUrl: (await this.getAvatarUrls([j.owner_id])).get(j.owner_id) ?? null,
        destinationName: j.destination_name,
        status: j.status,
        expectedArrival: j.expected_arrival,
        startedAt: j.started_at,
        vehicle: j.vehicle ?? '',
        note: j.note ?? '',
        mode: j.mode,
        destinationLat: j.destination_lat ?? null,
        destinationLng: j.destination_lng ?? null,
        routePolyline: j.route_polyline ?? null,
        routeSteps: j.route_steps ?? null,
        vehicleImageUrl: j.vehicle_image_url ?? null,
        lastLocation: last ? { lat: last.lat, lng: last.lng, recordedAt: last.recordedAt } : null,
      });
    }
    return out;
  }

  private async contactIdsFor(journeyIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (journeyIds.length === 0) return map;
    const rows = check(
      await this.sb.from('journey_contacts').select('journey_id, contact_id').in('journey_id', journeyIds),
      'read journey contacts',
    ) as Row[];
    for (const r of rows) map.set(r.journey_id, [...(map.get(r.journey_id) ?? []), r.contact_id]);
    return map;
  }

  private async hydrate(rows: Row[]): Promise<Journey[]> {
    const ids = await this.contactIdsFor(rows.map((r) => r.id));
    return rows.map((r) => toJourney(r, ids.get(r.id) ?? []));
  }

  async getOpenJourney(ownerId: string): Promise<Journey | null> {
    const res = await this.sb.from('journeys').select('*').eq('owner_id', ownerId).in('status', OPEN).limit(1);
    const rows = check(res, 'read open journey') as Row[];
    return (await this.hydrate(rows))[0] ?? null;
  }

  async createJourney(ownerId: string, input: NewJourney): Promise<Journey> {
    const ins = await this.sb
      .from('journeys')
      .insert({
        owner_id: ownerId,
        destination_name: input.destinationName,
        destination_lat: input.destinationLat,
        destination_lng: input.destinationLng,
        origin_name: input.originName,
        mode: input.mode,
        expected_arrival: input.expectedArrival,
        vehicle: input.vehicle,
        note: input.note,
        late_check_in: input.lateCheckIn,
        grace_minutes: input.graceMinutes,
        auto_arrival: input.autoArrival,
        notify_on_start: input.notifyOnStart,
        distance_km: input.distanceKm,
        origin_lat: input.originLat,
        origin_lng: input.originLng,
        route_polyline: input.routePolyline,
        route_steps: input.routeSteps,
        vehicle_image_url: input.vehicleImageUrl,
        track_token: input.trackToken,
        update_interval_minutes: input.updateIntervalMinutes,
        // The first update comes one interval after the start.
        last_progress_at: input.updateIntervalMinutes ? new Date().toISOString() : null,
      })
      .select('*')
      .single();
    // The partial unique index allows only one open journey per owner.
    if (ins.error?.code === '23505') throw new AppError(409, 'conflict', 'You already have a journey in progress');
    const row = check(ins, 'create journey') as Row;

    const links = input.contactIds.map((cid) => ({ journey_id: row.id, contact_id: cid }));
    const lk = await this.sb.from('journey_contacts').insert(links);
    if (lk.error) {
      await this.sb.from('journeys').delete().eq('id', row.id);
      throw new AppError(500, 'db_error', 'create journey failed', { reason: lk.error.message });
    }
    return toJourney(row, input.contactIds);
  }

  async claimProgressUpdate(journeyId: string, previous: string | null, nowIso: string): Promise<boolean> {
    // Compare-and-swap on the previous value: only one of two simultaneous uploads wins.
    let q = this.sb.from('journeys').update({ last_progress_at: nowIso }).eq('id', journeyId);
    q = previous === null ? q.is('last_progress_at', null) : q.eq('last_progress_at', previous);
    const rows = check(await q.select('id'), 'claim progress update') as Row[];
    return rows.length === 1;
  }

  async getJourney(ownerId: string, id: string): Promise<Journey | null> {
    const res = await this.sb.from('journeys').select('*').eq('owner_id', ownerId).eq('id', id).maybeSingle();
    const row = check(res, 'read journey') as Row | null;
    return row ? (await this.hydrate([row]))[0]! : null;
  }

  async getJourneyByTrackToken(token: string): Promise<{ journey: Journey; ownerId: string } | null> {
    const res = await this.sb.from('journeys').select('*').eq('track_token', token).maybeSingle();
    const row = check(res, 'read journey') as Row | null;
    return row ? { journey: (await this.hydrate([row]))[0]!, ownerId: row.owner_id } : null;
  }

  async getAvatarUrls(userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return out;
    const rows = check(await this.sb.from('profiles').select('id, avatar_url').in('id', ids), 'read photos') as Row[];
    for (const r of rows) if (r.avatar_url) out.set(r.id, r.avatar_url);
    return out;
  }

  async getJourneyForWatch(id: string): Promise<{ journey: Journey; ownerId: string } | null> {
    const res = await this.sb.from('journeys').select('*').eq('id', id).maybeSingle();
    const row = check(res, 'read journey') as Row | null;
    if (!row) return null;
    return { journey: (await this.hydrate([row]))[0]!, ownerId: row.owner_id };
  }

  async listJourneys(ownerId: string, opts: ListJourneysOptions): Promise<Journey[]> {
    let q = this.sb.from('journeys').select('*').eq('owner_id', ownerId);
    if (opts.status) q = q.in('status', opts.status);
    if (opts.before) q = q.lt('started_at', opts.before);
    const res = await q.order('started_at', { ascending: false }).limit(opts.limit);
    return this.hydrate(check(res, 'list journeys') as Row[]);
  }

  async updateJourney(ownerId: string, id: string, patch: JourneyPatch, fromStatuses: JourneyStatus[]): Promise<Journey | null> {
    const update: Row = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.expectedArrival !== undefined) update.expected_arrival = patch.expectedArrival;
    if (patch.arrivedAt !== undefined) update.arrived_at = patch.arrivedAt;
    if (patch.endedAt !== undefined) update.ended_at = patch.endedAt;
    // The status filter makes this a compare-and-set, so repeated or racing
    // requests cannot move a journey twice (FR-JRN-03).
    const res = await this.sb
      .from('journeys')
      .update(update)
      .eq('owner_id', ownerId)
      .eq('id', id)
      .in('status', fromStatuses)
      .select('*')
      .maybeSingle();
    const row = check(res, 'update journey') as Row | null;
    return row ? (await this.hydrate([row]))[0]! : null;
  }

  async markOverdue(nowIso: string): Promise<number> {
    const res = await this.sb.rpc('mark_overdue_journeys', { now_ts: nowIso });
    return Number(check(res, 'mark overdue') ?? 0);
  }

  async addLocationPoints(journeyId: string, points: LocationPoint[]): Promise<void> {
    const rows = points.map((p) => ({
      journey_id: journeyId,
      lat: p.lat,
      lng: p.lng,
      accuracy: p.accuracy ?? null,
      speed: p.speed ?? null,
      recorded_at: p.recordedAt,
    }));
    check(await this.sb.from('location_points').insert(rows), 'save location');
  }

  async getLastLocation(journeyId: string): Promise<LocationPoint | null> {
    const res = await this.sb
      .from('location_points')
      .select('lat, lng, accuracy, speed, recorded_at')
      .eq('journey_id', journeyId)
      .order('recorded_at', { ascending: false })
      .limit(1);
    const r = (check(res, 'read location') as Row[])[0];
    return r ? { lat: r.lat, lng: r.lng, accuracy: r.accuracy, speed: r.speed, recordedAt: r.recorded_at } : null;
  }

  async createWatchLink(link: Omit<WatchLink, 'revokedAt'>): Promise<WatchLink> {
    const res = await this.sb
      .from('watch_links')
      .insert({ token: link.token, journey_id: link.journeyId, owner_id: link.ownerId, expires_at: link.expiresAt })
      .select('*')
      .single();
    return this.toLink(check(res, 'create watch link') as Row);
  }

  async revokeWatchLinks(journeyId: string, ownerId: string): Promise<void> {
    check(
      await this.sb
        .from('watch_links')
        .update({ revoked_at: new Date().toISOString() })
        .eq('journey_id', journeyId)
        .eq('owner_id', ownerId)
        .is('revoked_at', null),
      'revoke watch links',
    );
  }

  async getWatchLink(token: string): Promise<WatchLink | null> {
    const res = await this.sb.from('watch_links').select('*').eq('token', token).maybeSingle();
    const row = check(res, 'read watch link') as Row | null;
    return row ? this.toLink(row) : null;
  }

  private toLink(r: Row): WatchLink {
    return { token: r.token, journeyId: r.journey_id, ownerId: r.owner_id, expiresAt: r.expires_at, revokedAt: r.revoked_at ?? null };
  }

  async createSos(ownerId: string, input: { journeyId: string | null; lat: number | null; lng: number | null }): Promise<SosEvent> {
    const res = await this.sb
      .from('sos_events')
      .insert({ owner_id: ownerId, journey_id: input.journeyId, lat: input.lat, lng: input.lng })
      .select('id, journey_id, created_at')
      .single();
    const r = check(res, 'record sos') as Row;
    return { id: r.id, journeyId: r.journey_id ?? null, createdAt: r.created_at };
  }

  async setSafetyTimer(ownerId: string, endsAt: string): Promise<void> {
    check(await this.sb.from('safety_timers').upsert({ owner_id: ownerId, ends_at: endsAt }), 'set safety timer');
  }

  async getSafetyTimer(ownerId: string): Promise<string | null> {
    const res = await this.sb.from('safety_timers').select('ends_at').eq('owner_id', ownerId).maybeSingle();
    return (check(res, 'read safety timer') as Row | null)?.ends_at ?? null;
  }

  async clearSafetyTimer(ownerId: string): Promise<void> {
    check(await this.sb.from('safety_timers').delete().eq('owner_id', ownerId), 'clear safety timer');
  }

  async upsertDevice(ownerId: string, platform: 'ios' | 'android' | 'web', pushToken: string): Promise<void> {
    check(
      await this.sb
        .from('devices')
        .upsert({ owner_id: ownerId, platform, push_token: pushToken, updated_at: new Date().toISOString() }, { onConflict: 'push_token' }),
      'save device',
    );
  }

  async getSubscription(userId: string): Promise<Subscription | null> {
    const res = await this.sb.from('subscriptions').select('*').eq('user_id', userId).maybeSingle();
    const row = check(res, 'read subscription') as Row | null;
    return row ? toSubscription(row) : null;
  }

  async getSubscriptionByDodoId(id: string): Promise<Subscription | null> {
    const res = await this.sb.from('subscriptions').select('*').eq('dodo_subscription_id', id).maybeSingle();
    const row = check(res, 'read subscription') as Row | null;
    return row ? toSubscription(row) : null;
  }

  async upsertSubscription(s: Subscription): Promise<void> {
    check(
      await this.sb.from('subscriptions').upsert(
        {
          user_id: s.userId,
          status: s.status,
          interval_months: s.intervalMonths,
          dodo_subscription_id: s.dodoSubscriptionId,
          dodo_customer_id: s.dodoCustomerId,
          current_period_end: s.currentPeriodEnd,
          last_event_at: s.lastEventAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      ),
      'save subscription',
    );
  }

  async createBillingTicket(t: BillingTicket): Promise<void> {
    check(
      await this.sb.from('billing_tickets').insert({
        token_hash: t.tokenHash,
        user_id: t.userId,
        email: t.email,
        plan_key: t.planKey,
        expires_at: t.expiresAt,
      }),
      'create billing ticket',
    );
  }

  async getBillingTicket(tokenHash: string): Promise<BillingTicket | null> {
    const res = await this.sb.from('billing_tickets').select('*').eq('token_hash', tokenHash).maybeSingle();
    const r = check(res, 'read billing ticket') as Row | null;
    return r
      ? { tokenHash: r.token_hash, userId: r.user_id, email: r.email, planKey: r.plan_key, expiresAt: r.expires_at }
      : null;
  }

  async deleteExpiredBillingTickets(nowIso: string): Promise<void> {
    check(await this.sb.from('billing_tickets').delete().lt('expires_at', nowIso), 'clean billing tickets');
  }

  async recordCheckout(c: { userId: string; email: string; planKey: PlanKey; sessionId: string | null }): Promise<void> {
    check(
      await this.sb
        .from('billing_checkouts')
        .insert({ user_id: c.userId, email: c.email, plan_key: c.planKey, dodo_session_id: c.sessionId }),
      'record checkout',
    );
  }

  async findLatestCheckoutByEmail(email: string, sinceIso: string): Promise<{ userId: string; planKey: PlanKey } | null> {
    const res = await this.sb
      .from('billing_checkouts')
      .select('user_id, plan_key')
      .ilike('email', email)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1);
    const row = (check(res, 'find checkout') as Row[])[0];
    return row ? { userId: row.user_id, planKey: row.plan_key } : null;
  }

  async getHousehold(ownerId: string): Promise<Household | null> {
    const res = await this.sb.from('households').select('*').eq('owner_id', ownerId).maybeSingle();
    const row = check(res, 'read household') as Row | null;
    if (!row) return null;
    const members = check(
      await this.sb.from('household_members').select('contact_id').eq('owner_id', ownerId),
      'read household members',
    ) as Row[];
    return { name: row.name, contactIds: members.map((m) => m.contact_id as string), updatedAt: row.updated_at };
  }

  async saveHousehold(ownerId: string, name: string, contactIds: string[]): Promise<Household> {
    const now = new Date().toISOString();
    check(
      await this.sb.from('households').upsert({ owner_id: ownerId, name, updated_at: now }, { onConflict: 'owner_id' }),
      'save household',
    );
    check(await this.sb.from('household_members').delete().eq('owner_id', ownerId), 'clear household members');
    const unique = [...new Set(contactIds)];
    if (unique.length > 0) {
      check(
        await this.sb.from('household_members').insert(unique.map((id) => ({ owner_id: ownerId, contact_id: id }))),
        'save household members',
      );
    }
    return { name, contactIds: unique, updatedAt: now };
  }

  async deleteHousehold(ownerId: string): Promise<void> {
    check(await this.sb.from('households').delete().eq('owner_id', ownerId), 'delete household');
  }

  async listPushTokens(ownerId: string): Promise<string[]> {
    const res = await this.sb.from('devices').select('push_token').eq('owner_id', ownerId);
    return (check(res, 'list devices') as Row[]).map((r) => r.push_token as string);
  }

  async deletePushToken(pushToken: string, ownerId?: string): Promise<void> {
    let q = this.sb.from('devices').delete().eq('push_token', pushToken);
    if (ownerId) q = q.eq('owner_id', ownerId);
    check(await q, 'remove device');
  }
}
