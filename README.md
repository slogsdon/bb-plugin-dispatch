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
2. **Expand** — runs the request through the prompt enhancer (see below).
3. **Spawn** — `sdk.threads.spawn()` into the chosen project, which inherits
   that project's remembered provider/model defaults.

## Intake modes

Plugins cannot reach bb's internal inference (`PluginHosts` exposes only port and
tunnel methods), so intake needs its own way to call a model. Two, by setting:

**`thread`** (default) — spawns a hidden bb thread on any provider and model from
the standard selector, waits, reads the output, archives it. Portable: works for
any bb user with any provider, no proxy and no API key. Slower — a spawn plus a
turn rather than one request — and an agent has tools and a personality, so the
prompts forbid both and parsing is tolerant.

**`http`** — one call to an OpenAI-compatible proxy. Fast, but assumes you run
one. Set `litellmUrl`, `litellmKey`, and `model`.

If you already run LiteLLM, note that `pi` exposes its aliases to bb's model
selector (`litellm/bulk-primary` and friends), so thread mode reaches the same
lane without the plugin knowing anything about the proxy.

Intake threads are **archived, not deleted** — bb refuses destructive actions
without an interactive confirmation, so deleting them fails silently and leaks
hidden threads.

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
| Intake unconfigured or unreachable | no classification, no expansion — pass `--project` |
| Enhancer command fails, or template lacks `$ARGUMENTS` | no expansion; request used as written |
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
| `intakeMode` | `thread` | `thread` or `http` |
| `intakeProvider` | `pi` | thread mode: provider id |
| `intakeModel` | `litellm/bulk-primary` | thread mode: model id |
| `intakeProject` | — | thread mode: where hidden intake threads are created |
| `litellmUrl` | `http://localhost:4000/v1` | http mode only |
| `litellmKey` | — | http mode only; secret |
| `model` | `bulk-primary` | http mode only |

The enhancer is configured in the **Dispatch** panel rather than here, because bb
settings support only single-line strings and the template is long.

## Prompt enhancer

Two sources, chosen from a dropdown in the panel:

- **Text** (default) — a template edited in a textarea. Ships with a working
  default, so a fresh install needs no vault and no external tooling.
- **Command** — a shell command whose stdout is the template. Use this to keep
  the prompt where it already lives instead of copying it:
  `obsidian read path="Prompts/Enhancer.md"`. Fenced output (` ``` ` or `~~~`)
  is unwrapped automatically.

Set it headlessly (the panel editor is the other way):

```bash
bb dispatch enhancer                                    # show current
bb dispatch enhancer --command 'obsidian read path="Prompts/Enhancer.md"'
bb dispatch enhancer --source text                      # back to the bundled template
```

Setting it resolves the template immediately and fails loudly if the command
does not produce one, rather than silently degrading at the next dispatch.

Either way the template must contain `$ARGUMENTS`, which is replaced with the
request. Without it, expansion is skipped rather than sending a malformed
prompt.

Command mode runs through a shell. That is the same trust level as the rest of
the plugin — full-trust code on your own machine — but it is not sandboxed.

Reload after changing settings: `bb plugin reload dispatch`.

## Developing

Installed from a path, so the backend loads `server.ts` directly — edit and
`bb plugin reload dispatch`. Frontend changes need `bb plugin build .` first, or
run `bb plugin dev` to watch.
