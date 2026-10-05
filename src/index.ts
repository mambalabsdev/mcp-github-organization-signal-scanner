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

// How long the actor run itself is allowed to take, in seconds. 300 s is the
// run timeout this wrapper has always set (it was the run-sync timeout), kept
// so a run costs the caller no more than it did before. The difference is that
// the wrapper now waits for the run's own terminal status instead of an HTTP
// 408 that arrived while the run kept going and kept billing.
const ACTOR_RUN_TIMEOUT_SECS = 300;

// memory=512 matches the actor's declared defaultRunOptions.memoryMbytes and
// is pinned so the run starts at the size the actor asks for: `apify-actor-start`
// bills once per GB with a minimum of one. Keep this in step with the actor.
const ACTOR_RUN_MEMORY_MBYTES = 512;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}&memory=${ACTOR_RUN_MEMORY_MBYTES}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

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
        .describe("When true (default) the organization repositories are read and the language, star, activity and SDK signals are derived from them. Set false to return the organization record only, which is one request instead of several and is much friendlier to the unauthenticated rate limit."),
      includeContributorEstimate: z.boolean()
        .optional()
        .describe("When true the actor spends one extra request to read the contributor count of the organization most starred repository, as a floor on the size of its public engineering surface. Default false, because one extra request per company is real money against a 60 per hour unauthenticated budget."),
      activeWindowDays: z.enum(["30", "90", "180", "365"])
        .optional()
        .describe("How recently a repository must have been pushed to count as active. 90 days by default. This changes what \"active\" means on the row, so pick the window your own definition of an engaged engineering team uses."),
      repoPageBudget: z.enum(["1", "2", "3", "5"])
        .optional()
        .describe("How many pages of 100 repositories to read for a large organization. This is a cost and completeness dial, not a change of answer: the row always reports how many repositories were actually sampled and whether the sample is complete."),
      githubToken: z.string()
        .optional()
        .describe("YOUR OWN GitHub personal access token, free to create at github.com/settings/tokens with no scopes at all for public data. OPTIONAL: without it the actor runs at GitHub 60 requests per hour, which is enough for a handful of companies and not enough for a list. With it the limit is 5,000 per hour. A token passed here travels in the tool call and stays in the chat transcript, so prefer setting GITHUB_TOKEN in this server's environment: when this argument is omitted the server sends that variable instead."),
      skipCache: z.boolean()
        .optional()
        .describe("When false (default) a successful lookup is cached for seven days and reused, which costs you nothing on a repeated run. Set true to force a fresh fetch."),
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
        githubToken: githubToken ?? process.env.GITHUB_TOKEN,
        skipCache: boolToString(skipCache),
      }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
