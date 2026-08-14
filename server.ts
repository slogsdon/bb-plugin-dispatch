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

export const rpcContract = defineRpcContract({
  projects: {
    input: z.null(),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
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

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    litellmUrl: { type: "string", label: "LiteLLM base URL", default: "http://localhost:4000/v1" },
    litellmKey: { type: "string", label: "LiteLLM master key", secret: true },
    model: { type: "string", label: "Intake model (alias)", default: "bulk-primary" },
    enhancerNote: { type: "string", label: "Prompt Enhancer note", default: "Prompt Enhancer" },
  });

  bb.rpc.register(rpcContract, {
    projects: async () => {
      const res: any = await bb.sdk.projects.list({ includePersonal: true } as any);
      const rows: Project[] = res?.projects ?? res ?? [];
      return rows.map((p) => ({ id: p.id, name: p.name }));
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
      // Tolerate a leading verb so `bb dispatch preview "..."` and
      // `bb dispatch "..."` behave the same.
      if (argv[0] === "preview" || argv[0] === "go") {
        if (argv[0] === "go") argv = [...argv.slice(1), "--go"];
        else argv = argv.slice(1);
      }
      const flags = new Set(argv.filter((a) => a.startsWith("--")));
      const projectIdx = argv.indexOf("--project");
      const forcedProject = projectIdx >= 0 ? argv[projectIdx + 1] : undefined;
      // Guard the index: with no --project, projectIdx is -1 and projectIdx + 1
      // is 0, which would silently swallow the first token of the request.
      const valueIdx = projectIdx >= 0 ? projectIdx + 1 : -1;
      const request = argv
        .filter((a, i) => !a.startsWith("--") && i !== valueIdx)
        .join(" ")
        .trim();
      if (!request) return { exitCode: 1, stderr: 'usage: bb dispatch "<request>" [--project <id>] [--raw] [--go]' };

      const cfg = await settings.get();
      const base = String(cfg.litellmUrl);
      const key = String(cfg.litellmKey ?? "");
      const model = String(cfg.model);

      const res: any = await bb.sdk.projects.list({ includePersonal: true } as any);
      const projects: Project[] = (res?.projects ?? res ?? []).map((p: any) => ({
        id: p.id, name: p.name, path: p.sources?.[0]?.path ?? null,
      }));

      const notes: string[] = [];
      let projectId = forcedProject;
      let prompt = request;

      // Intake is best-effort. When LiteLLM or the vault is unavailable the
      // fallback is exactly what bb does natively: the raw text, to a project
      // named explicitly. Degraded, never silently wrong.
      if (!key) notes.push("no LiteLLM key configured — intake skipped");

      if (!projectId && key) {
        try {
          const raw = await complete(base, key, model, classifyPrompt(request, projects), true);
          const parsed = JSON.parse(stripFence(raw));
          if (projects.some((p) => p.id === parsed.projectId)) {
            projectId = parsed.projectId;
            notes.push(`classified: ${parsed.reason} (confidence ${parsed.confidence})`);
            if (Number(parsed.confidence) < 0.5) notes.push("LOW CONFIDENCE — check the project before --go");
          } else {
            notes.push(`classifier returned an unknown id (${parsed.projectId}) — ignored`);
          }
        } catch (err) {
          notes.push(`classification failed (${(err as Error).message}) — pass --project`);
        }
      }

      if (!flags.has("--raw") && key) {
        const template = await loadEnhancer(String(cfg.enhancerNote));
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
      const header = [
        `request:  ${request}`,
        `project:  ${target ? `${target.name} (${target.id})` : "UNRESOLVED — pass --project"}`,
        ...notes.map((n) => `note:     ${n}`),
        "",
        "prompt:",
        prompt,
      ].join("\n");

      if (!flags.has("--go")) {
        return { exitCode: 0, stdout: `${header}\n\n(preview — re-run with --go to spawn)` };
      }
      if (!projectId) {
        return { exitCode: 1, stdout: header, stderr: "\nno project resolved; pass --project <id>" };
      }
      // `environment` is required by createThreadRequestSchema — omitting it
      // fails with a bare "HTTP 400: Required". `host` + `unmanaged` with a null
      // path means "the project's own checkout on the default machine", which is
      // what dispatch wants: work in the repo, not an isolated worktree.
      const spawned: any = await bb.sdk.threads.spawn({
        projectId,
        prompt,
        environment: {
          type: "host",
          hostId: await defaultHostId(bb),
          workspace: { type: "unmanaged", path: null },
        },
      } as any);
      const id = spawned?.thread?.id ?? spawned?.id ?? "(unknown)";
      return { exitCode: 0, stdout: `${header}\n\nspawned: ${id}` };
    },
  });

  bb.log.info("dispatch ready");
}
