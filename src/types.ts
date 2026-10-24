export type JourneyStatus = 'active' | 'overdue' | 'completed' | 'cancelled';
export type ContactStatus = 'invited' | 'accepted' | 'declined' | 'removed';
export type TravelMode = 'walk' | 'bike' | 'car' | 'transit' | 'train' | 'metro';

/** One leg of a planned trip, without its polyline (that is stored once for the whole trip). */
export interface PlannedStep {
  kind: string;
  label: string;
  distanceMeters: number;
  durationSeconds: number;
  from?: string;
  to?: string;
}

export interface AuthUser {
  id: string;
  email: string | null;
  /** True only when the provider confirmed the address (Google does). */
  emailVerified: boolean;
  displayName: string | null;
}

export interface Profile {
  id: string;
  displayName: string;
  phone: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: ContactStatus;
  /** Code the invited person enters to accept. Only the inviter sees it. */
  inviteCode: string | null;
  /** Profile photo of the person, once they have joined Arrivo and set one. */
  avatarUrl?: string | null;
  createdAt: string;
}

export type NotificationType =
  | 'invitation'
  | 'invite_accepted'
  | 'invite_declined'
  | 'journey_started'
  | 'journey_arrived'
  | 'journey_cancelled'
  | 'journey_delayed'
  | 'journey_progress'
  | 'attachment'
  | 'sos';

export interface NewNotification {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface RecentPlace {
  id: string;
  googlePlaceId: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
  useCount: number;
  lastUsedAt: string;
}

export type NewRecentPlace = Omit<RecentPlace, 'id' | 'useCount' | 'lastUsedAt'>;

export type SavedPlaceKind = 'home' | 'work' | 'other';

export interface SavedPlace {
  id: string;
  kind: SavedPlaceKind;
  label: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  googlePlaceId: string | null;
  createdAt: string;
}

export type NewSavedPlace = Omit<SavedPlace, 'id' | 'createdAt'>;

export interface Journey {
  id: string;
  destinationName: string;
  destinationLat: number | null;
  destinationLng: number | null;
  originName: string;
  mode: TravelMode;
  status: JourneyStatus;
  startedAt: string;
  expectedArrival: string;
  arrivedAt: string | null;
  endedAt: string | null;
  vehicle: string;
  note: string;
  lateCheckIn: boolean;
  graceMinutes: number;
  autoArrival: boolean;
  notifyOnStart: boolean;
  distanceKm: number;
  originLat: number | null;
  originLng: number | null;
  routePolyline: string | null;
  routeSteps: PlannedStep[] | null;
  vehicleImageUrl: string | null;
  /** Private key for the background service. Only the owner ever receives it. */
  trackToken: string | null;
  /** Minutes between "on the way" updates to the contacts, or null for none. */
  updateIntervalMinutes: number | null;
  /** When the last update went out (the start time before the first one). */
  lastProgressAt: string | null;
  contactIds: string[];
}

/** The traveller picks any interval between these (the app also offers presets). */
export const MIN_PROGRESS_MINUTES = 10;
export const MAX_PROGRESS_MINUTES = 12 * 60;

export interface NewJourney {
  destinationName: string;
  destinationLat: number | null;
  destinationLng: number | null;
  originName: string;
  mode: TravelMode;
  expectedArrival: string;
  vehicle: string;
  note: string;
  lateCheckIn: boolean;
  graceMinutes: number;
  autoArrival: boolean;
  notifyOnStart: boolean;
  distanceKm: number;
  originLat: number | null;
  originLng: number | null;
  routePolyline: string | null;
  routeSteps: PlannedStep[] | null;
  vehicleImageUrl: string | null;
  trackToken: string | null;
  updateIntervalMinutes: number | null;
  contactIds: string[];
}

export interface LocationPoint {
  lat: number;
  lng: number;
  accuracy?: number | null;
  speed?: number | null;
  recordedAt: string;
}

export interface WatchLink {
  token: string;
  journeyId: string;
  ownerId: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface SosEvent {
  id: string;
  journeyId: string | null;
  createdAt: string;
}

/** A journey someone shared with you (you are one of their accepted contacts). */
export interface FollowedJourney {
  journeyId: string;
  travellerName: string;
  travellerAvatarUrl?: string | null;
  destinationName: string;
  status: JourneyStatus;
  expectedArrival: string;
  startedAt: string;
  vehicle: string;
  note: string;
  mode: TravelMode;
  destinationLat: number | null;
  destinationLng: number | null;
  routePolyline: string | null;
  routeSteps: PlannedStep[] | null;
  vehicleImageUrl: string | null;
  lastLocation: { lat: number; lng: number; recordedAt: string } | null;
}

export interface InviteInfo {
  contact: Contact;
  ownerId: string;
  /** Set once someone accepted or declined. */
  contactUserId: string | null;
}
