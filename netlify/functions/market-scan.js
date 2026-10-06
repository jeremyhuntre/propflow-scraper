// netlify/functions/market-scan.js
//
// Real market scan across realestate.co.nz commercial lease listings.
//
// Design:
//   Pass 1 (cheap): for each suburb, page through the search results
//                    (?page=1,2,3...) pulling listing IDs until a page comes
//                    back with nothing new. realestate.co.nz serves ~20
//                    listings per page server-rendered even though the live
//                    site is an Ember.js app — confirmed live against
//                    /commercial/lease/auckland/waitakere-city/henderson,
//                    which currently has 270 results across ~14 pages.
//                    PREVIOUSLY this only ever fetched page 1, which is why
//                    totals were stuck around 15-20 per suburb regardless of
//                    how many suburbs were added.
//   Pass 2 (detail): fetches the individual listing page for anything not
//                    yet enriched, to pull title/price/size/type/address.
//                    BUDGETED: a full first run across all suburbs can mean
//                    1000+ listings needing detail fetches, which cannot fit
//                    in one Netlify function invocation (10s default / 26s
//                    on paid plans) and shouldn't be done in one burst anyway
//                    (politeness toward the source site). Each invocation
//                    enriches up to ENRICH_CAP listings and returns the rest
//                    as `pendingIds` — call the function again (same
//                    previousEnrichedIds) to keep chipping away until
//                    `pendingIds` is empty.
//
// KNOWN LIMITATION: written without access to the site's raw HTML/DOM in a
// browser (only text-rendered previews + live fetches of a couple of
// suburb/page combinations), so the regexes below are a best-effort based on
// observed patterns, and the exact listings-per-page count is inferred, not
// hardcoded. If a scan comes back with 0 results for a suburb that clearly
// has listings, or obviously wrong fields, check the `_debug` field (raw
// HTML length + snippet) and send it back for a parser fix rather than
// assuming the suburb has no listings. TBC: exact page size (observed 20),
// whether it's identical for every suburb/category.

const SUBURBS = [
  { label: 'Wairau Valley',      path: '/commercial/lease/auckland/north-shore-city/wairau-valley' },
  { label: 'Rosedale',           path: '/commercial/lease/auckland/north-shore-city/rosedale' },
  { label: 'Albany',             path: '/commercial/lease/auckland/north-shore-city/albany' },
  { label: 'Takapuna',           path: '/commercial/lease/auckland/north-shore-city/takapuna' },
  { label: 'Northcote',          path: '/commercial/lease/auckland/north-shore-city/northcote' },
  { label: 'Milford',            path: '/commercial/lease/auckland/north-shore-city/milford' },
  { label: 'Hobsonville',        path: '/commercial/lease/auckland/waitakere-city/hobsonville' },
  { label: 'Westgate',           path: '/commercial/lease/auckland/waitakere-city/westgate' },
  { label: 'Henderson',          path: '/commercial/lease/auckland/waitakere-city/henderson' },
  { label: 'Te Atatu Peninsula', path: '/commercial/lease/auckland/waitakere-city/te-atatu-peninsula' },
  { label: 'Te Atatu South',     path: '/commercial/lease/auckland/waitakere-city/te-atatu-south' },
  { label: 'Avondale (Rosebank)',path: '/commercial/lease/auckland/auckland-city/avondale' },
  { label: 'Newton (K Road)',    path: '/commercial/lease/auckland/auckland-city/newton' },
  { label: 'Grafton',            path: '/commercial/lease/auckland/auckland-city/grafton' },
  { label: 'Parnell',            path: '/commercial/lease/auckland/auckland-city/parnell' },
];

const BASE = 'https://www.realestate.co.nz';
const LISTING_HREF_RE = /href="(\/(\d+)\/commercial\/(lease|sale)\/([a-z0-9-]+))"/gi;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Safety valves. All tunable via the request body so you can experiment
// without redeploying.
const MAX_PAGES_PER_SUBURB = 30;   // ~600 listings/suburb ceiling, generous
const SUBURB_CONCURRENCY = 4;      // suburbs scanned in parallel
const ENRICH_CONCURRENCY = 5;      // detail-page fetches in parallel
const DEFAULT_ENRICH_CAP = 60;     // detail fetches per invocation
const TIME_BUDGET_MS = 8500;       // bail out gracefully before Netlify's own timeout kills us

function nowLeftMs(startedAt, budget) {
  return budget - (Date.now() - startedAt);
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return await res.text();
}

// Pull the unique set of listing IDs/urls off a single search-results page.
function extractListingRefs(html) {
  const seen = new Map();
  let m;
  LISTING_HREF_RE.lastIndex = 0;
  while ((m = LISTING_HREF_RE.exec(html)) !== null) {
    const [, relUrl, id, method, slug] = m;
    if (!seen.has(id)) seen.set(id, { id, url: BASE + relUrl, method: method === 'lease' ? 'For Lease' : 'For Sale', slug });
  }
  return Array.from(seen.values());
}

// Page through a suburb's results until a page adds nothing new, or we hit
// the safety cap. Returns { refs, pages, errors, firstPageHtmlLength }.
async function scanSuburb(suburb, startedAt, budgetMs) {
  const byId = new Map();
  const errors = [];
  let pages = 0;
  let firstPageHtmlLength = null;

  for (let page = 1; page <= MAX_PAGES_PER_SUBURB; page++) {
    if (nowLeftMs(startedAt, budgetMs) < 1200) {
      errors.push({ suburb: suburb.label, error: 'time budget reached, stopped at page ' + page });
      break;
    }
    const url = BASE + suburb.path + (page === 1 ? '' : '?page=' + page);
    let html;
    try {
      html = await fetchText(url);
    } catch (err) {
      errors.push({ suburb: suburb.label, page, error: err.message });
      break; // don't keep paging past a failure
    }
    if (page === 1) firstPageHtmlLength = html.length;

    const refs = extractListingRefs(html);
    pages = page;
    let addedAny = false;
    for (const r of refs) {
      if (!byId.has(r.id)) {
        r.suburbLabel = suburb.label;
        byId.set(r.id, r);
        addedAny = true;
      }
    }
    // Stop once a page contributes nothing new — covers both "last page"
    // and "page param ignored past the end" (site redirects back to page 1).
    if (!addedAny) break;
  }

  return { refs: Array.from(byId.values()), pages, errors, firstPageHtmlLength };
}

// Best-effort enrichment of a single listing page using its meta tags + nearby text.
function extractListingDetail(html, ref) {
  const detail = {
    id: ref.id, url: ref.url, method: ref.method,
    address: null, suburb: null, type: null, size: null, price: null,
    agency: null, agents: null, days: null, image_url: null, desc: null,
  };

  const titleMatch = html.match(/property="og:title"\s+content="([^"]+)"/i);
  if (titleMatch) detail.desc = titleMatch[1].replace(/\s*-\s*realestate\.co\.nz.*$/i, '').trim();

  const descMatch = html.match(/property="og:description"\s+content="([^"]+)"/i);
  if (descMatch) detail.long_desc = descMatch[1];

  const imageMatch = html.match(/property="og:image"\s+content="([^"]+)"/i);
  if (imageMatch) detail.image_url = imageMatch[1];

  const suburbFromSlug = ref.slug.split('-').slice(-2).join(' ');
  detail.suburb = suburbFromSlug.replace(/\b\w/g, c => c.toUpperCase());

  const sizeMatch = html.match(/([\d,.]+)\s*sqm/i) || html.match(/([\d,.]+)m2/i);
  if (sizeMatch) detail.size = parseFloat(sizeMatch[1].replace(/,/g, ''));

  const priceMatch = html.match(/\$[\d,]+(?:\.\d+)?(?:\s*Plus GST[^<"\n]*)?/i) || html.match(/\bNegotiation\b/i) || html.match(/\bPOA\b/i) || html.match(/\bContact agent\b/i);
  if (priceMatch) detail.price = priceMatch[0].trim();

  const typeMatch = html.match(/\b(Industrial|Office|Retail|Warehouse|Land)\s+Premises\b/i);
  if (typeMatch) detail.type = typeMatch[1];

  const agencyMatch = html.match(/alt="([^"]+?(?:Real Estate|Realty|Bayleys|Barfoot|Colliers|CBRE|JLL|Harcourts|Ray White)[^"]*)"/i);
  if (agencyMatch) detail.agency = agencyMatch[1].replace(/\s*\(Licensed.*$/i, '').trim();

  return detail;
}

// Tiny concurrency-limited map, no deps.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const startedAt = Date.now();

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const previousIds = new Set(body.previousIds || []);
    // Separate baseline: ids we've actually fetched a detail page for.
    // Falls back to previousIds for backwards compatibility with the
    // current PropFlow client, but that means on the FIRST run after this
    // deploy, everything currently "known" will be treated as already
    // enriched (no detail re-fetch) even though the old version never
    // actually enriched most of it. Clear propflow_portfolio_payload /
    // whatever localStorage key holds the old baseline once, so this
    // function starts both passes from a clean slate.
    // Pass { "forceFull": true } once after deploying this version to force
    // every currently-live listing through enrichment again, instead of
    // trusting the old baseline (which never actually enriched most of what
    // it "knew about", since the old version only ever saw page 1).
    const previousEnrichedIds = body.forceFull
      ? new Set()
      : new Set(body.previousEnrichedIds || body.previousIds || []);
    const enrichCap = Number.isFinite(body.enrichCap) ? body.enrichCap : DEFAULT_ENRICH_CAP;

    const suburbResults = [];
    const allRefs = [];
    const errors = [];

    // Pass 1 — enumerate current listing IDs per suburb, fully paginated,
    // several suburbs at once to keep wall-clock time down.
    await mapLimit(SUBURBS, SUBURB_CONCURRENCY, async (suburb) => {
      if (nowLeftMs(startedAt, TIME_BUDGET_MS) < 1500) {
        errors.push({ suburb: suburb.label, error: 'time budget reached before this suburb started' });
        suburbResults.push({ suburb: suburb.label, count: 0, pages: 0, skipped: true });
        return;
      }
      const { refs, pages, errors: suburbErrors, firstPageHtmlLength } = await scanSuburb(suburb, startedAt, TIME_BUDGET_MS);
      allRefs.push(...refs);
      errors.push(...suburbErrors);
      suburbResults.push({ suburb: suburb.label, count: refs.length, pages, htmlLength: firstPageHtmlLength });
    });

    const currentIds = new Set(allRefs.map(r => r.id));
    const removedIds = Array.from(previousIds).filter(id => !currentIds.has(id));

    // Everything seen in pass 1 that hasn't been enriched yet (new listing,
    // OR a listing from a previous run that got stuck in `pendingIds`).
    const needsEnrichment = allRefs.filter(r => !previousEnrichedIds.has(r.id));
    const toEnrichNow = needsEnrichment.slice(0, enrichCap);
    const pendingIds = needsEnrichment.slice(enrichCap).map(r => r.id);

    const newListings = [];
    await mapLimit(toEnrichNow, ENRICH_CONCURRENCY, async (ref) => {
      if (nowLeftMs(startedAt, TIME_BUDGET_MS) < 800) {
        pendingIds.push(ref.id); // ran out of time — retry next invocation
        return;
      }
      try {
        const html = await fetchText(ref.url);
        const detail = extractListingDetail(html, ref);
        detail.suburb = ref.suburbLabel;
        newListings.push(detail);
      } catch (err) {
        errors.push({ id: ref.id, url: ref.url, error: err.message });
        newListings.push({ id: ref.id, url: ref.url, suburb: ref.suburbLabel, method: ref.method, _enrichmentFailed: true });
      }
    });

    const enrichedIds = Array.from(new Set([
      ...previousEnrichedIds,
      ...newListings.filter(l => !l._enrichmentFailed).map(l => l.id),
    ]));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: JSON.stringify({
        scannedAt: new Date().toISOString(),
        suburbResults,
        totalCurrent: currentIds.size,
        newListings,
        removedIds,
        allIds: Array.from(currentIds),        // store as next run's previousIds (for removal-diffing)
        enrichedIds,                            // store as next run's previousEnrichedIds
        pendingIds,                             // non-empty => call again to keep enriching
        truncated: pendingIds.length > 0,
        errors,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify({ error: err.message }) };
  }
};
