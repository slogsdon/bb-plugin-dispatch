// bb-plugin-dispatch — turn a one-liner into a scoped thread in the right project.
//
// bb can spawn a thread but requires you to have already decided both the
// project and the full prompt. That intake step is the part worth automating,
// and it is the part bb has no surface for.
//
// Two model calls, both on the LiteLLM proxy rather than bb's internal
// inference (which plugins cannot reach — PluginHosts exposes only port/tunnel
// methods). Routing through LiteLLM is the better trade anyway: the lane is
// explicit and swappable in models.yaml, every call is traced in Langfuse, and
// intake runs on the Go lane so it costs no Claude quota.
//
// Expansion uses Shane's own "Prompt Enhancer" vault note, read at run time
// through the obsidian CLI rather than copied here. Editing the note changes
// dispatch; there is one canonical copy of that prompt.
//
// Safety: dispatch PREVIEWS by default and only spawns with --go. A plugin CLI
// command is non-interactive — run() returns stdout and cannot prompt — so a
// two-step invocation is the confirmation, since project classification from a
// one-liner will sometimes be wrong.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);

const intakeResult = z.object({
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  prompt: z.string(),
  notes: z.array(z.string()),
});

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
});

type Project = { id: string; name: string; path?: string | null };

/** The enhancer lives in the vault. Read it through the CLI — never by path;
 *  vault files are off-limits to direct reads by standing rule. */
async function loadEnhancer(note: string): Promise<string | null> {
  try {
    const { stdout } = await run("obsidian", ["read", `file=${note}`], { timeout: 20_000 });
    // The note wraps the template in ~~~ fences; take what is between them.
    const fenced = stdout.match(/~~~\s*\n([\s\S]*?)\n~~~/);
    const body = (fenced ? fenced[1] : stdout).trim();
    return body.includes("$ARGUMENTS") ? body : null;
  } catch {
    return null;
  }
}

async function complete(
  base: string, key: string, model: string, prompt: string, json: boolean,
): Promise<string> {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      // Generous budget on purpose: every Zen Go model is a reasoning model and
      // spends max_tokens on reasoning before emitting content, so a small cap
      // returns HTTP 200 with an empty string rather than an error.
      max_tokens: 1600,
      messages: [{ role: "user", content: prompt }],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`LiteLLM HTTP ${res.status}`);
  const data: any = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("LiteLLM returned empty content");
  return text.trim();
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
  cfg: { litellmUrl: string; litellmKey: string; model: string; enhancerNote: string },
  request: string,
  opts: { projectId?: string | null; raw?: boolean },
): Promise<Intake> {
  const { litellmUrl: base, litellmKey: key, model } = cfg;
  const res: any = await bb.sdk.projects.list({ includePersonal: true } as any);
  const projects: Project[] = (res?.projects ?? res ?? []).map((p: any) => ({
    id: p.id, name: p.name, path: p.sources?.[0]?.path ?? null,
  }));

  const notes: string[] = [];
  let projectId: string | null = opts.projectId ?? null;
  let prompt = request;

  if (!key) notes.push("no LiteLLM key configured — intake skipped");

  if (!projectId && key) {
    try {
      const raw = await complete(base, key, model, classifyPrompt(request, projects), true);
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

  if (!opts.raw && key) {
    const template = await loadEnhancer(cfg.enhancerNote);
    if (!template) {
      notes.push("enhancer note unreadable (is Obsidian running?) — using the request as written");
    } else {
      try {
        prompt = stripFence(await complete(base, key, model, template.replace("$ARGUMENTS", request), false));
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

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    litellmUrl: { type: "string", label: "LiteLLM base URL", default: "http://localhost:4000/v1" },
    litellmKey: { type: "string", label: "LiteLLM master key", secret: true },
    model: { type: "string", label: "Intake model (alias)", default: "bulk-primary" },
    enhancerNote: { type: "string", label: "Prompt Enhancer note", default: "Prompt Enhancer" },
  });

  const readCfg = async () => {
    const c = await settings.get();
    return {
      litellmUrl: String(c.litellmUrl),
      litellmKey: String(c.litellmKey ?? ""),
      model: String(c.model),
      enhancerNote: String(c.enhancerNote),
    };
  };

  bb.rpc.register(rpcContract, {
    projects: async () => {
      const res: any = await bb.sdk.projects.list({ includePersonal: true } as any);
      const rows: Project[] = res?.projects ?? res ?? [];
      return rows.map((p) => ({ id: p.id, name: p.name }));
    },
    preview: async ({ request, projectId, raw }) =>
      intake(bb, await readCfg(), request, { projectId, raw }),
    dispatch: async ({ request, projectId, raw }) => {
      const result = await intake(bb, await readCfg(), request, { projectId, raw });
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
        name: "go",
        summary: "Spawn the thread (--project to skip classification, --raw to skip expansion)",
        usage: 'bb dispatch "<request>" [--project <id>] [--raw] --go',
      },
    ],
    async run(argv) {
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

      const result = await intake(bb, await readCfg(), request, {
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
