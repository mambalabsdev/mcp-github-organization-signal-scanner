# GitHub Organization Signal Scanner MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-github-organization-signal-scanner)](https://smithery.ai/servers/mambabuilt/mcp-github-organization-signal-scanner) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-github-organization-signal-scanner/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-github-organization-signal-scanner) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-github-organization-signal-scanner%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-github-organization-signal-scanner&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-github-organization-signal-scanner)](https://www.npmjs.com/package/@mambalabsdev/mcp-github-organization-signal-scanner) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-github-organization-signal-scanner)](https://www.npmjs.com/package/@mambalabsdev/mcp-github-organization-signal-scanner) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-github-organization-signal-scanner)](https://github.com/mambalabsdev/mcp-github-organization-signal-scanner/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-github-organization-signal-scanner)

An MCP server that resolves a company domain to its GitHub organization with repo, language and activity signals. It wraps the Mamba Labs GitHub Organization Signal Scanner actor on Apify and returns a Clay-ready flat JSON row to any MCP client.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Inputs](#inputs)
- [Output](#output)
- [Example output](#example-output)
- [Features](#features)
- [Full actor documentation](#full-actor-documentation)
- [Mamba Labs GTM Suite](#mamba-labs-gtm-suite)
- [License](#license)

## What it does

Give it a company domain and it finds that company's GitHub organization and returns repository count, followers, creation date, top languages, total stars, the most recent push, how many repositories are actively worked on, and whether the company ships a public SDK. One flat row per company, read through GitHub's own documented REST API.

Forks and archived repositories are excluded from the language and star derivations, and the exclusion is counted on the row. A rate limited request reports `not_extractable` and never a zero, because a zero is a number a buyer would filter on. A login that resolves to a personal user account rather than an organization is reported as `identity_mismatch`. It reads organization and repository metadata only: it does not clone repositories, read source, scan for secrets or assess code quality.

All of the scanning runs on Apify. This package is a thin client that calls the actor and hands back the result unchanged.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "mamba-github-organization-signal-scanner": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-github-organization-signal-scanner"],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Get your token at https://console.apify.com/account/integrations, paste it in, and restart Claude Desktop. The `scan_github_organization_signals` tool will be available.

## Prerequisites

- Node.js 18 or newer
- An Apify account with an API token
- Optional: your own GitHub personal access token, free to create at github.com/settings/tokens with no scopes at all for public data, if you want to scan more than a handful of companies

## Example prompts

- "Find the GitHub organization for stripe.com and summarize its activity."
- "Scan the GitHub org `vercel` and tell me its top languages and total stars."
- "Does figma.com ship a public SDK? Check its GitHub organization."
- "Scan notion.so's GitHub org, counting a repo as active if it was pushed in the last 30 days."

## Inputs

- `company_domain` (optional): bare company domain, for example `stripe.com`. This is the lookup key and the join key for every other actor in the fleet.
- `company_name` (optional but strongly recommended): what the identity gate checks a discovered record against, so supplying it is the cheapest way to reduce wrong matches.
- `github_org` (optional): if you already know the organization login, for example `stripe`, put it here and the tool skips discovery entirely and goes straight to the API, which is faster and spends fewer rate limited requests.
- `includeRepoDetail` (optional): when true (the default) the organization repositories are read and the language, star, activity and SDK signals are derived from them. Set false to return the organization record only, which is one request instead of several and is friendlier to the unauthenticated rate limit.
- `includeContributorEstimate` (optional): when true one extra request reads the contributor count of the organization's most starred repository, as a floor on the size of its public engineering surface. False by default, because one extra request per company is real money against a 60 per hour unauthenticated budget.
- `activeWindowDays` (optional): how recently a repository must have been pushed to count as active. One of `30`, `90`, `180` or `365`, with 90 the default. This changes what active means on the row.
- `repoPageBudget` (optional): how many pages of 100 repositories to read for a large organization. One of `1`, `2`, `3` or `5`. This is a cost and completeness dial, not a change of answer: the row always reports how many repositories were sampled and whether the sample is complete.
- `githubToken` (optional): your own GitHub personal access token, free to create with no scopes at all for public data. Without it the tool runs at GitHub's 60 requests per hour, which is enough for a handful of companies and not enough for a list. With it the limit is 5,000 per hour.
- `skipCache` (optional): when false (the default) a successful lookup is cached for seven days and reused. Set true to force a fresh fetch.

## Output

The tool returns the actor's flat JSON row for the company, with 32 snake_case fields and no nested objects. `github_discovery` says how the organization was found, `github_rejected_candidate` records a candidate the identity gate turned away, `repos_sampled` and `repos_complete` say how much of the organization was read, and `repos_excluded` counts the forks and archived repositories left out. See the Apify Store page for the full output schema.

## Example output

```json
{
  "degraded": false,
  "degradation_reason": null,
  "company_domain": "stripe.com",
  "company_name": "Stripe",
  "github_org": "stripe",
  "github_url": "https://github.com/stripe",
  "github_discovery": "homepage_link",
  "github_rejected_candidate": null,
  "github_account_type": "Organization",
  "public_repos": 98,
  "followers": 3469,
  "org_created_at": "2011-06-17T15:42:37Z",
  "org_location": "San Francisco, CA",
  "top_languages": "TypeScript, Go, Ruby, JavaScript, HTML",
  "total_stars": 42821,
  "most_starred_repo": "stripe-node",
  "most_starred_repo_stars": 4485,
  "most_recent_push_at": "2026-08-22T18:33:15.000Z",
  "active_repos_90d": 56,
  "has_public_sdk": true,
  "repos_sampled": 98,
  "repos_complete": true,
  "repos_excluded": "forks=6, archived=5",
  "rate_limit_remaining": 57,
  "coverage": 1,
  "fetch_status": "ok",
  "run_date": "2026-08-22T19:23:50.177Z"
}
```

## Features

- Resolves a GitHub organization starting from a company domain
- Repository count, stars, followers and top languages
- Recent push activity and repositories active in a window you choose
- Public SDK detection, a direct developer tooling signal
- Runs keyless, with your own GitHub token available for scale
- Rejected candidates recorded in `github_rejected_candidate`
- 32 flat snake_case fields, one row per company

## Full actor documentation

This server is a thin client and holds no scanning logic. For the complete input and output reference, pricing, and run history, see the Apify Store page:

https://apify.com/mambalabs/github-organization-signal-scanner

---

## Mamba Labs GTM Suite

This server is one of the Mamba Labs GTM Suite MCP servers. Every actor in the suite takes a domain or a company and returns one flat row, so they stack in the same Clay table without reshaping anything. The actor behind this server is the GitHub Organization Signal Scanner, immutable Apify actor ID `ahF8RRpv5mzPao5CN`.

> Built by [Mamba Labs](https://github.com/mambalabsdev) | [npm](https://www.npmjs.com/org/mambalabsdev) | [Apify Store](https://apify.com/mambalabs)

## License

MIT

Built by Mamba Labs. https://apify.com/mambalabs
