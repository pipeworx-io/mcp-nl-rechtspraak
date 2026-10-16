# @pipeworx/nl-rechtspraak

Dutch court decisions (uitspraken en conclusies): search by court, legal
domain and decision date, resolve by ECLI, and read the full original Dutch
text. Separate from `@pipeworx/nl-wetten`, which covers statutes — this pack
is case law.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1819+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `nl_rechtspraak_search(query?, court?, subject?, type?, date_from?, date_to?, offset?, limit?)`
  — search Dutch court decisions by court, legal domain (rechtsgebied),
  document type and decision-date range, paged. `query` is a client-side
  substring match against each candidate's title and published abstract
  (summary) only — the source has no full-text search API — scanned across
  at most 200 of the most recently modified metadata-matching candidates;
  the response says plainly when that scan was partial. Returns ECLIs that
  `nl_rechtspraak_get_decision` resolves to the full text.
- `nl_rechtspraak_get_decision(ecli)` — one decision's full original Dutch
  text, court, decision date, publication date and last-modified date as
  three separate fields, procedure, rechtsgebied(en), formal relations to
  other ECLIs (e.g. the earlier instance this is an appeal of), and any BWB
  statute ids the source formally links (`cited_bwb_ids` — often empty; see
  Notes) for chaining to `nl_wetten_get_law` / `nl_wetten_get_article`.

## Auth

Keyless.

## Data sources

- Raad voor de Rechtspraak, Open Data van de Rechtspraak — every Dutch court
  decision that has been assigned an ECLI (European Case Law Identifier),
  with its full text where published.

## Notes

- **Search is metadata, not full-text.** The source's search service filters
  by court, legal domain, document type and date — confirmed by probing
  several candidate free-text parameter names against it; none changed the
  result count. `query` is Pipeworx's own client-side filter over the title
  and published abstract of the metadata-matching candidates, not a search of
  the complete decision body. A term that only appears deep in the court's
  reasoning will not match.
- **Three dates, never collapsed:** `decision_date` (uitspraakdatum — when
  the court decided), `publication_date` (issued — when rechtspraak.nl
  published it, which can be years later or never for older cases) and
  `last_modified` (the record's own last metadata/text change) are three
  separate fields in the source and three separate fields here.
- **BWB statute citations are rarely structured.** The source schema has a
  documented field for linking a decision to the specific law it cites
  (`dcterms:references`, with a `bwb:` identifier prefix), but sampling
  recent Hoge Raad decisions found it populated in none of them — courts
  cite legislation by name in the prose, not as a machine-linked identifier.
  `cited_bwb_ids` reads that field when present and falls back to scanning
  the raw document for a literal BWB id string; an empty result means the
  source did not formally link a statute, not that the decision cites none.
  Look the law up by name with `nl_wetten_search` instead, then chain to
  `nl_wetten_get_article`.
- **`court` and `subject` take a name or the exact source identifier URI.**
  The underlying API only accepts the full OWMS/PSI identifier URI for both
  parameters — "Hoge Raad" alone is rejected by the upstream. This pack
  resolves the ~26 currently sitting Dutch courts and the full rechtsgebied
  taxonomy by name (e.g. "HR", "Rechtbank Amsterdam", "Civiel recht",
  "Arbeidsrecht"); a discontinued court (of the 261 the source has ever
  issued decisions under) still works if you pass its identifier URI
  directly.
- Search titles come back from the source as one fixed-shape string
  (`ECLI, court, DD-MM-YYYY, case number(s)`); this pack parses court, date
  and case number out of it into separate fields. The rare entry that
  doesn't match that shape comes back with `title_parsed: false` and the raw
  title only — never a silently wrong date.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nl-rechtspraak": {
      "url": "https://gateway.pipeworx.io/nl-rechtspraak/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/nl-rechtspraak/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1819+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nl_rechtspraak_search \
  -H 'Content-Type: application/json' \
  -d '{"court":"HR","subject":"Civiel recht","date_from":"2019-12-19","date_to":"2019-12-21","query":"klimaat"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nl_rechtspraak_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "nl-rechtspraak": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-nl-rechtspraak"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-nl-rechtspraak
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Nl Rechtspraak data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
