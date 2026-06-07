// Canonicalise URLs for dedupe (spec Section 9.5): https, lowercase host, drop www,
// strip tracking params, drop fragment + trailing slash. v1 dedupe is canonical-URL only.
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'source',
]);

export function canonicalizeUrl(input: string): string {
  try {
    const u = new URL(input.trim());
    u.protocol = 'https:';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.hash = '';
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.has(k.toLowerCase())) keep.append(k, v);
    }
    u.search = keep.toString();
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return input.trim();
  }
}
