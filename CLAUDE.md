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

---

TRIP — [Origin City, ST] to [Destination City, ST] — [Travel Date or "flexible"]

FLIGHTS

[Airline or booking site]
[Route] — [Fare range if found] — [Nonstop or # stops]
[Key detail: departure window, booking tip, deal note]

LODGING

[Hotel name]
[Neighborhood or distance from center] — [Nightly rate if found]
[One sentence on why it's a good pick]

RENTAL CAR

[Company name or aggregator]
[Vehicle class] — [Daily rate if found]
[One sentence on pickup logistics or deal note]

---

Best 2–3 options per category. Keep each pick under 80 words. If a zip code is given, identify the city and use that name throughout.
