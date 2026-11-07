/**
 * Which language to offer next to English for a destination: the language spoken
 * where it is. It decides which Wikipedia to read the same article in.
 *
 * India is by state (Punjab: Punjabi, Maharashtra: Marathi...), because one country
 * has many languages. Elsewhere it is by country. English-speaking countries get
 * none: there is nothing to switch to. A place we cannot place gets none too, rather
 * than a guess.
 */

/** Wikipedia language code to the language's own name. */
export const LANGUAGE_LABELS: Record<string, string> = {
  hi: 'हिन्दी',
  pa: 'ਪੰਜਾਬੀ',
  gu: 'ગુજરાતી',
  mr: 'मराठी',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  kn: 'ಕನ್ನಡ',
  ml: 'മലയാളം',
  bn: 'বাংলা',
  or: 'ଓଡ଼ିଆ',
  as: 'অসমীয়া',
  ur: 'اردو',
  ne: 'नेपाली',
  si: 'සිංහල',
  gom: 'कोंकणी',
  ja: '日本語',
  zh: '中文',
  ko: '한국어',
  th: 'ไทย',
  vi: 'Tiếng Việt',
  id: 'Indonesia',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  it: 'Italiano',
  pt: 'Português',
  nl: 'Nederlands',
  pl: 'Polski',
  el: 'Ελληνικά',
  ru: 'Русский',
  tr: 'Türkçe',
  ar: 'العربية',
  fa: 'فارسی',
  he: 'עברית',
  sv: 'Svenska',
  no: 'Norsk',
  da: 'Dansk',
  fi: 'Suomi',
};

const INDIA_STATES: Record<string, string> = {
  'andhra pradesh': 'te',
  assam: 'as',
  'west bengal': 'bn',
  tripura: 'bn',
  goa: 'gom',
  gujarat: 'gu',
  'dadra and nagar haveli and daman and diu': 'gu',
  karnataka: 'kn',
  kerala: 'ml',
  lakshadweep: 'ml',
  maharashtra: 'mr',
  odisha: 'or',
  orissa: 'or',
  punjab: 'pa',
  chandigarh: 'pa',
  sikkim: 'ne',
  'tamil nadu': 'ta',
  puducherry: 'ta',
  telangana: 'te',
  'jammu and kashmir': 'ur',
  'jammu & kashmir': 'ur',
};

/** Hindi is the language of the rest of India (and the fallback when a state's own Wikipedia has no article). */
const INDIA_DEFAULT = 'hi';

const COUNTRIES: Record<string, string> = {
  japan: 'ja',
  china: 'zh',
  'south korea': 'ko',
  thailand: 'th',
  vietnam: 'vi',
  indonesia: 'id',
  france: 'fr',
  germany: 'de',
  austria: 'de',
  spain: 'es',
  mexico: 'es',
  argentina: 'es',
  colombia: 'es',
  chile: 'es',
  peru: 'es',
  italy: 'it',
  portugal: 'pt',
  brazil: 'pt',
  netherlands: 'nl',
  poland: 'pl',
  greece: 'el',
  russia: 'ru',
  turkey: 'tr',
  türkiye: 'tr',
  'saudi arabia': 'ar',
  'united arab emirates': 'ar',
  qatar: 'ar',
  egypt: 'ar',
  iran: 'fa',
  israel: 'he',
  pakistan: 'ur',
  bangladesh: 'bn',
  nepal: 'ne',
  'sri lanka': 'si',
  sweden: 'sv',
  norway: 'no',
  denmark: 'da',
  finland: 'fi',
};

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The language code to try first, or undefined when there is none worth offering. */
export function localLanguageFor(country?: string, region?: string): string | undefined {
  const c = norm(country);
  if (!c) return undefined;
  if (c === 'india') return INDIA_STATES[norm(region)] ?? INDIA_DEFAULT;
  return COUNTRIES[c];
}

/** A second try when the first language has no article for the place. Only India has one. */
export function fallbackLanguageFor(country: string | undefined, first: string): string | undefined {
  return norm(country) === 'india' && first !== INDIA_DEFAULT ? INDIA_DEFAULT : undefined;
}
