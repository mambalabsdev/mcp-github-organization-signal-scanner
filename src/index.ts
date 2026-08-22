#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

const APIFY_TOKEN = process.env.APIFY_TOKEN;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor at all.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// The actor types its switches as strings ("true"/"false") for Clay
// compatibility, because Clay sends every input as a string and a boolean typed
// field silently receives "false" and reads it as truthy. The model gets a real
// boolean and the actor gets the string it validates.
function boolToString(v: boolean | undefined): string | undefined {
  return v === undefined ? undefined : v ? "true" : "false";
}

// actorPath is the actor's IMMUTABLE Apify actor id, not its slug, so a Store
// rename never breaks these calls.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  // memory=512 is deliberate and matches the actor's declared
  // defaultRunOptions.memoryMbytes. run-sync-get-dataset-items runs at 2048 MB
  // unless told otherwise, and `apify-actor-start` bills once per GB with a
  // minimum of one, so leaving the default in place would charge the caller
  // more start events per run than the actor asks for. Keep this in step with
  // the actor's defaultRunOptions.
  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300&memory=512`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message = "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Try again, or run the actor on Apify directly for longer jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  // A 2xx normally carries the dataset array. Pass actor output through
  // unchanged: the wrapper must never reinterpret a status field, because
  // not_extractable, blocked and not_found are different answers and collapsing
  // them is exactly the defect the actor was built to avoid.
  const items = await response.json();
  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-github-organization-signal-scanner",
  version: pkg.version,
});

// GitHub Organization Signal Scanner (immutable actor ID ahF8RRpv5mzPao5CN)
server.registerTool(
  "scan_github_organization_signals",
  {
    title: "Scan GitHub Organization Signals",
    description:
      "Resolve a company domain to its GitHub organization and return repository count, followers, creation date, top languages, total stars, the most recent push, how many repositories are actively worked on, and whether the company ships a public SDK. Returns one flat Clay ready row. Forks and archived repositories are excluded from the language and star derivations and the exclusion is counted on the row. A rate limited request reports not_extractable and NEVER a zero, because a zero is a number a buyer would filter on. A login that resolves to a personal user account rather than an organization is reported as identity_mismatch. Read only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Scan GitHub Organization Signals",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      company_domain: z.string()
        .optional()
        .describe("Bare company domain, for example stripe.com. This is the only required input and it is the join key for every other actor in the fleet."),
      company_name: z.string()
        .optional()
        .describe("Optional but strongly recommended. It is what the identity gate checks a discovered record against, so supplying it is the single cheapest way to reduce wrong matches."),
      github_org: z.string()
        .optional()
        .describe("Optional. If you already know the organization login, for example \"stripe\", put it here and the actor skips discovery entirely and goes straight to the API, which is faster and spends fewer of your rate limited requests."),
      includeRepoDetail: z.boolean()
        .optional()
        .describe("When \"true\" (default) the organization repositories are read and the language, star, activity and SDK signals are derived from them. Set \"false\" to return the organization record only, which is one request instead of several and is much friendlier to the unauthenticated rate limit. Sent as a string for Clay compatibility."),
      includeContributorEstimate: z.boolean()
        .optional()
        .describe("When \"true\" the actor spends one extra request to read the contributor count of the organization most starred repository, as a floor on the size of its public engineering surface. Default \"false\", because one extra request per company is real money against a 60 per hour unauthenticated budget. Sent as a string for Clay compatibility."),
      activeWindowDays: z.enum(["30", "90", "180", "365"])
        .optional()
        .describe("How recently a repository must have been pushed to count as active. 90 days by default. This changes what \"active\" means on the row, so pick the window your own definition of an engaged engineering team uses. Sent as a string for Clay compatibility."),
      repoPageBudget: z.enum(["1", "2", "3", "5"])
        .optional()
        .describe("How many pages of 100 repositories to read for a large organization. This is a cost and completeness dial, not a change of answer: the row always reports how many repositories were actually sampled and whether the sample is complete. Sent as a string for Clay compatibility."),
      githubToken: z.string()
        .optional()
        .describe("YOUR OWN GitHub personal access token, free to create at github.com/settings/tokens with no scopes at all for public data. OPTIONAL: without it the actor runs at GitHub 60 requests per hour, which is enough for a handful of companies and not enough for a list. With it the limit is 5,000 per hour. It is marked secret, so the value never renders on this page."),
      skipCache: z.boolean()
        .optional()
        .describe("When \"false\" (default) a successful lookup is cached for seven days and reused, which costs you nothing on a repeated run. Set \"true\" to force a fresh fetch. Sent as a string for Clay compatibility."),
    },
  },
  async ({ company_domain, company_name, github_org, includeRepoDetail, includeContributorEstimate, activeWindowDays, repoPageBudget, githubToken, skipCache }) => {
    return runActor(
      "ahF8RRpv5mzPao5CN",
      "GitHub Organization Signal Scanner",
      compact({
        company_domain,
        company_name,
        github_org,
        includeRepoDetail: boolToString(includeRepoDetail),
        includeContributorEstimate: boolToString(includeContributorEstimate),
        activeWindowDays,
        repoPageBudget,
        githubToken,
        skipCache: boolToString(skipCache),
      }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
