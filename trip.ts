/**
 * /trip — Plan a flight, lodging, and rental car from an origin to a destination zip code.
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
// URL verification (client-side tool handler)
// ---------------------------------------------------------------------------

// Patterns that indicate a redirect swallowed the specific booking link
const ROOT_PATH_RE = /^\/?(index\.html?)?$/i;

// Phrases that signal the page is a generic error, not a booking page
const NOT_FOUND_PHRASES = [
  'page not found',
  '404 not found',
  "doesn't exist",
  'no results found',
  "we couldn't find",
  'no flights found',
  'no availability',
  'sorry, this page',
];

interface VerifyResult {
  ok: boolean;
  status: number;
  final_url: string;
  redirected_to_root: boolean;
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

    const body = await response.text();
    const finalUrl = response.url;

    // Detect redirect to homepage: same host, root-level path
    let redirectedToRoot = false;
    try {
      const inputHost = new URL(url).hostname;
      const finalParsed = new URL(finalUrl);
      redirectedToRoot =
        inputHost === finalParsed.hostname &&
        ROOT_PATH_RE.test(finalParsed.pathname) &&
        url !== finalUrl;
    } catch { /* ignore parse errors */ }

    const bodyLower = body.toLowerCase();
    const notFoundOnPage = NOT_FOUND_PHRASES.some(p => bodyLower.includes(p));

    const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim().slice(0, 120) : '(no title)';

    const ok = response.ok && !redirectedToRoot && !notFoundOnPage;

    return { ok, status: response.status, final_url: finalUrl, redirected_to_root: redirectedToRoot, not_found_on_page: notFoundOnPage, page_title: pageTitle };
  } catch (err) {
    return { ok: false, status: 0, final_url: url, redirected_to_root: false, not_found_on_page: false, page_title: '', error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a travel planner writing a verified trip briefing: flights, lodging, and a rental car.

You have two tools:
  web_search  — find options, prices, and booking URLs from live search results
  verify_url  — confirm a URL actually loads a valid booking page (not a 404, not a homepage redirect)

WORKFLOW — follow this order strictly:

STEP 1 — SEARCH: Use web_search to find candidate options with prices and URLs for each category (flights, lodging, rental car). Collect the raw URL exactly as it appears in the search result — never construct or modify URLs.

STEP 2 — VERIFY: Call verify_url on every candidate URL before including it in the output.
  - If verify_url returns ok: false → DISCARD that option. Do not mention it.
  - If verify_url returns ok: true → the option may be included.

STEP 3 — WRITE: Format only the verified options. Every price must come verbatim from a search result snippet — never estimate or infer. If a category has zero verified options, write "No verified bookable options found for [category]." and continue.

ABSOLUTE RULES:
- Never fabricate a price, airline name, hotel name, URL, or availability.
- Never construct a URL. Only use URLs that appeared in a search result and passed verify_url.
- Never include an option that failed or skipped verify_url.
- Plain text only — no markdown, no asterisks, no bullet symbols.
- Use dashes (—) as separators within a line, blank lines between picks.

OUTPUT FORMAT — begin your final response with this header, then the three sections:

TRIP — [Origin City, ST] to [Destination City, ST] — [Travel Date or "flexible"]

FLIGHTS

[Airline or booking site name]
[Route] — [Exact fare from search] — [Nonstop or stops]
[Departure window or deal note]
Book: [verified URL]

LODGING

[Hotel name]
[Neighborhood] — [Exact nightly rate from search]
[One sentence on why it's a good pick]
Book: [verified URL]

RENTAL CAR

[Company name]
[Vehicle class] — [Exact daily rate from search]
[Pickup note]
Book: [verified URL]

Best 2–3 options per category. Zip codes → resolve to city name before searching.`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 18,
  },
  {
    name: 'verify_url',
    description: 'Fetch a URL and confirm it returns a valid booking page — not a 404, not a redirect to a site homepage. You MUST call this on every candidate booking URL before including it in the output. If ok is false, discard that option entirely.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The exact URL from the search result to verify.' },
      },
      required: ['url'],
    },
  },
];

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

function buildInitialPrompt(origin: string, destination: string, dateContext: string): string {
  return `Plan a trip from ${origin} to ${destination} around ${dateContext}.

Follow the three-step workflow from your instructions: search, then verify every URL, then write only the verified options.

Search targets for each category:

FLIGHTS from ${origin} to ${destination}:
  web_search: "${origin} to ${destination} flights ${dateContext}"
  web_search: "${origin} to ${destination} cheap flights nonstop"
  web_search: "book flight ${origin} ${destination} ${dateContext} Kayak OR Expedia OR Google Flights"

LODGING in ${destination}:
  web_search: "${destination} hotels ${dateContext} book"
  web_search: "${destination} hotel deals ${dateContext} Booking.com OR Hotels.com OR Marriott OR Hilton"

RENTAL CAR at ${destination}:
  web_search: "${destination} airport car rental ${dateContext}"
  web_search: "cheapest car rental ${destination} ${dateContext} Enterprise OR Hertz OR Avis OR Budget"

After searching, call verify_url on every candidate URL. Discard any that fail. Then write the final trip plan.`;
}

const MAX_CONTINUATIONS = 3;
const MAX_ITERATIONS = 40;

export async function generateTrip(
  client: Anthropic,
  model: string,
  origin: string,
  destination: string,
  dateContext?: string,
): Promise<string> {
  const date = dateContext ?? new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const history: Anthropic.MessageParam[] = [
    { role: 'user', content: buildInitialPrompt(origin, destination, date) },
  ];

  const allTextParts: string[] = [];
  let continuationCount = 0;
  let iterations = 0;

  while (iterations++ < MAX_ITERATIONS) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
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
        // Only server-side tool use (web_search); continue for next turn.
        continue;
      }

      // Execute client-side verify_url calls in parallel
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
      if (continuationCount >= MAX_CONTINUATIONS) break;
      continuationCount++;
      history.push({ role: 'user', content: 'Continue the trip plan.' });
      continue;
    }

    return `(unexpected stop: ${response.stop_reason})`;
  }

  const text = allTextParts.join('').trim();
  return text || '(no verified trip options found)';
}
