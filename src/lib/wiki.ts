import { fallbackLanguageFor, LANGUAGE_LABELS, localLanguageFor } from '../domain/localLanguage.js';
import { AppError } from './errors.js';
import { errorText, logError } from './log.js';
import { haversine, type LatLng } from './polyline.js';

/**
 * Destination information from Wikipedia, Wikidata and Wikimedia Commons. All
 * three are free and need no key. Every lookup has a short timeout and the
 * independent ones run together, so one slow service costs a few seconds at
 * worst and never loses the whole answer.
 */

export interface Photo {
  /** Display size (about 800 px wide). */
  url: string;
  /** Small size for grids. */
  thumb: string;
  title: string;
  /** Who took it, as plain text. Commons photos must be credited. */
  credit: string;
  license: string;
  /** The Commons page, for the full credit and licence. */
  pageUrl: string;
}

export interface PlaceCard {
  title: string;
  description?: string;
  thumbnail?: string;
  /** Straight-line distance from the destination. */
  km: number;
}

export interface Facts {
  population?: string;
  elevation?: string;
  area?: string;
  postalCode?: string;
  website?: string;
  country?: string;
  district?: string;
}

export interface DestinationInfo {
  title: string;
  description?: string;
  /** The lead of the article: what and where this place is. */
  summary: string;
  /** The article's History section, or its origin/etymology section. Absent when it has none. */
  history?: string;
  facts: Facts;
  url?: string;
  image?: string;
  /** The same article in the language spoken at the destination, when that Wikipedia has one. */
  local?: { lang: string; label: string; title: string; extract: string };
  /** Sights and landmarks within 10 km, best first. Photos come from [WikiProvider.photos], which is slower. */
  places: PlaceCard[];
}

export interface PlaceDetail {
  title: string;
  description?: string;
  extract: string;
  url?: string;
  image?: string;
  /** Where it is, so the app can ask for photos taken there. */
  coordinates?: LatLng;
}

export interface DestinationQuery {
  lat: number;
  lng: number;
  /** What the person picked, e.g. "Hinjewadi Phase 1". */
  name: string;
  city?: string;
  /** State or region and country as written in the address, to pick the local language. */
  region?: string;
  country?: string;
}

export interface WikiProvider {
  readonly enabled: boolean;
  /** Null when no article matches the place. [complete] is false when part of the lookup failed. */
  destination(q: DestinationQuery): Promise<{ value: DestinationInfo; complete: boolean } | null>;
  place(title: string): Promise<{ value: PlaceDetail; complete: boolean } | null>;
  /** Freely licensed photos taken within [radiusM] of a point. Slower than the text, so it is its own call. */
  photos(at: LatLng, radiusM: number): Promise<{ value: Photo[]; complete: boolean }>;
}

const unavailable = async (): Promise<never> => {
  throw new AppError(503, 'info_unavailable', 'Destination information is not available right now.');
};

export const noWiki: WikiProvider = { enabled: false, destination: unavailable, place: unavailable, photos: unavailable };

// ---------- pure helpers (tested directly) ----------

/** Cuts at the end of a sentence near [max], so the text never stops mid-word. */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/** Plain-text article split into its lead and its top-level sections (sub-headings stay inside). */
export function splitSections(text: string): { lead: string; sections: Record<string, string> } {
  const heading = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;
  const sections: Record<string, string> = {};
  let lead = text;
  let current: string | null = null;
  let last = 0;
  const add = (name: string, body: string) => {
    sections[name] = sections[name] ? `${sections[name]}\n${body}` : body;
  };

  for (const m of text.matchAll(heading)) {
    const body = text.slice(last, m.index).trim();
    if (current === null) lead = body;
    else if (body) add(current, body);

    const level = m[1]!.length;
    const name = m[2]!;
    if (level === 2) {
      current = name;
      sections[current] ??= '';
    } else if (current !== null) {
      add(current, `${name}:`);
    }
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (current !== null && tail) add(current, tail);

  for (const [k, v] of Object.entries(sections)) if (!v.trim()) delete sections[k];
  return { lead: lead.trim(), sections };
}

/** The history of a place: the History section, else an origin or etymology section. */
export function pickHistory(sections: Record<string, string>): string | undefined {
  const names = Object.keys(sections);
  const key = names.find((n) => /^history$/i.test(n)) ?? names.find((n) => /history|origin|etymology|name/i.test(n));
  return key ? sections[key] : undefined;
}

const SIGHT = /\b(temple|gurdwara|gurudwara|mosque|masjid|church|cathedral|shrine|monastery|fort|palace|tomb|mausoleum|memorial|monument|museum|gallery|garden|park|sanctuary|lake|waterfall|beach|hill|cave|dam|bridge|ghat|haveli|stupa|ruins?|heritage|zoo|market|bazaar|landmark|tourist|national park|statue|observatory|temple complex)\b/i;
const DULL = /\b(railway station|metro station|bus station|school|college|university|hospital|block|tehsil|taluk|mandal|village|census town|constituency|police|post office|company|power (station|project)|thermal|airport|stadium|highway|road|junction|ward|district|locality|suburb|neighbou?rhood|city|metropolis|town|metropolitan|municipal|capital)\b/i;

export interface Candidate {
  title: string;
  description?: string;
  thumbnail?: string;
  lat: number;
  lng: number;
}

/** Never a place to visit, even when the name says "memorial" or "park" (a memorial hospital, a school park). */
const INSTITUTION = /\b(hospital|clinic|school|college|university|institute|bank|company|police|post office|railway station|metro station|bus station|sports complex|stadium)\b/i;

/** Articles about things that happened, not places you can visit. */
const EVENT = /\b(massacre|disaster|lynchings?|riots?|attacks?|bombings?|accident|operation|battle|siege|protests?|incident|killings?|elections?|movement|agitation|strike)\b|\b(1[5-9]|20)\d\d\b/i;

/**
 * Places worth a visit near [origin], best first. A sight (temple, fort, museum, park...)
 * always beats anything else; other places only fill the list when they have a photo and
 * are not an event, a town or an institution. The pin's own article is never listed.
 */
export function rankPlaces(items: Candidate[], origin: LatLng, selfTitle: string, limit = 12): PlaceCard[] {
  const scored = items
    .filter(
      (c) =>
        c.title.toLowerCase() !== selfTitle.toLowerCase() &&
        !/^list of /i.test(c.title) &&
        !EVENT.test(c.title) &&
        !INSTITUTION.test(`${c.title} ${c.description ?? ''}`),
    )
    .map((c) => {
      const km = haversine(origin, { lat: c.lat, lng: c.lng }) / 1000;
      const sight = SIGHT.test(`${c.title} ${c.description ?? ''}`) && !EVENT.test(c.description ?? '');
      const dull = DULL.test(c.description ?? '') || DULL.test(c.title);
      const score = (sight ? 10 : 0) + (c.thumbnail ? 2 : 0) + (c.description ? 1 : 0) - km / 10;
      return { c, km, score, sight, dull };
    });
  const sights = scored.filter((x) => x.sight).sort((a, b) => b.score - a.score);
  // Fill up to six with other photographed places, never institutions or towns.
  const filler = scored
    .filter((x) => !x.sight && !x.dull && x.c.thumbnail && x.c.description)
    .sort((a, b) => a.km - b.km)
    .slice(0, Math.max(0, 6 - sights.length));
  return [...sights, ...filler].slice(0, limit).map(({ c, km }) => ({
    title: c.title,
    ...(c.description ? { description: c.description } : {}),
    ...(c.thumbnail ? { thumbnail: c.thumbnail } : {}),
    km: Math.round(km * 10) / 10,
  }));
}

const stripHtml = (s: string | undefined) =>
  (s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

// ---------- the Wikimedia calls ----------

const WIKI = 'https://en.wikipedia.org/w/api.php';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
// Wikimedia asks every client to say who it is and how to reach them; clients that do get
// far fewer "too fast" (429) answers. Set WIKIMEDIA_CONTACT to an email or a web address.
const CONTACT = process.env.WIKIMEDIA_CONTACT?.trim();
const HEADERS = {
  'User-Agent': `Arrivo/1.0 (travel-safety app; destination info${CONTACT ? `; ${CONTACT}` : ''})`,
  Accept: 'application/json',
};
const TIMEOUT_MS = 4000;
/** An article this far from the pin is a different place. */
const MAX_ARTICLE_KM = 30;

type Json = Record<string, any>;

function qs(params: Record<string, string | number>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) out.set(k, String(v));
  return out.toString();
}

/** GET with up to two short retries when Wikimedia says "too fast" (429). */
async function fetchWiki(url: string): Promise<Response> {
  let res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  for (let attempt = 1; res.status === 429 && attempt <= 2; attempt++) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || attempt, 2);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
  return res;
}

/** One GET. Throws on failure; callers decide whether that loses anything. */
async function getJson(base: string, params: Record<string, string | number>): Promise<Json> {
  const res = await fetchWiki(`${base}?${qs({ format: 'json', formatversion: 2, ...params })}`);
  if (!res.ok) throw new Error(`wikimedia ${res.status}`);
  return (await res.json()) as Json;
}

export function wikipedia(): WikiProvider {
  /** Marks the answer incomplete when a part fails, and gives the fallback instead. */
  function guard(state: { complete: boolean }) {
    return async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await run();
      } catch (e) {
        state.complete = false;
        logError(`[wiki] ${what} failed: ${errorText(e)}`);
        return fallback;
      }
    };
  }

  /** The article about the picked place: name first, then the city, and only if it is really nearby. */
  async function findArticle(
    q: DestinationQuery,
    lang: string | undefined,
  ): Promise<{ title: string; qid?: string; description?: string; image?: string; localTitle?: string } | null> {
    const names = [...new Set([q.name, q.city].filter((n): n is string => !!n && n.trim().length > 1))];
    for (const name of names) {
      const data = await getJson(WIKI, {
        action: 'query',
        generator: 'search',
        gsrsearch: name,
        gsrlimit: 6,
        prop: lang ? 'coordinates|description|pageimages|pageprops|langlinks' : 'coordinates|description|pageimages|pageprops',
        ppprop: 'wikibase_item|disambiguation',
        piprop: 'thumbnail',
        pithumbsize: 800,
        colimit: 6,
        ...(lang ? { lllang: lang, lllimit: 6 } : {}),
      });
      const pages = ((data.query?.pages as Json[] | undefined) ?? [])
        .filter((p) => p.coordinates?.[0] && !p.pageprops?.disambiguation)
        .map((p) => ({
          p,
          km: haversine({ lat: q.lat, lng: q.lng }, { lat: p.coordinates[0].lat, lng: p.coordinates[0].lon }) / 1000,
        }))
        .filter((x) => x.km <= MAX_ARTICLE_KM)
        .sort((a, b) => a.km - b.km);
      const best = pages[0]?.p;
      if (best) {
        return {
          title: best.title as string,
          qid: best.pageprops?.wikibase_item as string | undefined,
          description: best.description as string | undefined,
          image: best.thumbnail?.source as string | undefined,
          localTitle: best.langlinks?.[0]?.title as string | undefined,
        };
      }
    }
    return null;
  }

  async function fullText(title: string) {
    const data = await getJson(WIKI, {
      action: 'query',
      prop: 'extracts|info',
      explaintext: 1,
      titles: title,
      redirects: 1,
      inprop: 'url',
    });
    const page = (data.query?.pages as Json[] | undefined)?.[0] ?? {};
    const { lead, sections } = splitSections((page.extract as string | undefined) ?? '');
    return { lead, sections, url: page.fullurl as string | undefined };
  }

  /** The article in another language: its summary, or undefined when that Wikipedia has none. */
  async function localSummary(lang: string, title: string) {
    const res = await fetchWiki(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`${lang}.wikipedia ${res.status}`);
    const j = (await res.json()) as Json;
    return j.extract
      ? { lang, label: LANGUAGE_LABELS[lang] ?? lang, title: j.title as string, extract: clip(j.extract as string, 900) }
      : undefined;
  }

  /** The link to the same article in one language, for the fallback try. */
  async function langlinkTitle(title: string, lang: string): Promise<string | undefined> {
    const data = await getJson(WIKI, { action: 'query', prop: 'langlinks', titles: title, redirects: 1, lllang: lang, lllimit: 1 });
    return (data.query?.pages as Json[] | undefined)?.[0]?.langlinks?.[0]?.title as string | undefined;
  }

  async function nearbyCandidates(at: LatLng): Promise<Candidate[]> {
    const data = await getJson(WIKI, {
      action: 'query',
      generator: 'geosearch',
      ggscoord: `${at.lat}|${at.lng}`,
      ggsradius: 10_000,
      ggslimit: 50,
      ggsnamespace: 0,
      prop: 'coordinates|description|pageimages',
      piprop: 'thumbnail',
      pithumbsize: 320,
      pilimit: 50,
      colimit: 50,
    });
    return ((data.query?.pages as Json[] | undefined) ?? [])
      .filter((p) => p.coordinates?.[0])
      .map((p) => ({
        title: p.title as string,
        description: p.description as string | undefined,
        thumbnail: p.thumbnail?.source as string | undefined,
        lat: p.coordinates[0].lat as number,
        lng: p.coordinates[0].lon as number,
      }));
  }

  /** Photos taken near a point (Commons, geotagged). Only freely licensed files with a known licence. */
  async function photosNear(at: LatLng, radius: number, limit: number): Promise<Photo[]> {
    const data = await getJson(COMMONS, {
      action: 'query',
      generator: 'geosearch',
      ggscoord: `${at.lat}|${at.lng}`,
      ggsradius: radius,
      ggsnamespace: 6,
      ggslimit: 30,
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|mime',
      iiurlwidth: 800,
      iiextmetadatafilter: 'LicenseShortName|Artist',
    });
    const out: Photo[] = [];
    for (const p of (data.query?.pages as Json[] | undefined) ?? []) {
      const info = p.imageinfo?.[0] as Json | undefined;
      const license = stripHtml(info?.extmetadata?.LicenseShortName?.value);
      if (!info?.thumburl || !/^image\/(jpeg|png)$/.test(info.mime ?? '') || !license) continue;
      out.push({
        url: info.thumburl as string,
        thumb: (info.thumburl as string).replace(/\/(\d+)px-/, '/320px-'),
        title: String(p.title ?? '').replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
        credit: stripHtml(info.extmetadata?.Artist?.value) || 'Wikimedia Commons contributor',
        license,
        pageUrl: info.descriptionurl as string,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async function facts(qid: string): Promise<Facts> {
    const data = await getJson(WIKIDATA, { action: 'wbgetentities', ids: qid, props: 'claims' });
    const claims = (data.entities?.[qid]?.claims ?? {}) as Record<string, Json[]>;
    const year = (s: Json) => Number(s.qualifiers?.P585?.[0]?.datavalue?.value?.time?.slice(1, 5)) || 0;
    const pick = (p: string): Json | undefined =>
      (claims[p] ?? [])
        .filter((s) => s.rank !== 'deprecated' && s.mainsnak?.datavalue)
        .sort((a, b) => Number(b.rank === 'preferred') - Number(a.rank === 'preferred') || year(b) - year(a))[0];
    const value = (p: string) => pick(p)?.mainsnak.datavalue.value;
    const unit = (u: string | undefined) => ({ Q11573: ' m', Q712226: ' km²' })[(u ?? '').split('/').pop() ?? ''] ?? '';
    const qty = (p: string) => {
      const v = value(p);
      if (!v?.amount) return undefined;
      const y = year(pick(p)!);
      return `${Number(v.amount).toLocaleString('en-IN')}${unit(v.unit)}${y ? ` (${y})` : ''}`;
    };
    const text = (p: string) => (typeof value(p) === 'string' ? (value(p) as string) : undefined);

    const ids = ['P17', 'P131'].map((p) => value(p)?.id as string | undefined).filter((x): x is string => !!x);
    const labels: Record<string, string> = {};
    if (ids.length) {
      const l = await getJson(WIKIDATA, { action: 'wbgetentities', ids: ids.join('|'), props: 'labels', languages: 'en' });
      for (const [id, e] of Object.entries((l.entities ?? {}) as Record<string, Json>)) {
        if (e.labels?.en) labels[id] = e.labels.en.value as string;
      }
    }
    const label = (p: string) => labels[value(p)?.id as string];
    const out: Facts = {
      population: qty('P1082'),
      elevation: qty('P2044'),
      area: qty('P2046'),
      postalCode: text('P281'),
      website: text('P856'),
      country: label('P17'),
      district: label('P131'),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as Facts;
  }

  return {
    enabled: true,

    async destination(q) {
      const state = { complete: true };
      const safe = guard(state);
      const at = { lat: q.lat, lng: q.lng };

      // Sights are about the pin, not the article, so they do not wait for it.
      const lang = localLanguageFor(q.country, q.region);
      const [article, candidates] = await Promise.all([
        safe('find article', () => findArticle(q, lang), null),
        safe('nearby', () => nearbyCandidates(at), [] as Candidate[]),
      ]);
      if (!article) {
        if (candidates.length === 0) {
          // "Nothing written" is only proof when every search actually ran.
          if (!state.complete) throw new AppError(502, 'info_error', 'Could not load information about this place. Try again in a moment.');
          return null;
        }
        // Nothing written about this exact place, but there are sights close to it.
        return {
          value: { title: q.city ?? q.name, summary: '', facts: {}, places: rankPlaces(candidates, at, '') },
          complete: state.complete,
        };
      }

      // Text, facts and the Hindi article are independent: one round trip for all three.
      const [text, fact, local] = await Promise.all([
        safe('article text', () => fullText(article.title), null),
        article.qid ? safe('facts', () => facts(article.qid!), {} as Facts) : Promise.resolve({} as Facts),
        lang
          ? safe(
              'local language',
              async () => {
                const first = article.localTitle ? await localSummary(lang, article.localTitle) : undefined;
                if (first) return first;
                // The state's own Wikipedia has nothing: in India, Hindi is the second try.
                const backup = fallbackLanguageFor(q.country, lang);
                const title = backup ? await langlinkTitle(article.title, backup) : undefined;
                return backup && title ? await localSummary(backup, title) : undefined;
              },
              undefined,
            )
          : Promise.resolve(undefined),
      ]);

      const history = text ? pickHistory(text.sections) : undefined;
      return {
        value: {
          title: article.title,
          ...(article.description ? { description: article.description } : {}),
          summary: clip(text?.lead ?? '', 1200),
          ...(history ? { history: clip(history, 2000) } : {}),
          facts: fact,
          ...(text?.url ? { url: text.url } : {}),
          ...(article.image ? { image: article.image } : {}),
          ...(local ? { local } : {}),
          places: rankPlaces(candidates, at, article.title),
        },
        complete: state.complete,
      };
    },

    async place(title) {
      const data = await getJson(WIKI, {
        action: 'query',
        prop: 'extracts|pageimages|coordinates|description|info',
        titles: title,
        redirects: 1,
        explaintext: 1,
        exintro: 1,
        piprop: 'thumbnail',
        pithumbsize: 800,
        inprop: 'url',
      });
      const page = (data.query?.pages as Json[] | undefined)?.[0];
      if (!page || page.missing) return null;
      const c = page.coordinates?.[0] as { lat: number; lon: number } | undefined;
      return {
        value: {
          title: page.title as string,
          ...(page.description ? { description: page.description as string } : {}),
          extract: clip((page.extract as string | undefined) ?? '', 1500),
          ...(page.fullurl ? { url: page.fullurl as string } : {}),
          ...(page.thumbnail?.source ? { image: page.thumbnail.source as string } : {}),
          ...(c ? { coordinates: { lat: c.lat, lng: c.lon } } : {}),
        },
        complete: true,
      };
    },

    async photos(at, radiusM) {
      const state = { complete: true };
      const value = await guard(state)('photos', () => photosNear(at, radiusM, 8), [] as Photo[]);
      return { value, complete: state.complete };
    },
  };
}
