# bb-plugin-dispatch

Turn a one-liner into a scoped thread in the right project.

bb can spawn a thread, but only once you have already decided both the project
and the full prompt. This automates that intake step — the part bb has no
surface for. (The Workflows plugin is the *execution* layer and presupposes
both: it must run from an existing project thread and takes a written script.)

```bash
bb dispatch "fix the flaky auth test"                 # preview — nothing spawns
bb dispatch "fix the flaky auth test" --go            # spawn
bb dispatch "..." --project proj_abc123 --raw --go    # skip both intake steps
```

Or the **Dispatch** entry in the sidebar, which does the same thing and drops
you into the new thread.

## How it works

1. **Classify** — asks a model which of your registered bb projects the request
   belongs to, and reports its own confidence.
2. **Expand** — runs the request through your `Prompt Enhancer` vault note,
   read live through the `obsidian` CLI. Editing that note changes dispatch;
   there is no copy of it here.
3. **Spawn** — `sdk.threads.spawn()` into the chosen project, which inherits
   that project's remembered provider/model defaults.

Both model calls go to the LiteLLM proxy, not bb's internal inference (plugins
cannot reach it — `PluginHosts` exposes only port and tunnel methods). That is
the better trade anyway: the lane is explicit and swappable in `models.yaml`,
calls are traced, and intake runs on a cheap lane rather than a subscription.

## Limitations

**It can only route to registered bb projects.** The classifier picks from
`sdk.projects.list()`. Work that lives in a directory bb does not know about is
invisible to it, and the classifier will confidently pick the nearest registered
project instead. If dispatch keeps choosing the wrong target, check whether the
right one is even a project:

```bash
bb project list --include-personal
bb project create --name <name> --root <path> --machine <machine>
```

**Classification accuracy is bounded by context.** It sees only project name and
path. Observed confidence on real requests has been 0.3–0.4 — honest, but thin.
Preview-by-default exists because of this. If it stays low with a complete
project list, feed each project's `CLAUDE.md`/`AGENTS.md` summary into the
classifier prompt.

**Intake degrades, it does not guess.** Each failure is reported as a `note:`
line and dispatch falls back to what bb does natively — the raw text, to a
project you name:

| Failure | Effect |
|---|---|
| LiteLLM unreachable or key unset | no classification, no expansion — pass `--project` |
| Obsidian not running | no expansion; request used as written |
| Classifier returns an unknown project id | ignored; pass `--project` |

**Threads run in the project checkout, not an isolated worktree.**
`environment: host` + `workspace: unmanaged` with a null path. Right default for
"go fix this"; if you want every dispatch branch-isolated, change the spawn call.

**The CLI cannot prompt.** A plugin command returns stdout and has no
interactive channel, so the preview/`--go` two-step *is* the confirmation.

## Settings

`bb plugin config dispatch set <key> <value>`

| Key | Default | Notes |
|---|---|---|
| `litellmUrl` | `http://localhost:4000/v1` | OpenAI-compatible base URL |
| `litellmKey` | — | secret; required for any intake |
| `model` | `bulk-primary` | alias to classify and expand with |
| `enhancerNote` | `Prompt Enhancer` | vault note holding the expander |

The enhancer note must contain `$ARGUMENTS`, which is replaced with the request.
If it does not, expansion is skipped rather than sending a malformed prompt.

Reload after changing settings: `bb plugin reload dispatch`.

## Developing

Installed from a path, so the backend loads `server.ts` directly — edit and
`bb plugin reload dispatch`. Frontend changes need `bb plugin build .` first, or
run `bb plugin dev` to watch.
