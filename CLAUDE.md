# Trip — Flight, Lodging & Rental Car Planner

**NEVER simulate, roleplay, or fabricate a trip plan.** When `/trip` is invoked, you MUST call `generateTrip()`, which runs a real web-search agent via the Anthropic API. Do not describe what the function would do. Do not produce example output. Execute the function and return its output verbatim.

## Your task

When asked to plan a trip, call `generateTrip()`. That function uses web_search to research real, current options for flights, lodging, and rental cars, then writes the plan in the exact format below. All picks must come from actual search results — never invent them.

## Default origin

The default origin zip code is 22101 (McLean, VA). Users can override it with `/trip -default <zip>`. The saved default is stored in `default-origin` in this project directory.

## What to search for

Run searches across three categories:

1. **Flights** — use queries like:
   - "[origin city] to [destination city] flights [date]"
   - "[origin] to [destination] nonstop flights"
   - "cheap flights [origin] [destination]"

2. **Lodging** — use queries like:
   - "[destination city] hotels [date]"
   - "[destination city] best hotels near downtown"
   - "[destination city] hotel deals"

3. **Rental car** — use queries like:
   - "[destination city] car rental [date]"
   - "[destination airport] car rental rates"
   - "cheapest car rental [destination]"

## Output format

Follow this format exactly. Plain text only — no markdown, no asterisks, no bullet symbols. Signal does not render markdown. Use dashes (—) as separators.

Every price MUST be followed by a "Book:" line with a direct URL obtained from search results. Never guess or construct URLs. If no bookable URL exists for an option, omit that option entirely.

---

TRIP — [Origin City, ST] to [Destination City, ST] — [Travel Date or "flexible"]

FLIGHTS

[Airline or booking site]
[Route] — [Exact fare] — [Nonstop or # stops]
[Key detail: departure window or deal note]
Book: [direct URL from search result]

LODGING

[Hotel name]
[Neighborhood or distance from center] — [Exact nightly rate]
[One sentence on why it's a good pick]
Book: [direct URL from search result]

RENTAL CAR

[Company name]
[Vehicle class] — [Exact daily rate]
[One sentence on pickup logistics or deal note]
Book: [direct URL from search result]

---

Best 2–3 options per category. Keep each pick under 80 words (excluding the Book: line). If a zip code is given, identify the city and use that name throughout. If a category has no results with both a price and a direct URL, write "No bookable options found for [category]."
