# COD proxy for the phase viewer

The existing `he-inventory.gs` web app now has two public, read-only GET routes.
They run before inventory authentication, do not read or write sheets, and do not
use inventory, collector or XRD code counters. Copying that one `.gs` file still
installs the complete backend. No additional Script Property is required.

## API contract

Construct parameters with `URLSearchParams` and use an ordinary GET without
custom headers. Follow the Google Content Service redirect. Requests go to the
existing `/exec` URL only after the new backend has been deployed.

### Search: `?action=cod&formula=VO2` (optional `&sg=14`)

```json
{
  "ok": true,
  "status": "ok",
  "formula": "O2 V",
  "sg_number": null,
  "query_mode": "exact_formula",
  "count": 11,
  "records": [],
  "fetched_at": "2026-10-24T00:00:00.000Z",
  "cached": false,
  "source_url": "https://www.crystallography.net/cod/result?format=json&formula=O2%20V"
}
```

This example omits the eleven records for space. `records` contains the unmodified
COD metadata rows, including `file`, `sg`, `sgNumber`, `formula`, cell parameters
and bibliographic fields. A genuinely empty search has `status:"empty"`,
`count:0`, and `records:[]`. Neither an empty body nor a malformed/error response
is accepted as an empty search.

The parser accepts compact or space-separated element/count tokens, decimal
counts with up to six decimal places, and Unicode subscript digits. It validates
element symbols, sums repeated elements, and uses Hill order (C, then H, then
alphabetically when carbon is present; otherwise alphabetical). Examples:
`VO₂` → `O2 V`, `NbSe2` → `Nb Se2`, `CH3COOH` → `C2 H4 O2`.
Parentheses, charges, hydrate separators and variable occupancies are explicitly
rejected. Element counts must be positive and no larger than 10000, with at most
120 input characters and 40 tokens.

`sg` is an optional space group number. It must be 1-230 written in plain
digits; anything else is `INVALID_SG` and nothing is fetched. A valid number is
passed to COD as its own `space_group_number` filter, `sg_number` repeats it,
and `query_mode` becomes `exact_formula+space_group_number`. A filtered and an
unfiltered search are separate cache entries.

**COD ignores a parameter it does not accept, including an out-of-range value.**
Checked 2026-10-24 against COD: `formula=O2 V` returns 11 records,
`&space_group_number=14` returns 2, and `&space_group_number=999`,
`&space_group_number=abc` and the misspelled `&sgnumber=14` each return the
unfiltered 11. One spelling, `&spacegroup=14`, returns 0. An upstream filter
that is dropped therefore looks exactly like a search that was never narrowed,
so the client must filter the returned rows by `sgNumber` as well; the viewer
does (`PhaseCore.filterBySg`). Do not infer a phase's absence from an upstream
filter alone.

**A record the client cannot judge is not an absence either.** COD rows come
with a space group number and no cell, and with a cell and no number. The relay
passes both through unchanged and counts neither as a failure; the viewer keeps
them apart in what it reports - matched, drawable, and unjudged - because
dropping them quietly turns "COD has this and we cannot draw it" into "COD does
not have this".

Counts are **not reduced to an empirical ratio**. `V2O4` and `VO2` make different
queries. The endpoint searches COD's exact formula field; it does not establish
that all phases or all equivalent composition spellings have been found. The
record count is not a phase count. Grouping and scientific identification belong
to the client.

### CIF: `?action=cif&id=1521122`

Success returns the original UTF-8 CIF text as `text/plain`. The ID must be seven
digits with a nonzero first digit. Only the fixed COD HTTPS host can be fetched;
callers cannot supply a URL. Basic checks require the requested `data_<id>` block
and six cell-parameter tags, and reject HTML. These checks are **not a complete
CIF or crystallographic validation**. The client must reject unsupported symmetry,
missing coordinates, invalid cell metrics and malformed loops before drawing.

Failures from either endpoint return JSON:

```json
{"ok":false,"code":"UPSTREAM_NETWORK","error":"COD could not be reached. Try again later.","retryable":true}
```

Inspect the body, not only HTTP `response.ok`: Content Service does not set an
application-specific HTTP status here. For CIF, check the returned content type
for JSON and parse errors before treating text as a CIF. Error codes are
`INVALID_FORMULA`, `INVALID_SG`, `INVALID_ID`, `METHOD_NOT_ALLOWED`, `UPSTREAM_NETWORK`,
`UPSTREAM_HTTP`, `UPSTREAM_INVALID`, `UPSTREAM_TOO_LARGE`, `TOO_MANY_RESULTS`,
and `PROXY_ERROR`. HTTP failures also include `upstream_status`. Form and JSON
POST requests for either action are rejected without incrementing lab counters.

## Bounds and caching

Each cache miss performs one COD request, with `timeoutSeconds:20`, HTTPS
certificate validation, and redirects disabled. There is no retry loop. Search
responses are limited to 1 MiB and 500 records; CIF responses to 512 KiB. Limits
are checked after UrlFetch returns, so these are acceptance limits rather than
streaming download limits. Oversized results fail explicitly; no records are
silently discarded. The visitor's ten-selected-structures limit is independent.

Validated successes are cached for up to six hours; empty searches for five
minutes. No error response is cached. Cache entries over 90000 UTF-8 bytes are
skipped, below Google's 100 KB limit. Eviction/cache failures fall back to a fresh
request. `fetched_at` remains the original fetch time on a search cache hit.
Google may evict an entry earlier; this cache is not an offline archive.

COD uses `getUserCache()`, a different cache instance from the lab authentication
code's `getScriptCache()`. This keeps bulk COD entries out of the cache whose
item limit could otherwise evict short-lived inventory/collector lockouts.
Cache reuse is scoped to the current Apps Script user and script; do not assume
a hit across different execution users. Cache failure still permits uncached
reads. This separation does not create separate execution/URL Fetch quotas.

These public routes consume the existing Apps Script project's execution and
URL Fetch quota. They do not hold the shared script lock while waiting for COD.
There is no per-user rate limiting; move to a separate proxy deployment if public
traffic makes shared project quotas unsuitable for the lab telemetry service.

## Client handoff

The current static loader expects `{formula,fetched,entries:[...]}`. Map raw rows
as in `scripts/fetch_phases.py`: `file` → `cod_id`, `sg` → `spacegroup`,
`sgNumber` → numeric `sg_number`, `vol` → `volume`, numeric cell parameters, and
`celltemp`/`diffrtemp` → `temperature`. Validate missing/nonfinite numeric fields
rather than inventing a cell. Construct links from validated IDs and the fixed
COD host. Render remote text using text nodes, never `innerHTML`.

List search metadata first, then fetch CIF only for selected records. Use bounded
concurrency and a request-generation token or abort signal so an older search
cannot replace a newer one. `structure()` currently expects a ready CIF; await
the fetch before drawing. Preserve the current drawing when a search fails and
distinguish no matches, upstream failure, and a record that cannot be rendered.

## Rollout and verification

1. Keep the frontend proxy switch disabled. **Do not probe `cod`/`cif` on the old
   production deployment:** unknown GET actions reach inventory authentication
   and can increment its shared failure counter.
2. Review this script and deploy a new version of the existing Apps Script web
   app, retaining the existing spreadsheet, access settings and `/exec` URL.
   Authorize URL Fetch's external-request scope if prompted.
3. Only after confirming that version is deployed, test `VO2`, a valid unmatched
   formula, `VO2` with `&sg=14` and with `&sg=999`, one known CIF, and an invalid
   ID from the intended HTTPS site. Confirm Google redirect/CORS behavior and
   unchanged inventory/telemetry flows.
4. Enable live search in the phase viewer after those checks: `live: true` in
   `data/phases.js`, whose `relayUrl` must already hold this deployment's
   `/exec` address. The lab-code gate (`gate: true`) uses the same address but
   the already-deployed `xrdcheck` route, so it does not wait on this step.

Local page regression test, including the gate, the space group filter, and an
upstream that stops honouring the filter:

```sh
node scripts/test_phase_page.mjs
```

Local backend regression tests:

```sh
node --test scripts/apps-script/test_*.cjs
```

Local tests execute the actual handlers with mocked Google services. A direct COD
HTTP check can validate upstream formats; neither proves Google-hosted execution,
authorization, CORS, timeout enforcement or production deployment.

## References checked 2026-10-24

- [COD REST API](https://wiki.crystallography.net/RESTful_API/): `formula` uses Hill
  notation; JSON search and direct CIF retrieval are supported. The filter
  parameter name and COD's silence on unknown parameters were checked against
  the live service rather than taken from the page.
- [Google Cache](https://developers.google.com/apps-script/reference/cache/cache):
  100 KB per entry, maximum six-hour expiry, possible earlier eviction.
- [Google CacheService](https://developers.google.com/apps-script/reference/cache/cache-service):
  separate script and user cache instances and scopes.
- [Google UrlFetchApp](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app):
  `timeoutSeconds`, `followRedirects`, `muteHttpExceptions` and external-request
  scope.
- [Google Content Service](https://developers.google.com/apps-script/guides/content):
  text/JSON output and redirect to `script.googleusercontent.com`.
