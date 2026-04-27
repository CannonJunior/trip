/**
 * /trip — Plan a flight, lodging, and rental car from an origin to a destination zip code.
 *
 * URL strategy: LLM-generated booking URLs are unreliable by design — airlines use
 * session-dependent URLs, Google Flights uses obfuscated protobuf encoding, and bot
 * detection on travel sites blocks programmatic verification of page content.
 *
 * Instead, this module generates DETERMINISTIC SEARCH DEEP LINKS using documented
 * stable URL formats from trusted aggregators. The LLM's only job is to resolve zip
 * codes to IATA airport codes and city names; the URL structure itself is fixed.
 * verify_url confirms each link resolves to a real page (not a 404 or homepage
 * redirect). Prices shown are live and current when the user clicks — not locked.
 *
 * To get locked fares with guaranteed pricing, see CLAUDE.md for the Duffel API
 * integration path (flights-mcp).
 *
 * Exports:
 *   generateTrip()        — run the trip planning agent
 *   getDefaultOrigin()    — read the saved default origin zip code
 *   setDefaultOrigin()    — persist a new default origin zip code
 *   isValidZipCode()      — validate a 5-digit US zip code
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ORIGIN_FILE = path.join(PROJECT_DIR, 'default-origin');
const HARDCODED_DEFAULT_ORIGIN = '22101';

export function isValidZipCode(value: string): boolean {
  return /^\d{5}$/.test(value.trim());
}

export function getDefaultOrigin(): string {
  try {
    const saved = fs.readFileSync(DEFAULT_ORIGIN_FILE, 'utf8').trim();
    return saved || HARDCODED_DEFAULT_ORIGIN;
  } catch {
    return HARDCODED_DEFAULT_ORIGIN;
  }
}

export function setDefaultOrigin(zip: string): void {
  fs.writeFileSync(DEFAULT_ORIGIN_FILE, zip.trim(), 'utf8');
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function isoDateFromContext(dateContext?: string): string {
  if (dateContext) {
    const d = new Date(dateContext);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  // Default: two weeks from today
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// URL verification
// ---------------------------------------------------------------------------

// 403 from these domains is bot detection, not a broken link. Real browsers work fine.
const TRUSTED_AGGREGATOR_DOMAINS = [
  'kayak.com', 'booking.com', 'hotels.com', 'expedia.com',
  'google.com', 'rentalcars.com', 'priceline.com',
];

const ROOT_PATH_RE = /^\/?(index\.html?)?$/i;

const NOT_FOUND_PHRASES = [
  'page not found', '404 not found', "doesn't exist", 'no results found',
  "we couldn't find", 'no flights found', 'no availability', 'sorry, this page',
  'this page is no longer available',
];

interface VerifyResult {
  ok: boolean;
  status: number;
  final_url: string;
  redirected_to_root: boolean;
  bot_detection: boolean;
  not_found_on_page: boolean;
  page_title: string;
  error?: string;
}

async function verifyUrl(url: string): Promise<VerifyResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12_000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const finalUrl = response.url;
    const body = await response.text();

    let redirectedToRoot = false;
    let isTrustedDomain = false;
    try {
      const inputHost = new URL(url).hostname;
      const finalParsed = new URL(finalUrl);
      redirectedToRoot =
        inputHost === finalParsed.hostname &&
        ROOT_PATH_RE.test(finalParsed.pathname) &&
        url !== finalUrl;
      isTrustedDomain = TRUSTED_AGGREGATOR_DOMAINS.some(d => finalParsed.hostname.endsWith(d));
    } catch { /* ignore parse errors */ }

    const bodyLower = body.toLowerCase();
    const notFoundOnPage = NOT_FOUND_PHRASES.some(p => bodyLower.includes(p));

    // 403 from a trusted aggregator = bot detection; real users with browsers are fine
    const botDetection = response.status === 403 && isTrustedDomain;

    const ok = (response.ok || botDetection) && !redirectedToRoot && !notFoundOnPage;

    const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim().slice(0, 120) : '(no title)';

    return { ok, status: response.status, final_url: finalUrl, redirected_to_root: redirectedToRoot, bot_detection: botDetection, not_found_on_page: notFoundOnPage, page_title: pageTitle };
  } catch (err) {
    return { ok: false, status: 0, final_url: url, redirected_to_root: false, bot_detection: false, not_found_on_page: false, page_title: '', error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a travel planner. Your job is to generate VERIFIED, WORKING search links for flights, hotels, and rental cars using trusted aggregator sites.

CRITICAL ARCHITECTURAL RULE: You must NEVER construct or guess a booking URL. Travel booking URLs are session-dependent and protected by bot detection — LLM-generated booking links always fail. Instead, use ONLY the exact URL templates below, substituting real values you find via web_search. This is the only approach that produces links users can actually click and use.

WORKFLOW:

STEP 1 — RESOLVE LOCATIONS via web_search
Find the nearest major commercial airport IATA code for each location.
Search: "[location] nearest major airport IATA code"
Also find the full city name (for display and hotel search URLs).
Note: zip 22101 = McLean VA → DCA (Reagan National) or IAD (Dulles International).

STEP 2 — CONSTRUCT URLS using ONLY these exact templates
Substitute [ORIGIN], [DEST], [TRAVEL_DATE], [CHECKOUT_DATE], [CITY] with real values.
Do not change any other part of the URL.

FLIGHTS — Kayak round-trip (most reliable, stable format):
  https://www.kayak.com/flights/[ORIGIN]-[DEST]/[TRAVEL_DATE]/[RETURN_DATE]

FLIGHTS — Google Flights round-trip (natural-language query):
  https://www.google.com/travel/flights?q=round+trip+flights+from+[ORIGIN]+to+[DEST]+departing+[TRAVEL_DATE_WORDS]+returning+[RETURN_DATE_WORDS]
  (replace spaces with +, e.g. "May+1+2026")

HOTELS — Booking.com:
  https://www.booking.com/searchresults.html?checkin=[TRAVEL_DATE]&checkout=[CHECKOUT_DATE]&ss=[CITY_URL_ENCODED]&group_adults=2&no_rooms=1
  (URL-encode city: spaces → +, e.g. "Los+Angeles")

HOTELS — Google Hotels:
  https://www.google.com/travel/hotels?q=hotels+in+[CITY_URL_ENCODED]+[TRAVEL_DATE_URL_ENCODED]

RENTAL CARS — Kayak:
  https://www.kayak.com/cars/[DEST]/[TRAVEL_DATE]-0900/[CHECKOUT_DATE]-1700

STEP 3 — VERIFY each constructed URL by calling verify_url before including it.
  - ok: true → include it
  - ok: false AND bot_detection: false → the URL is broken; omit it
  - ok: true AND bot_detection: true → the link is valid; real browsers work fine

STEP 3.5 — SEARCH FOR PRICE ESTIMATES via web_search
After verifying URLs, search for current approximate prices to give the user a ballpark:
  - "round trip flights [ORIGIN] to [DEST] [TRAVEL_DATE] price"
  - "hotels [DEST CITY] [TRAVEL_DATE] price per night"
  - "car rental [DEST CITY] [TRAVEL_DATE] price per day"
Only quote prices that appear verbatim in search result snippets. If a snippet says "from $189", write "from ~$189". Label every price as an estimate with "~". If no price appears in any snippet, omit it for that category — do not infer or guess.

STEP 4 — WRITE the output with verified URLs and any estimates found.

ABSOLUTE RULES:
- Never invent or modify a URL. Only use the templates above.
- Never fabricate a price. Only cite prices that appeared verbatim in a search snippet, labeled with ~.
- Plain text only. No markdown. No asterisks. No bullet symbols.
- Use dashes (—) as separators, blank lines between entries.

OUTPUT FORMAT:

TRIP — [Origin City, ST] to [Destination City, ST] — [Depart Date] / Return [Return Date]

Estimates (~) are from recent search results and are not locked. Click any link to see live prices and book.

FLIGHTS (round trip)

Kayak — [ORIGIN] to [DEST], depart [Date] return [Return Date]
[~$NNN round trip if found in search, otherwise omit] — All major airlines compared.
Search: [verified Kayak round-trip URL]

Google Flights — [ORIGIN] to [DEST], depart [Date] return [Return Date]
[~$NNN round trip if found in search, otherwise omit] — Fare calendar and price alerts available.
Search: [verified Google Flights round-trip URL]

LODGING

Booking.com — [City] — [Check-in] to [Check-out]
[~$NNN/night if found in search, otherwise omit] — Free cancellation options available.
Search: [verified Booking.com URL]

Google Hotels — [City] — [Check-in] to [Check-out]
[~$NNN/night if found in search, otherwise omit] — Compares rates across booking sites.
Search: [verified Google Hotels URL]

RENTAL CAR

Kayak Cars — [Dest City] — [Pickup Date] to [Return Date]
[~$NNN/day if found in search, otherwise omit] — Enterprise, Hertz, Avis, Budget and more. Airport pickup.
Search: [verified Kayak Cars URL]`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 12, // IATA lookups + price estimate searches
  },
  {
    name: 'verify_url',
    description: 'Verify that a constructed URL resolves to a real page (not a 404 or homepage redirect). Call this on every URL before including it in the output. A 403 from a known travel aggregator (Kayak, Booking.com, Google, etc.) means bot detection — the link is valid for real users, so ok will be true. If ok is false, omit the link.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to verify.' },
      },
      required: ['url'],
    },
  },
];

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

function buildInitialPrompt(
  origin: string,
  destination: string,
  travelDateIso: string,
  checkoutDateIso: string,
  dateLabel: string,
): string {
  return `Plan a round-trip from ${origin} to ${destination}, departing ${dateLabel}.

Depart date (ISO, for URLs): ${travelDateIso}
Return date (ISO, 3 days later, for URLs): ${checkoutDateIso}

Follow the workflow from your instructions:

STEP 1 — IATA lookups (web_search):
  "${origin} nearest major airport IATA code"
  "${destination} nearest major airport IATA code"

STEP 2 — Construct these 5 URLs from the templates (round-trip for flights):
  - Kayak flights:   ORIGIN=${travelDateIso} DEST, depart ${travelDateIso}, return ${checkoutDateIso}
  - Google Flights:  round trip, depart ${travelDateIso}, return ${checkoutDateIso}
  - Booking.com:     checkin ${travelDateIso}, checkout ${checkoutDateIso}, destination city
  - Google Hotels:   destination city, ${travelDateIso}
  - Kayak Cars:      DEST IATA, pickup ${travelDateIso}-0900, return ${checkoutDateIso}-1700

STEP 3 — verify_url on all 5 URLs.

STEP 3.5 — Price estimate searches (web_search):
  "round trip flights ${origin} to ${destination} ${travelDateIso} price"
  "hotels ${destination} ${travelDateIso} price per night"
  "car rental ${destination} ${travelDateIso} price per day"

STEP 4 — Write the output.`;
}

const MAX_ITERATIONS = 30;

export async function generateTrip(
  client: Anthropic,
  model: string,
  origin: string,
  destination: string,
  dateContext?: string,
): Promise<string> {
  const travelDateIso = isoDateFromContext(dateContext);
  const checkoutDateIso = addDays(travelDateIso, 3);
  const dateLabel = new Date(travelDateIso + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

  const history: Anthropic.MessageParam[] = [
    { role: 'user', content: buildInitialPrompt(origin, destination, travelDateIso, checkoutDateIso, dateLabel) },
  ];

  const allTextParts: string[] = [];
  let iterations = 0;

  while (iterations++ < MAX_ITERATIONS) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages: history,
    });

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    );
    if (textBlocks.length > 0) {
      allTextParts.push(textBlocks.map(b => b.text).join(''));
    }

    history.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const clientToolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (clientToolUseBlocks.length === 0) {
        // Server-side web_search only; continue for synthesis turn.
        continue;
      }

      // Execute verify_url calls in parallel
      const toolResults = await Promise.all(
        clientToolUseBlocks.map(async (block) => {
          if (block.name === 'verify_url') {
            const input = block.input as { url: string };
            const result = await verifyUrl(input.url);
            return {
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: JSON.stringify(result),
            };
          }
          return {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: JSON.stringify({ error: `Unknown tool: ${block.name}` }),
          };
        }),
      );

      history.push({ role: 'user', content: toolResults });
      continue;
    }

    if (response.stop_reason === 'max_tokens') {
      history.push({ role: 'user', content: 'Continue.' });
      continue;
    }

    return `(unexpected stop: ${response.stop_reason})`;
  }

  const text = allTextParts.join('').trim();
  return text || '(no results)';
}
