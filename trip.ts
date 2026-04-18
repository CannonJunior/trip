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
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a sharp travel planner writing a concise trip briefing covering flights, lodging, and a rental car.

MANDATORY: You MUST use web_search to find real, current options before writing anything. NEVER fabricate prices, schedules, or availability. If results are sparse, say so — do not invent picks.

CRITICAL INSTRUCTION: Begin your response immediately with "TRIP —" followed by the origin and destination on the very first line. Never ask the user for clarification — search immediately with the zip codes or city names given. Resolve zip codes to city names for all searches.

VOICE AND STYLE
- Specific and actionable — cite airline names, hotel names, car brands, exact prices found
- Every price MUST be accompanied by a direct booking URL on the very next line. If you cannot find a direct URL for a price, omit that option entirely — do not include unlinked prices.
- Plain text only — no markdown, no asterisks, no bullet symbols. Signal does not render markdown.
- Use dashes (—) as separators within a line, blank lines between picks
- Keep each pick under 80 words (excluding the URL line)
- Best 2–3 options per category

OUTPUT FORMAT — follow exactly:

TRIP — [Origin City, ST] to [Destination City, ST] — [Travel Date or "flexible"]

FLIGHTS

[Airline or booking site name]
[Route] — [Exact fare found] — [Nonstop or # of stops]
[Key detail: departure window or deal note]
Book: [direct URL to this fare or search result page]

(repeat for 2–3 flight options)

LODGING

[Hotel name]
[Neighborhood or distance from center] — [Exact nightly rate found]
[One sentence on why it's a good pick]
Book: [direct URL to this property's booking page]

(repeat for 2–3 lodging options)

RENTAL CAR

[Company name]
[Vehicle class] — [Exact daily rate found]
[One sentence on pickup logistics or deal note]
Book: [direct URL to this rental offer]

(repeat for 2–3 rental options)

RULES:
- Every "Book:" line must be a real URL obtained from search results — never construct or guess a URL.
- If a category yields no options with both a price AND a direct URL, write "No bookable options found for [category]." and move on.
- Do not include any option that lacks a direct booking link.`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 15,
  },
];

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

function buildInitialPrompt(origin: string, destination: string, dateContext: string): string {
  return `Plan a trip from ${origin} to ${destination} around ${dateContext}.

CRITICAL: For every price you include, you MUST record the direct booking URL from the search result. Only include an option if you have both a price AND a URL where the user can click through to complete the purchase or reservation. Never guess or construct URLs.

Use web_search to find real bookable options across three categories:

1. FLIGHTS from ${origin} to ${destination} around ${dateContext}:
   - "${origin} to ${destination} flights ${dateContext}"
   - "${origin} to ${destination} cheap flights"
   - "flights ${origin} ${destination} nonstop"
   Target: Kayak, Google Flights, Expedia, or direct airline booking pages. Capture the exact fare and the URL from the search result.

2. LODGING in ${destination} around ${dateContext}:
   - "${destination} hotels ${dateContext}"
   - "${destination} best hotels near downtown"
   - "${destination} hotel deals ${dateContext}"
   Target: Booking.com, Hotels.com, Marriott, Hilton, or other hotel brand booking pages. Capture the nightly rate and the URL.

3. RENTAL CAR at ${destination} around ${dateContext}:
   - "${destination} airport car rental ${dateContext}"
   - "cheapest car rental ${destination} ${dateContext}"
   - "Enterprise Hertz Avis ${destination} car rental"
   Target: Enterprise, Hertz, Avis, Budget, or Kayak Cars. Capture the daily rate and the URL.

Write the trip plan exactly per the format in your instructions. Every price must have a "Book:" line with the direct URL from search.`;
}

const MAX_CONTINUATIONS = 3;
const MAX_ITERATIONS = 20;

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
      // web_search_20260209 is fully server-side: the API executes the search
      // and returns results in response.content alongside ServerToolUseBlock.
      const clientToolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      if (clientToolUseBlocks.length > 0) {
        return '(error: unexpected client-side tool_use with no handler)';
      }
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
  return text || '(no trip options found)';
}
