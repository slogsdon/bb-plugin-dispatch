// bb-plugin-dispatch — turn a one-liner into a scoped thread in the right project.
//
// bb can spawn a thread but requires you to have already decided both the
// project and the full prompt. That intake step is the part worth automating,
// and it is the part bb has no surface for.
//
// Two model calls, both made by spawning a hidden bb thread on the intake lane.
// Plugins cannot reach bb's internal inference — PluginHosts exposes only port
// and tunnel methods — so a thread is the only way to invoke a model the user
// has already configured. It is slower than a completion endpoint, and it is the
// only path that works on a machine that is not this one.
//
// Expansion uses a prompt enhancer template that ships with the plugin, or any
// command's stdout (e.g. an obsidian note read at run time, so there is one
// canonical copy of the prompt rather than a copy pasted in here).
//
// Safety: dispatch PREVIEWS by default and only spawns with --go. A plugin CLI
// command is non-interactive — run() returns stdout and cannot prompt — so a
// two-step invocation is the confirmation, since project classification from a
// one-liner will sometimes be wrong.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execShell = promisify(exec);

const enhancerConfig = z.object({
  source: z.enum(["text", "command"]),
  text: z.string(),
  command: z.string(),
});

const intakeResult = z.object({
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  prompt: z.string(),
  notes: z.array(z.string()),
});

/** A `NewThreadRequest` minus its `input` — every selection bb's own composer
 *  resolved, stored verbatim and spread straight back into `threads.spawn`.
 *
 *  Storing the whole request rather than a provider/model pair is what carries
 *  `executionInputSources` through. The server drops a requested
 *  `providerId`/`model` that arrives with no provenance and re-derives it from
 *  the project's stored defaults, so a hand-built spawn can silently run on a
 *  lane you did not pick. Round-tripping the composer's own request makes that
 *  structurally impossible. */
const laneSchema = z.object({
  projectId: z.string(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string().optional(),
  permissionMode: z.string().optional(),
  serviceTier: z.string().optional(),
  executionInputSources: z.record(z.string(), z.string()).optional(),
  environment: z.unknown().optional(),
});
type Lane = z.infer<typeof laneSchema>;
const LANE_KEY = "lane";

export const rpcContract = defineRpcContract({
  projects: {
    input: z.null(),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
  },
  preview: {
    input: z.object({
      request: z.string(),
      projectId: z.string().nullable().optional(),
      raw: z.boolean().optional(),
    }),
    output: intakeResult,
  },
  dispatch: {
    input: z.object({
      request: z.string(),
      projectId: z.string().nullable().optional(),
      raw: z.boolean().optional(),
    }),
    output: intakeResult.extend({ threadId: z.string() }),
  },
  getEnhancer: { input: z.null(), output: enhancerConfig },
  setEnhancer: { input: enhancerConfig, output: enhancerConfig },
  getLane: { input: z.null(), output: laneSchema.nullable() },
  setLane: { input: laneSchema, output: laneSchema },
});

type Project = { id: string; name: string; path?: string | null };

/** Bundled default so a fresh install works with no vault and no setup.
 *  $ARGUMENTS is replaced with the request. */
const DEFAULT_ENHANCER = `You are a prompt engineer with one job: take the prompt provided and return a significantly upgraded version of it.

Diagnose it first (internally, do not output this):
- Is the goal vague or ambiguous?
- Is it over-specified and brittle?
- Does it expect a one-shot answer when iteration would serve better?
- Is there no mechanism for self-critique or quality checking?
- Is state/context missing that the model would need to not restart from scratch?

Then apply only the fixes that are warranted:

1. SHARPEN THE GOAL — make it concrete, specific, and testable. Add success criteria if absent.
2. INJECT STATE STRUCTURE — add explicit tracking of goal, constraints, and known context where relevant.
3. BUILD IN ITERATION — replace one-shot answer expectations with plan -> act -> evaluate -> next step framing where appropriate.
4. ADD A CRITIC LAYER — instruct the model to find failure points and fix them before presenting output.
5. DECOMPOSE ROLES if the task is complex — Architect / Builder / Auditor. Skip this for simple, single-domain prompts.

Hard rules:
- Do NOT change the fundamental intent of the original prompt
- Do NOT add length that doesn't add precision
- Do NOT apply patterns that don't fit — not every prompt needs all five fixes
- Strip anything vague or redundant from the original

Output only the upgraded prompt inside a code block, ready to use.

Prompt to upgrade:
$ARGUMENTS`;

type EnhancerConfig = { source: "text" | "command"; text: string; command: string };
const ENHANCER_KEY = "enhancer";
const DEFAULT_ENHANCER_CONFIG: EnhancerConfig = {
  source: "text",
  text: DEFAULT_ENHANCER,
  command: "",
};


/** Resolve the enhancer template from configuration.
 *
 *  Two sources. "text" is a literal template edited in the Dispatch panel and is
 *  the default, so a fresh install works with no vault and no external tooling.
 *  "command" shells out and uses stdout, which is how a template that already
 *  lives somewhere else gets reused rather than copied — e.g.
 *  `obsidian read path="Prompts/Enhancer.md"`.
 *
 *  The command runs through a shell because it is a user-authored command line.
 *  That is the same trust level as the rest of the plugin (full-trust code on
 *  your own machine), but it is worth knowing it is not sandboxed.
 *
 *  Either way the template must contain $ARGUMENTS; without it there is nowhere
 *  to put the request, so expansion is skipped rather than sending a malformed
 *  prompt. */
async function loadEnhancer(cfg: EnhancerConfig): Promise<string | null> {
  let body = cfg.text;
  if (cfg.source === "command") {
    if (!cfg.command.trim()) return null;
    try {
      const { stdout } = await execShell(cfg.command, { timeout: 20_000 });
      // Tolerate a fenced template: some notes wrap the prompt in ~~~ or ```.
      const fenced = stdout.match(/(?:~~~|```)[a-z]*\s*\n([\s\S]*?)\n(?:~~~|```)/);
      body = (fenced ? fenced[1] : stdout).trim();
    } catch {
      return null;
    }
  }
  return body.includes("$ARGUMENTS") ? body : null;
}


/** One-shot completion by spawning a hidden bb thread.
 *
 *  Works for any bb user on any provider they have configured, with no proxy and
 *  no API key of its own. An earlier version could instead POST to an
 *  OpenAI-compatible proxy, which was faster and could *force* JSON through
 *  `response_format` where an agent can only be asked — but it was a second code
 *  path that only ran on a machine with LiteLLM in front of it, and it carried
 *  four settings to configure something most installs could never use.
 *
 *  So the cost of this path is accepted rather than worked around: an agent
 *  thread has tools and a personality, so the prompts forbid both and the caller
 *  parses tolerantly.
 *
 *  Threads are hidden so they never appear in the sidebar, and archived after the
 *  answer is read so intake does not litter the project. */
async function completeViaThread(
  bb: BbPluginApi, lane: Lane, prompt: string,
): Promise<string> {
  // Spread the stored request verbatim: project, provider, model, reasoning,
  // permission, environment, and the provenance that keeps the first two from
  // being re-derived from project defaults.
  const spawned: any = await bb.sdk.threads.spawn({
    ...lane,
    prompt,
    visibility: "hidden",
  } as any);
  const threadId: string = spawned?.thread?.id ?? spawned?.id ?? "";
  if (!threadId) throw new Error("intake thread did not start");
  try {
    await bb.sdk.threads.wait({ threadId, status: "idle", timeoutMs: 180_000 } as any);
    const out: any = await bb.sdk.threads.output({ threadId } as any);
    const text = (typeof out === "string" ? out : out?.output ?? out?.text ?? "").trim();
    if (!text) throw new Error("intake thread produced no output");
    return text;
  } finally {
    // Archive, not delete: delete is a destructive action bb refuses without an
    // interactive confirmation, so it failed silently and leaked hidden threads
    // until this was caught. Archived + hidden is invisible and recoverable.
    // Log the failure rather than swallowing it — a silent cleanup failure is
    // how the leak went unnoticed in the first place.
    try {
      await bb.sdk.threads.archive({ threadId } as any);
    } catch (err) {
      bb.log.warn(`intake thread ${threadId} left behind: ${(err as Error).message}`);
    }
  }
}

/** Ask the intake lane for one answer.
 *
 *  Agent threads narrate unless told not to, and there is no `response_format`
 *  to lean on here, so the JSON ask is reinforced in the prompt itself and the
 *  caller parses tolerantly. */
async function complete(
  bb: BbPluginApi, lane: Lane, prompt: string, json: boolean,
): Promise<string> {
  const guarded = json
    ? `${prompt}\n\nReply with the JSON object only. No preamble, no explanation, no tool use.`
    : `${prompt}\n\nReturn only the requested output. Do not use tools. Do not add commentary.`;
  return completeViaThread(bb, lane, guarded);
}

function classifyPrompt(oneLiner: string, projects: Project[]): string {
  const list = projects
    .map((p) => `- id: ${p.id}\n  name: ${p.name}${p.path ? `\n  path: ${p.path}` : ""}`)
    .join("\n");
  return `Pick which project this request belongs to.

Projects:
${list}

Request: ${oneLiner}

Reply with JSON only: {"projectId": "<id>", "confidence": <0-1>, "reason": "<10 words max>"}
Use the exact id string. If genuinely unclear, pick the closest and set confidence below 0.5.`;
}

function stripFence(s: string): string {
  const m = s.match(/```(?:[a-z]*)\n([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}


/** The host a dispatched thread runs on. `workspace.type: "unmanaged"` requires
 *  an explicit hostId — only `personal` may omit it. One machine today, so the
 *  first connected host is the answer; this picks it dynamically rather than
 *  hardcoding an id that would break on re-enrolment. */
async function defaultHostId(bb: BbPluginApi): Promise<string> {
  const res: any = await bb.sdk.hosts.list();
  const rows = res?.machines ?? res?.hosts ?? res ?? [];
  const connected = rows.find((h: any) => h.status === "connected") ?? rows[0];
  if (!connected?.id) throw new Error("no connected bb host to dispatch to");
  return connected.id;
}


type Intake = {
  projectId: string | null;
  projectName: string | null;
  prompt: string;
  notes: string[];
};

/** The whole intake pipeline: pick a project, expand the prompt. Shared by the
 *  CLI and the nav panel so both degrade identically — there is one code path
 *  that decides where work goes. */
async function intake(
  bb: BbPluginApi,
  lane: Lane | null,
  request: string,
  opts: { projectId?: string | null; raw?: boolean },
): Promise<Intake> {
  const res: any = await bb.sdk.projects.list({ includePersonal: true } as any);
  const projects: Project[] = (res?.projects ?? res ?? []).map((p: any) => ({
    id: p.id, name: p.name, path: p.sources?.[0]?.path ?? null,
  }));

  const notes: string[] = [];
  let projectId: string | null = opts.projectId ?? null;
  let prompt = request;

  if (!lane) {
    notes.push("no intake lane set (Settings -> Plugins -> Dispatch) — intake skipped");
  }

  if (!projectId && lane) {
    try {
      const raw = await complete(bb, lane, classifyPrompt(request, projects), true);
      const parsed = JSON.parse(stripFence(raw));
      if (projects.some((p) => p.id === parsed.projectId)) {
        projectId = parsed.projectId;
        notes.push(`classified: ${parsed.reason} (confidence ${parsed.confidence})`);
        if (Number(parsed.confidence) < 0.5) notes.push("LOW CONFIDENCE — check the project before dispatching");
      } else {
        notes.push(`classifier returned an unknown id (${parsed.projectId}) — ignored`);
      }
    } catch (err) {
      notes.push(`classification failed (${(err as Error).message}) — choose a project`);
    }
  }

  if (!opts.raw && lane) {
    const stored = (await bb.storage.kv.get<EnhancerConfig>(ENHANCER_KEY)) ?? DEFAULT_ENHANCER_CONFIG;
    const template = await loadEnhancer(stored);
    if (!template) {
      notes.push("enhancer unavailable (command failed, or template has no $ARGUMENTS) — using the request as written");
    } else {
      try {
        prompt = stripFence(await complete(bb, lane, template.replace("$ARGUMENTS", request), false));
        notes.push("expanded via Prompt Enhancer");
      } catch (err) {
        notes.push(`expansion failed (${(err as Error).message}) — using the request as written`);
      }
    }
  }

  const target = projects.find((p) => p.id === projectId);
  return { projectId, projectName: target?.name ?? null, prompt, notes };
}

async function spawnThread(bb: BbPluginApi, projectId: string, prompt: string): Promise<string> {
  const spawned: any = await bb.sdk.threads.spawn({
    projectId,
    prompt,
    environment: {
      type: "host",
      hostId: await defaultHostId(bb),
      workspace: { type: "unmanaged", path: null },
    },
  } as any);
  return spawned?.thread?.id ?? spawned?.id ?? "";
}


type DiscoveredRepo = {
  name: string;
  path: string;
  originUrl?: string | null;
  lastActivityAt?: string | null;
  agentSeen?: boolean;
};

/** Repos bb has found on this host, registered or not.
 *
 *  bb computes this for first-run onboarding; it is equally the answer to "what
 *  could I be dispatching to that I have not told bb about". `agentSeen` is the
 *  useful ranking signal — a repo an agent has already worked in is far likelier
 *  to want dispatching than a dormant clone.
 *
 *  Host-only: nothing here reaches GitHub for repos that are not cloned, and
 *  those would not be dispatchable anyway since bb needs a local checkout. */
async function discoverRepos(bb: BbPluginApi): Promise<DiscoveredRepo[]> {
  const res: any = await bb.sdk.system.onboardingRepos();
  return (res?.repos ?? res ?? []) as DiscoveredRepo[];
}


export default async function plugin(bb: BbPluginApi) {
  // No `bb.settings.define` at all. Everything intake needs — project, provider,
  // model, reasoning, permission, environment — is one lane, and it is picked
  // with bb's own new-thread composer in the settings section rather than typed
  // into descriptors: `pi` alone publishes 373 models, so a `select` would be
  // worse than free text, and the composer is the only host-owned picker the SDK
  // exports. It lives in kv because a plugin can read its settings but not write
  // them.
  const loadLane = async () => (await bb.storage.kv.get<Lane>(LANE_KEY)) ?? null;

  bb.rpc.register(rpcContract, {
    projects: async () => {
      const res: any = await bb.sdk.projects.list({ includePersonal: true } as any);
      const rows: Project[] = res?.projects ?? res ?? [];
      return rows.map((p) => ({ id: p.id, name: p.name }));
    },
    preview: async ({ request, projectId, raw }) =>
      intake(bb, await loadLane(), request, { projectId, raw }),
    getEnhancer: async () =>
      (await bb.storage.kv.get<EnhancerConfig>(ENHANCER_KEY)) ?? DEFAULT_ENHANCER_CONFIG,
    setEnhancer: async (next) => {
      await bb.storage.kv.set(ENHANCER_KEY, next);
      return next;
    },
    getLane: loadLane,
    setLane: async (next) => {
      await bb.storage.kv.set(LANE_KEY, next);
      return next;
    },
    dispatch: async ({ request, projectId, raw }) => {
      const result = await intake(bb, await loadLane(), request, { projectId, raw });
      if (!result.projectId) throw new Error("no project resolved — choose one");
      const threadId = await spawnThread(bb, result.projectId, result.prompt);
      return { ...result, threadId };
    },
  });

  bb.cli.register({
    name: "dispatch",
    summary: "Expand a one-liner and route it to the right project",
    // Metadata names must match [a-z0-9-]+, so the flags are documented in
    // `usage` rather than as pseudo-subcommands.
    commands: [
      {
        name: "preview",
        summary: "Show the resolved project and expanded prompt without spawning",
        usage: 'bb dispatch "fix the flaky auth test"',
      },
      {
        name: "projects",
        summary: "List host repos that are not bb projects, and register them",
        usage: "bb dispatch projects [--register <name,name|all>]",
      },
      {
        name: "lane",
        summary: "Show or set the intake lane (the settings composer, headless)",
        usage: "bb dispatch lane [--provider <id> --model <id> --project <id>]",
      },
      {
        name: "enhancer",
        summary: "Show or set the prompt enhancer (the panel's editor, headless)",
        usage: 'bb dispatch enhancer [--command \'obsidian read path="X.md"\' | --source text]',
      },
      {
        name: "go",
        summary: "Spawn the thread (--project to skip classification, --raw to skip expansion)",
        usage: 'bb dispatch "<request>" [--project <id>] [--raw] --go',
      },
    ],
    async run(argv) {
      // `enhancer` configures what the panel's editor edits. The template lives
      // in kv rather than plugin settings (bb settings have no multiline type),
      // so without this there is no way to set it on a headless machine.
      // `projects` surfaces repos bb has discovered on this host that are not
      // registered projects. Dispatch can only route to registered projects, so
      // an unregistered repo is invisible to the classifier — it will confidently
      // pick the nearest registered project instead. This is the discovery half
      // of routing fidelity, distinct from classifying among what already exists.
      if (argv[0] === "projects") {
        const rest = argv.slice(1);
        const regIdx = rest.indexOf("--register");
        const discovered = await discoverRepos(bb);
        const res: any = await bb.sdk.projects.list({ includePersonal: true } as any);
        const rows: any[] = res?.projects ?? res ?? [];
        const known = new Set<string>();
        for (const p of rows) for (const src of p.sources ?? []) if (src?.path) known.add(src.path);
        const missing = discovered.filter((r) => !known.has(r.path));

        if (regIdx < 0) {
          if (!missing.length) return { exitCode: 0, stdout: "every discovered repo is already a project" };
          const lines = missing.map((r) => {
            const seen = r.agentSeen ? "  agent seen" : "";
            // lastActivityAt is an ISO string, not epoch millis — Number() on it
            // yields NaN and toISOString then throws "Invalid time value".
            const parsed = r.lastActivityAt ? new Date(r.lastActivityAt) : null;
            const when =
              parsed && !Number.isNaN(parsed.getTime())
                ? parsed.toISOString().slice(0, 10)
                : "?";
            return `  ${r.name.padEnd(28)} ${r.path.replace(process.env.HOME ?? "", "~")}  (${when})${seen}`;
          });
          return {
            exitCode: 0,
            stdout:
              `${missing.length} repo(s) on this host are not bb projects:\n${lines.join("\n")}\n\n` +
              `register with: bb dispatch projects --register <name>[,<name>...]  (or --register all)`,
          };
        }

        const wanted = (rest[regIdx + 1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        if (!wanted.length) return { exitCode: 1, stderr: "--register needs a comma-separated list, or 'all'" };
        const pick = wanted.includes("all")
          ? missing
          : missing.filter((r) => wanted.includes(r.name) || wanted.includes(r.path));
        if (!pick.length) return { exitCode: 1, stderr: "nothing matched; run without --register to list" };

        const hostId = await defaultHostId(bb);
        const done: string[] = [];
        for (const r of pick) {
          try {
            // createProjectRequestSchema nests the location: { name, source: { hostId,
            // type: "local_path", path } }. A flat {name, path, hostId} fails with a
            // bare "HTTP 400: Required".
            await bb.sdk.projects.create({
              name: r.name,
              source: { hostId, type: "local_path", path: r.path },
            } as any);
            done.push(`registered ${r.name}`);
          } catch (err) {
            done.push(`FAILED ${r.name}: ${(err as Error).message}`);
          }
        }
        const failed = done.some((d) => d.startsWith("FAILED"));
        return { exitCode: failed ? 1 : 0, stdout: done.join("\n") };
      }

      // The headless counterpart to the settings composer. The composer resolves
      // environment and provenance itself; here they are synthesised, since a
      // shell has no picker to resolve them from.
      if (argv[0] === "lane") {
        const rest = argv.slice(1);
        const flag = (name: string) => {
          const i = rest.indexOf(`--${name}`);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        const providerId = flag("provider");
        const model = flag("model");
        const projectId = flag("project");
        if (!providerId && !model && !projectId) {
          const cur = await bb.storage.kv.get<Lane>(LANE_KEY);
          return {
            exitCode: cur ? 0 : 1,
            stdout: cur
              ? `project:  ${cur.projectId}\nprovider: ${cur.providerId}\nmodel:    ${cur.model}`
              : "no intake lane set",
          };
        }
        if (!providerId || !model || !projectId) {
          return { exitCode: 1, stderr: "--provider, --model, and --project are all required" };
        }
        const next: Lane = {
          projectId,
          providerId,
          model,
          // Without provenance the server drops providerId/model and re-derives
          // them from the project's defaults, silently running intake elsewhere.
          executionInputSources: { providerId: "explicit", model: "explicit" },
          environment: {
            type: "host",
            hostId: await defaultHostId(bb),
            workspace: { type: "unmanaged", path: null },
          },
        };
        await bb.storage.kv.set(LANE_KEY, next);
        return { exitCode: 0, stdout: `intake lane set: ${providerId} / ${model} in ${projectId}` };
      }

      if (argv[0] === "enhancer") {
        const rest = argv.slice(1);
        const current =
          (await bb.storage.kv.get<EnhancerConfig>(ENHANCER_KEY)) ?? DEFAULT_ENHANCER_CONFIG;
        const cmdIdx = rest.indexOf("--command");
        const srcIdx = rest.indexOf("--source");
        if (cmdIdx < 0 && srcIdx < 0) {
          const body = current.source === "command" ? current.command : current.text;
          return { exitCode: 0, stdout: `source: ${current.source}\n\n${body}` };
        }
        const next: EnhancerConfig = { ...current };
        if (cmdIdx >= 0) {
          next.command = rest[cmdIdx + 1] ?? "";
          next.source = "command";
        }
        if (srcIdx >= 0) {
          const v = rest[srcIdx + 1];
          if (v !== "text" && v !== "command") {
            return { exitCode: 1, stderr: "--source must be text or command" };
          }
          next.source = v;
        }
        await bb.storage.kv.set(ENHANCER_KEY, next);
        // Resolve it immediately: a command that cannot produce a usable
        // template should fail here, not silently at the next dispatch.
        const check = await loadEnhancer(next);
        return {
          exitCode: check ? 0 : 1,
          stdout: `source: ${next.source}\n` +
            (check
              ? `resolves OK (${check.length} chars)`
              : "DOES NOT RESOLVE — command failed, or template has no $ARGUMENTS"),
        };
      }

      if (argv[0] === "preview" || argv[0] === "go") {
        if (argv[0] === "go") argv = [...argv.slice(1), "--go"];
        else argv = argv.slice(1);
      }
      const flags = new Set(argv.filter((a) => a.startsWith("--")));
      const projectIdx = argv.indexOf("--project");
      // Guard the index: with no --project, projectIdx is -1 and projectIdx + 1
      // is 0, which would silently swallow the first token of the request.
      const valueIdx = projectIdx >= 0 ? projectIdx + 1 : -1;
      const request = argv
        .filter((a, i) => !a.startsWith("--") && i !== valueIdx)
        .join(" ")
        .trim();
      if (!request) return { exitCode: 1, stderr: 'usage: bb dispatch "<request>" [--project <id>] [--raw] [--go]' };

      const result = await intake(bb, await loadLane(), request, {
        projectId: projectIdx >= 0 ? argv[valueIdx] : null,
        raw: flags.has("--raw"),
      });
      const header = [
        `request:  ${request}`,
        `project:  ${result.projectName ? `${result.projectName} (${result.projectId})` : "UNRESOLVED — pass --project"}`,
        ...result.notes.map((n) => `note:     ${n}`),
        "",
        "prompt:",
        result.prompt,
      ].join("\n");

      if (!flags.has("--go")) {
        return { exitCode: 0, stdout: `${header}\n\n(preview — re-run with --go to spawn)` };
      }
      if (!result.projectId) {
        return { exitCode: 1, stdout: header, stderr: "\nno project resolved; pass --project <id>" };
      }
      const threadId = await spawnThread(bb, result.projectId, result.prompt);
      return { exitCode: 0, stdout: `${header}\n\nspawned: ${threadId}` };
    },
  });

  bb.log.info("dispatch ready");
}
