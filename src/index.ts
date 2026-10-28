interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Netherlands court decisions (uitspraken en conclusies) — search by court,
 * legal domain and date, resolve by ECLI, read the full original Dutch text.
 * Separate from @pipeworx/nl-wetten (statutes) — this pack is case law.
 *
 * SOURCE: Raad voor de Rechtspraak publishes every Dutch court decision that
 * gets an ECLI (European Case Law Identifier) as Open Data: a REST metadata
 * search plus a per-ECLI content endpoint, both keyless and built for
 * third-party reuse. Keyless, live proxy: every call here reads from the
 * upstream per request; nothing is baked into this pack or stored by
 * Pipeworx.
 *
 * SEARCH IS METADATA, NOT FULL-TEXT: the official search endpoint filters by
 * court (creator), legal domain (subject/rechtsgebied), document type and
 * decision-date range only — it has no free-text parameter (confirmed by
 * probing a handful of candidate names; none changed the result count). What
 * LOOKS like text search here (`query`) is Pipeworx client-side filtering:
 * it fetches the metadata-filtered candidates and keeps only the ones whose
 * title or published abstract (summary) contains the term. That is real
 * published text, but it is NOT the full decision body — a term that only
 * appears deep in the reasoning will not match. nl_rechtspraak_search's
 * description says this plainly (corpus honesty).
 *
 * SCAN CAP: when `query` is given without a narrowing court/subject/date
 * filter, the candidate set can be millions of decisions. Pipeworx scans at
 * most SCAN_CAP of them (the most recently modified) per call, per the
 * source's own "don't hammer the server" guidance — one bounded GET, not a
 * crawl. The response says plainly when the scan was partial.
 *
 * THREE DATES, NEVER COLLAPSED: `decision_date` (uitspraakdatum — when the
 * court decided), `publication_date` (issued — when rechtspraak.nl published
 * it, which can be years later or not at all for older cases) and
 * `last_modified` (the metadata/text's own last change) are three different
 * dates in the source schema and are returned as three separate fields.
 *
 * BWB STATUTE CITATIONS ARE RARELY STRUCTURED: the schema has a documented
 * field for it (dcterms:references, prefix "bwb") with cardinality "0 or
 * more", but sampling recent Hoge Raad decisions found it populated in none
 * of them — courts cite legislation by name in the prose, not as a linked
 * identifier. `cited_bwb_ids` reads that field when present and also scans
 * the raw document for a literal "BWBR\d{7}" string as a fallback; empty
 * means the source did not formally link a statute, not that the decision
 * cites no legislation — chain by name through nl_wetten_search instead.
 *
 * COURTS AND RECHTSGEBIEDEN: the source's `creator` and `subject` filter
 * parameters take an exact identifier URI, not a free-text name — e.g.
 * "Hoge Raad" is rejected, only the full OWMS URI works. The full court list
 * is 261 entries (including courts abolished since the 2013 reorganisation);
 * COURTS below is the ~26 still issuing decisions today, which covers the
 * overwhelming majority of real queries. A caller who needs a discontinued
 * court can still pass the exact URI directly — `court` and `subject` both
 * accept either a known name or a raw "http://..." identifier unchanged.
 */


const UA = 'pipeworx-mcp-nl-rechtspraak/1.0 (+https://pipeworx.io)';
const BASE = 'https://data.rechtspraak.nl';
const SOURCE = 'Raad voor de Rechtspraak, Open Data van de Rechtspraak (uitspraken)';
const SCAN_CAP = 200;

async function pwFetch(url: string | URL): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 'data.rechtspraak.nl (Open Data van de Rechtspraak)');
}

// ── small helpers (regex-based — no XML parser in the Workers runtime) ──

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/[ \t]+/g, ' ').trim();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function validateDate(d: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`${label} must be an ISO date YYYY-MM-DD, got "${d}".`);
  return d;
}

function validateEcli(id: string): string {
  const v = id.trim();
  if (!/^ECLI:[A-Z]{2}:[A-Za-z0-9]+:\d{4}:[A-Za-z0-9.]+$/.test(v)) {
    throw new Error(`ecli must look like "ECLI:NL:HR:2019:2006" (ECLI:<country>:<court>:<year>:<number>), got "${id}".`);
  }
  return v;
}

/** Finds every `<tag attr="v" ...>text</tag>` occurrence and returns its
 *  attributes plus its plain-text content, in document order. */
function extractAll(xml: string, tag: string): { attrs: Record<string, string>; text: string }[] {
  const re = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out: { attrs: Record<string, string>; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:.-]+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[1])) !== null) attrs[am[1]] = decodeEntities(am[2]);
    out.push({ attrs, text: stripTags(m[2]) });
  }
  return out;
}

function extractOne(xml: string, tag: string): { attrs: Record<string, string>; text: string } | undefined {
  return extractAll(xml, tag)[0];
}

// ── reference lists: current courts + the rechtsgebied taxonomy ─────────
// Both fetched live from data.rechtspraak.nl/Waardelijst/{Instanties,
// Rechtsgebieden} on 2026-10-16 and hand-filtered/transcribed here — small,
// stable vocabularies (not a generated index), so no KV baking needed.

interface CourtRef { name: string; abbr: string; uri: string }

const COURTS: CourtRef[] = [
  { name: 'Hoge Raad', abbr: 'HR', uri: 'http://standaarden.overheid.nl/owms/terms/Hoge_Raad_der_Nederlanden' },
  { name: 'Parket bij de Hoge Raad', abbr: 'PHR', uri: 'http://standaarden.overheid.nl/owms/terms/Parket_bij_de_Hoge_Raad' },
  { name: 'Raad van State', abbr: 'RVS', uri: 'http://standaarden.overheid.nl/owms/terms/Raad_van_State' },
  { name: 'Centrale Raad van Beroep', abbr: 'CRVB', uri: 'http://standaarden.overheid.nl/owms/terms/Centrale_Raad_van_Beroep' },
  { name: 'College van Beroep voor het bedrijfsleven', abbr: 'CBB', uri: 'http://standaarden.overheid.nl/owms/terms/College_van_Beroep_voor_het_bedrijfsleven' },
  { name: "Gerechtshof 's-Hertogenbosch", abbr: 'GHSHE', uri: "http://standaarden.overheid.nl/owms/terms/Gerechtshof_'s-Hertogenbosch" },
  { name: 'Gerechtshof Amsterdam', abbr: 'GHAMS', uri: 'http://standaarden.overheid.nl/owms/terms/Gerechtshof_Amsterdam' },
  { name: 'Gerechtshof Arnhem-Leeuwarden', abbr: 'GHARL', uri: 'http://standaarden.overheid.nl/owms/terms/Gerechtshof_Arnhem-Leeuwarden' },
  { name: 'Gerechtshof Den Haag', abbr: 'GHDHA', uri: 'http://standaarden.overheid.nl/owms/terms/Gerechtshof_Den_Haag' },
  { name: 'Rechtbank Amsterdam', abbr: 'RBAMS', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Amsterdam' },
  { name: 'Rechtbank Den Haag', abbr: 'RBDHA', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Den_Haag' },
  { name: 'Rechtbank Gelderland', abbr: 'RBGEL', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Gelderland' },
  { name: 'Rechtbank Limburg', abbr: 'RBLIM', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Limburg' },
  { name: 'Rechtbank Midden-Nederland', abbr: 'RBMNE', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Midden-Nederland' },
  { name: 'Rechtbank Noord-Holland', abbr: 'RBNHO', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Noord-Holland' },
  { name: 'Rechtbank Noord-Nederland', abbr: 'RBNNE', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Noord-Nederland' },
  { name: 'Rechtbank Oost-Brabant', abbr: 'RBOBR', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Oost-Brabant' },
  { name: 'Rechtbank Overijssel', abbr: 'RBOVE', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Overijssel' },
  { name: 'Rechtbank Rotterdam', abbr: 'RBROT', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Rotterdam' },
  { name: 'Rechtbank Zeeland-West-Brabant', abbr: 'RBZWB', uri: 'http://standaarden.overheid.nl/owms/terms/Rechtbank_Zeeland-West-Brabant' },
  { name: 'Gemeenschappelijk Hof van Justitie van Aruba, Curaçao, Sint Maarten en van Bonaire, Sint Eustatius en Saba', abbr: 'OGHACMB', uri: 'http://psi.rechtspraak.nl/GHACSMBES' },
  { name: 'Gerecht in Ambtenarenzaken van Aruba, Curaçao, Sint Maarten en van Bonaire, Sint Eustatius en Saba', abbr: 'OGAACMB', uri: 'http://standaarden.overheid.nl/owms/terms/Gerecht_in_Ambtenarenzaken_van_Aruba_Curacao_Sint_Maarten_en_van_Bonaire_Sint_Eustatius_en_Saba' },
  { name: 'Gerecht in Eerste Aanleg van Aruba', abbr: 'OGEAA', uri: 'http://psi.rechtspraak.nl/GEA Aruba' },
  { name: 'Gerecht in eerste aanleg van Bonaire, Sint Eustatius en Saba', abbr: 'OGEABES', uri: 'http://psi.rechtspraak.nl/GEABES' },
  { name: 'Gerecht in eerste aanleg van Curaçao', abbr: 'OGEAC', uri: 'http://psi.rechtspraak.nl/GEAC' },
  { name: 'Gerecht in eerste aanleg van Sint Maarten', abbr: 'OGEASM', uri: 'http://psi.rechtspraak.nl/GEASM' },
];

interface SubjectRef { name: string; uri: string; parent?: string }

const SUBJECTS: SubjectRef[] = [
  { name: 'Bestuursrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht' },
  { name: 'Ambtenarenrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_ambtenarenrecht', parent: 'Bestuursrecht' },
  { name: 'Belastingrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_belastingrecht', parent: 'Bestuursrecht' },
  { name: 'Bestuursprocesrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_bestuursprocesrecht', parent: 'Bestuursrecht' },
  { name: 'Bestuursstrafrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_bestuursstrafrecht', parent: 'Bestuursrecht' },
  { name: 'Europees bestuursrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_europeesBestuursrecht', parent: 'Bestuursrecht' },
  { name: 'Mededingingsrecht (bestuursrecht)', uri: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_mededingingsrecht', parent: 'Bestuursrecht' },
  { name: 'Omgevingsrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_omgevingsrecht', parent: 'Bestuursrecht' },
  { name: 'Socialezekerheidsrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_socialezekerheidsrecht', parent: 'Bestuursrecht' },
  { name: 'Vreemdelingenrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_vreemdelingenrecht', parent: 'Bestuursrecht' },
  { name: 'Civiel recht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht' },
  { name: 'Aanbestedingsrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_aanbestedingsrecht', parent: 'Civiel recht' },
  { name: 'Arbeidsrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_arbeidsrecht', parent: 'Civiel recht' },
  { name: 'Burgerlijk procesrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_burgerlijkProcesrecht', parent: 'Civiel recht' },
  { name: 'Europees civiel recht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_europeesCivielRecht', parent: 'Civiel recht' },
  { name: 'Goederenrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_goederenrecht', parent: 'Civiel recht' },
  { name: 'Insolventierecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_insolventierecht', parent: 'Civiel recht' },
  { name: 'Intellectueel-eigendomsrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_intellectueeleigendomsrecht', parent: 'Civiel recht' },
  { name: 'Internationaal privaatrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_internationaalPrivaatrecht', parent: 'Civiel recht' },
  { name: 'Mededingingsrecht (civiel recht)', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_mededingingsrecht', parent: 'Civiel recht' },
  { name: 'Ondernemingsrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_ondernemingsrecht', parent: 'Civiel recht' },
  { name: 'Personen- en familierecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_personenEnFamilierecht', parent: 'Civiel recht' },
  { name: 'Verbintenissenrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_verbintenissenrecht', parent: 'Civiel recht' },
  { name: 'Strafrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#strafrecht' },
  { name: 'Europees strafrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#strafrecht_europeesStrafrecht', parent: 'Strafrecht' },
  { name: 'Internationaal strafrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#strafrecht_internationaalStrafrecht', parent: 'Strafrecht' },
  { name: 'Materieel strafrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#strafrecht_materieelStrafrecht', parent: 'Strafrecht' },
  { name: 'Penitentiair strafrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#strafrecht_penitentiairStrafrecht', parent: 'Strafrecht' },
  { name: 'Strafprocesrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#strafrecht_strafprocesrecht', parent: 'Strafrecht' },
  { name: 'Internationaal publiekrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#internationaalPubliekrecht' },
  { name: 'Mensenrechten', uri: 'http://psi.rechtspraak.nl/rechtsgebied#internationaalPubliekrecht_mensenrechten', parent: 'Internationaal publiekrecht' },
  { name: 'Volkenrecht', uri: 'http://psi.rechtspraak.nl/rechtsgebied#internationaalPubliekrecht_volkenrecht', parent: 'Internationaal publiekrecht' },
];

function resolveCourt(input: string): { uri: string; name?: string } {
  const v = input.trim();
  if (/^https?:\/\//i.test(v)) return { uri: v };
  const byAbbr = COURTS.find((c) => c.abbr.toLowerCase() === v.toLowerCase());
  if (byAbbr) return { uri: byAbbr.uri, name: byAbbr.name };
  const byName = COURTS.find((c) => c.name.toLowerCase() === v.toLowerCase());
  if (byName) return { uri: byName.uri, name: byName.name };
  const bySub = COURTS.find((c) => c.name.toLowerCase().includes(v.toLowerCase()));
  if (bySub) return { uri: bySub.uri, name: bySub.name };
  const names = COURTS.map((c) => `${c.name} (${c.abbr})`).join(', ');
  throw new Error(
    `court "${input}" is not one of the ~26 currently sitting Dutch courts this pack knows by name: ${names}. ` +
      `For a discontinued court, pass its exact identifier URI from data.rechtspraak.nl/Waardelijst/Instanties directly.`,
  );
}

function resolveSubject(input: string): { uri: string; name?: string } {
  const v = input.trim();
  if (/^https?:\/\//i.test(v)) return { uri: v };
  const byName = SUBJECTS.find((s) => s.name.toLowerCase() === v.toLowerCase());
  if (byName) return { uri: byName.uri, name: byName.name };
  const bySub = SUBJECTS.find((s) => s.name.toLowerCase().includes(v.toLowerCase()));
  if (bySub) return { uri: bySub.uri, name: bySub.name };
  const names = SUBJECTS.map((s) => (s.parent ? `${s.parent} > ${s.name}` : s.name)).join(', ');
  throw new Error(`subject "${input}" does not match the Rechtspraak rechtsgebied taxonomy: ${names}.`);
}

// ── search (Atom "zoeken" endpoint — metadata filters + client text match) ──

interface SearchEntry { ecli: string; raw_title: string; summary: string; modified?: string }

function parseAtomSearch(xml: string): { total: number; entries: SearchEntry[] } {
  const totalMatch = xml.match(/Aantal gevonden ECLI's:\s*(\d+)/);
  const total = totalMatch ? Number(totalMatch[1]) : 0;
  const entries: SearchEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const e = m[1];
    const ecli = e.match(/<id>([^<]*)<\/id>/)?.[1];
    const title = e.match(/<title[^>]*>([^<]*)<\/title>/)?.[1];
    const summary = e.match(/<summary[^>]*>([^<]*)<\/summary>/)?.[1];
    const updated = e.match(/<updated>([^<]*)<\/updated>/)?.[1];
    if (!ecli || !title) continue;
    entries.push({
      ecli: decodeEntities(ecli).trim(),
      raw_title: decodeEntities(title).trim(),
      summary: summary && summary.trim() !== '-' ? decodeEntities(summary).trim() : '',
      modified: updated,
    });
  }
  return { total, entries };
}

/** The search title is the fixed-shape human string rechtspraak.nl itself
 *  builds (doc §13.9): "ECLI, <instantie>, <DD-MM-YYYY>, <zaaknr(s)>". Parsed
 *  so court/date/case-number come back as separate fields rather than one
 *  blob; `parsed:false` on the rare entry that doesn't match the shape. */
function parseSearchTitle(ecli: string, rawTitle: string): { court?: string; decision_date?: string; case_numbers?: string; parsed: boolean } {
  const rest = rawTitle.startsWith(ecli) ? rawTitle.slice(ecli.length).replace(/^,\s*/, '') : rawTitle;
  const m = rest.match(/^([^,]+),\s*(\d{2})-(\d{2})-(\d{4})(?:,\s*(.+))?$/);
  if (!m) return { parsed: false };
  return { court: m[1].trim(), decision_date: `${m[4]}-${m[3]}-${m[2]}`, case_numbers: m[5]?.trim(), parsed: true };
}

async function search(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined;
  const courtInput = typeof args.court === 'string' && args.court.trim() ? args.court.trim() : undefined;
  const subjectInput = typeof args.subject === 'string' && args.subject.trim() ? args.subject.trim() : undefined;
  const type = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : undefined;
  const dateFrom = typeof args.date_from === 'string' && args.date_from.trim() ? validateDate(args.date_from.trim(), 'date_from') : undefined;
  const dateTo = typeof args.date_to === 'string' && args.date_to.trim() ? validateDate(args.date_to.trim(), 'date_to') : undefined;
  const offset = typeof args.offset === 'number' && args.offset >= 0 ? Math.floor(args.offset) : 0;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : 20;

  const court = courtInput ? resolveCourt(courtInput) : undefined;
  const subject = subjectInput ? resolveSubject(subjectInput) : undefined;
  let typeParam: string | undefined;
  if (type) {
    const t = type.toLowerCase();
    if (t === 'uitspraak') typeParam = 'Uitspraak';
    else if (t === 'conclusie') typeParam = 'Conclusie';
    else throw new Error(`type must be "uitspraak" or "conclusie", got "${type}".`);
  }

  const url = new URL(`${BASE}/uitspraken/zoeken`);
  url.searchParams.set('return', 'DOC');
  url.searchParams.set('sort', 'DESC');
  if (court) url.searchParams.set('creator', court.uri);
  if (subject) url.searchParams.set('subject', subject.uri);
  if (typeParam) url.searchParams.set('type', typeParam);
  if (dateFrom && dateTo) {
    url.searchParams.append('date', dateFrom);
    url.searchParams.append('date', dateTo);
  } else if (dateFrom) {
    url.searchParams.set('date', dateFrom);
  } else if (dateTo) {
    url.searchParams.set('date', dateTo);
  }

  if (query) {
    url.searchParams.set('max', String(SCAN_CAP));
  } else {
    url.searchParams.set('max', String(limit));
    url.searchParams.set('from', String(offset));
  }

  const res = await pwFetch(url);
  const raw = await res.text();
  if (!res.ok) throw new Error(`Rechtspraak search failed: HTTP ${res.status} — ${summarizeErrorBody(raw)}`);
  const { total, entries } = parseAtomSearch(raw);

  const filterApplied = [
    court ? `court=${court.name ?? court.uri}` : undefined,
    subject ? `subject=${subject.name ?? subject.uri}` : undefined,
    typeParam ? `type=${typeParam}` : undefined,
    dateFrom || dateTo ? `date=${dateFrom ?? ''}..${dateTo ?? dateFrom ?? ''}` : undefined,
  ].filter(Boolean);

  const toResult = (e: SearchEntry) => {
    const parsedTitle = parseSearchTitle(e.ecli, e.raw_title);
    return {
      ecli: e.ecli,
      court: parsedTitle.court,
      decision_date: parsedTitle.decision_date,
      case_numbers: parsedTitle.case_numbers,
      title: e.raw_title,
      abstract: e.summary || undefined,
      last_modified: e.modified,
      title_parsed: parsedTitle.parsed,
    };
  };

  if (!query) {
    if (total === 0) {
      return {
        results: [],
        total: 0,
        filters: filterApplied,
        reason: filterApplied.length
          ? `No decisions matched these filters: ${filterApplied.join('; ')}. Try widening the date range or dropping a filter.`
          : 'No decisions matched (unexpected with no filters — the source may be unreachable).',
        source: SOURCE,
        data_as_of: todayIso(),
      };
    }
    const page = entries.slice(0, limit).map(toResult);
    return {
      results: page,
      total,
      returned: page.length,
      offset,
      has_more: offset + page.length < total,
      next_offset: offset + page.length < total ? offset + page.length : undefined,
      filters: filterApplied,
      note: 'Metadata search (court/subject/type/date) — no `query` was given, so no text match was applied.',
      source: SOURCE,
      data_as_of: todayIso(),
    };
  }

  // Text-filter path: client-side substring match over title + abstract,
  // across at most SCAN_CAP of the metadata-filtered candidates.
  const q = query.toLowerCase();
  const scanned = entries.length;
  const matched = entries.filter((e) => e.raw_title.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q));
  const page = matched.slice(offset, offset + limit).map(toResult);
  const completeness = scanned >= total ? 'full' : 'partial';

  if (page.length === 0) {
    return {
      results: [],
      query,
      total_candidates: total,
      scanned,
      matched_in_scan: matched.length,
      completeness,
      filters: filterApplied,
      reason:
        matched.length > 0
          ? `${matched.length} decisions matched "${query}" but offset ${offset} is past the end of that list.`
          : `Scanned ${scanned} of ${total} filter-matching decisions for "${query}" in their title and published abstract, and found none. ` +
            `This only searches the title and abstract, not the full decision text — a term that only appears in the reasoning will not match. ` +
            (completeness === 'partial'
              ? `Only the ${scanned} most recently modified of ${total} candidates were scanned; narrow with court/subject/date_from/date_to to search a smaller, fuller window.`
              : `All matching candidates were scanned.`),
      source: SOURCE,
      data_as_of: todayIso(),
    };
  }

  return {
    results: page,
    query,
    total_candidates: total,
    scanned,
    matched_in_scan: matched.length,
    returned: page.length,
    offset,
    has_more: offset + page.length < matched.length,
    next_offset: offset + page.length < matched.length ? offset + page.length : undefined,
    completeness,
    completeness_note:
      completeness === 'partial'
        ? `Only the ${scanned} most recently modified of ${total} filter-matching decisions were scanned for "${query}"; more may match outside this window. Narrow with court/subject/date_from/date_to to search more completely.`
        : undefined,
    filters: filterApplied,
    note: 'Text match is against the title and published abstract only, not the full decision body.',
    source: SOURCE,
    data_as_of: todayIso(),
  };
}

// ── get one decision by ECLI (full metadata + text) ─────────────────────

function extractCitedBwbIds(xml: string): string[] {
  const ids = new Set<string>();
  for (const ref of extractAll(xml, 'dcterms:references')) {
    const bwb = ref.attrs['bwb:resourceIdentifier'];
    const m = bwb?.match(/BWBR\d{7}/i);
    if (m) ids.add(m[0].toUpperCase());
  }
  // Fallback: a literal BWB id written anywhere in the document, since the
  // structured reference field above is sparsely populated in practice.
  const literalRe = /BWBR\d{7}/g;
  let lm: RegExpExecArray | null;
  while ((lm = literalRe.exec(xml)) !== null) ids.add(lm[0].toUpperCase());
  return [...ids].sort();
}

function extractBodyText(xml: string): { text: string; found: boolean; kind?: 'uitspraak' | 'conclusie' } {
  let m = xml.match(/<uitspraak[^>]*>([\s\S]*?)<\/uitspraak>/);
  let kind: 'uitspraak' | 'conclusie' | undefined = m ? 'uitspraak' : undefined;
  if (!m) {
    m = xml.match(/<conclusie[^>]*>([\s\S]*?)<\/conclusie>/);
    kind = m ? 'conclusie' : undefined;
  }
  if (!m) return { text: '', found: false };
  const withBreaks = m[1].replace(/<\/(para|title|section|parablock|paragroup|entry|row)>/g, '</$1>\n');
  const text = decodeEntities(withBreaks.replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, found: true, kind };
}

async function getDecision(args: Record<string, unknown>): Promise<unknown> {
  const ecli = validateEcli(String(args.ecli ?? ''));
  const url = new URL(`${BASE}/uitspraken/content`);
  url.searchParams.set('id', ecli);
  const res = await pwFetch(url);
  const raw = await res.text();
  if (res.status === 404) {
    throw new Error(`No decision found for ECLI "${ecli}". Check the ECLI is correct, or use nl_rechtspraak_search to find it.`);
  }
  if (!res.ok) throw new Error(`Rechtspraak content fetch failed: HTTP ${res.status} — ${summarizeErrorBody(raw)}`);

  const regMatch = raw.match(/<rdf:Description>([\s\S]*?)<\/rdf:Description>/);
  const reg = regMatch ? regMatch[1] : raw;

  const creator = extractOne(reg, 'dcterms:creator');
  const date = extractOne(reg, 'dcterms:date');
  const issued = extractOne(reg, 'dcterms:issued');
  const modified = extractOne(reg, 'dcterms:modified');
  const docType = extractOne(reg, 'dcterms:type');
  const zaaknummers = extractAll(reg, 'psi:zaaknummer').map((z) => z.text).filter(Boolean);
  const procedures = extractAll(reg, 'psi:procedure').map((p) => ({ name: p.text, uri: p.attrs.resourceIdentifier }));
  const rechtsgebieden = extractAll(reg, 'dcterms:subject').map((s) => ({ name: s.text, uri: s.attrs.resourceIdentifier }));
  const relations = extractAll(reg, 'dcterms:relation').map((r) => ({
    related_ecli: r.attrs['ecli:resourceIdentifier'],
    relation_type: r.attrs['psi:typeRelatie'],
    aanleg: r.attrs['psi:aanleg'],
    gevolg: r.attrs['psi:gevolg'],
    text: r.text || undefined,
  }));
  const alternatives = extractAll(reg, 'dcterms:alternative').map((a) => a.text).filter(Boolean);
  const spatial = extractOne(reg, 'dcterms:spatial');
  const hasVersionMatch = reg.match(/<dcterms:hasVersion[^>]*>([\s\S]*?)<\/dcterms:hasVersion>/);
  const publicationReferences = hasVersionMatch
    ? [...hasVersionMatch[1].matchAll(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/g)].map((m) => decodeEntities(m[1]).trim()).filter(Boolean)
    : [];

  const abstractMatch = raw.match(/<inhoudsindicatie[^>]*>([\s\S]*?)<\/inhoudsindicatie>/);
  const abstract = abstractMatch ? stripTags(abstractMatch[1]) : undefined;

  const body = extractBodyText(raw);
  const citedBwbIds = extractCitedBwbIds(raw);

  if (!date && !body.found) {
    throw new Error(`Fetched "${ecli}" but could not find decision metadata or text in the response — the source document shape may have changed.`);
  }

  return {
    ecli,
    court: creator ? { name: creator.text, uri: creator.attrs.resourceIdentifier } : undefined,
    decision_date: date?.text,
    publication_date: issued?.text,
    last_modified: modified?.text,
    type: docType?.text,
    case_numbers: zaaknummers,
    procedures,
    rechtsgebieden,
    formal_relations: relations,
    alternative_identifiers: alternatives,
    hearing_location: spatial?.text,
    publication_references: publicationReferences,
    cited_bwb_ids: citedBwbIds,
    cited_bwb_ids_note:
      citedBwbIds.length === 0
        ? 'Empty: this decision does not carry a structured link to a BWB-registered statute (rare in the source even when the decision discusses legislation by name). Look up the law by name with nl_wetten_search, then chain to nl_wetten_get_article.'
        : 'BWBR ids this decision formally cites; look them up with nl_wetten_get_law / nl_wetten_get_article.',
    abstract,
    text: body.text || undefined,
    text_length: body.text.length || undefined,
    text_found: body.found,
    language: 'nl',
    source: SOURCE,
    data_as_of: todayIso(),
  };
}

// ── tool defs ─────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'nl_rechtspraak_search',
    description:
      'Search Dutch court decisions (uitspraken/conclusies) by court, legal domain (rechtsgebied), document type and decision-date range, paged. The source has no full-text search API; passing `query` filters client-side on each candidate\'s title and published abstract only (not the full decision text) across at most 200 of the most recently modified metadata-matching candidates — the response says when that scan was partial. Returns ECLIs that nl_rechtspraak_get_decision resolves to the full text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Text to match against each candidate decision\'s title and published abstract (case-insensitive substring). NOT a search of the full decision body.' },
        court: { type: 'string', description: 'A currently sitting Dutch court\'s name or abbreviation, e.g. "Hoge Raad", "HR", "Rechtbank Amsterdam", "RBAMS" — or an exact creator identifier URI from data.rechtspraak.nl/Waardelijst/Instanties for a discontinued court.' },
        subject: { type: 'string', description: 'A rechtsgebied (legal domain) name from the Rechtspraak taxonomy, e.g. "Civiel recht", "Arbeidsrecht", "Strafrecht" — or its exact identifier URI.' },
        type: { type: 'string', enum: ['uitspraak', 'conclusie'], description: 'Document type: "uitspraak" (judgment/ruling) or "conclusie" (advocate-general\'s opinion, Hoge Raad cassation cases only). Omit for both.' },
        date_from: { type: 'string', description: 'Decision date (uitspraakdatum) range start, ISO YYYY-MM-DD. With date_to, filters "from date_from through date_to" inclusive. Alone, filters to exactly that one date.' },
        date_to: { type: 'string', description: 'Decision date range end, ISO YYYY-MM-DD. Alone (no date_from), filters to exactly that one date.' },
        offset: { type: 'number', description: '0-based offset into the result list (default 0).' },
        limit: { type: 'number', description: 'Max results to return, 1-100 (default 20).' },
      },
    },
  },
  {
    name: 'nl_rechtspraak_get_decision',
    description:
      'Read one Dutch court decision by its ECLI (e.g. "ECLI:NL:HR:2019:2006"): full original Dutch text, court, decision date, publication date and last-modified date as separate fields, procedure, rechtsgebied(en), formal relations to other ECLIs (e.g. earlier/later instance), and any BWB statute ids the source formally links (often empty — see cited_bwb_ids_note) for chaining to nl_wetten_get_law / nl_wetten_get_article.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ecli: { type: 'string', description: 'The decision\'s ECLI, e.g. "ECLI:NL:HR:2019:2006".' },
      },
      required: ['ecli'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'nl_rechtspraak_search':
      return search(args);
    case 'nl_rechtspraak_get_decision':
      return getDecision(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
