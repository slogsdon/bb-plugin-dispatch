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

## The intake lane

Plugins cannot reach bb's internal inference (`PluginHosts` exposes only port and
tunnel methods), so intake calls a model the only way a plugin can: it spawns a
hidden bb thread, waits, reads the output, and archives it. That thread runs on
the **intake lane** — one saved set of selections covering project, provider,
model, reasoning level, permission mode, and environment.

Pick it with **bb's own new-thread composer**, in Settings → Plugins → Dispatch.
Submitting saves the selections; the prompt you type is discarded and no thread
is started.

Why a composer and not settings fields:

- `pi` alone publishes 373 models, so a `select` descriptor would be worse than
  free text, and the composer is the only host-owned picker the SDK exports.
- The composer marks every selection **caller-explicit** in
  `executionInputSources`, and the whole request is stored and spread back into
  `threads.spawn` verbatim. That is load-bearing: the server drops a requested
  `providerId`/`model` that arrives with no provenance and re-derives it from the
  project's stored defaults. A hand-built spawn can therefore run intake on a
  lane you never chose, silently and at someone else's cost.

The lane lives in plugin kv rather than in settings, because a plugin can read
its settings but not write them — the same reason the enhancer template lives
there. The plugin declares **no settings at all**; the composer is the whole
configuration surface.

Headless equivalent, for a machine with no UI:

```bash
bb dispatch lane                          # show current
bb dispatch lane --provider pi --model litellm/bulk-primary --project proj_abc123
```

Intake threads are **archived, not deleted** — bb refuses destructive actions
without an interactive confirmation, so deleting them fails silently and leaks
hidden threads.

### One path, not two

An earlier version could also POST to an OpenAI-compatible proxy instead of
spawning a thread. It was faster, and it could *force* JSON through
`response_format` where an agent can only be asked. It was still removed: it only
ran on a machine with LiteLLM in front of it, so it was a second code path most
installs could never take, and it cost four settings descriptors to configure.

The thread path's weaknesses are therefore accepted rather than routed around. An
agent has tools and a personality, so the prompts forbid both and parsing is
tolerant of narration. Intake is a spawn plus a turn, not one request.

If you do run LiteLLM, none of that is a loss — `pi` exposes its aliases to bb's
model selector (`litellm/bulk-primary` and friends), so the lane reaches exactly
the same proxy without the plugin knowing it exists.

The CLI form synthesises the provenance and a default host environment, since a
shell has no picker to resolve them from. It marks only `providerId` and `model`
explicit; reasoning and permission mode fall through to the usual defaults.

## Limitations

**It can only route to registered bb projects** — but it can tell you what is
missing. `bb dispatch projects` lists repos bb has discovered on this host that
are not registered, ranked with last activity and whether an agent has already
worked there:

```bash
bb dispatch projects                          # list the gap
bb dispatch projects --register relay,agenda-sync
bb dispatch projects --register all
```

This is the discovery half of routing fidelity, and it matters more than the
classifier. Two requests that misrouted at 0.4 and 0.85 confidence both went to
the correct project at 1.0 once the repos they referred to were registered — the
classifier had been picking the nearest available project because the right one
did not exist.

Nothing here reaches GitHub for repos you have not cloned; those are not
dispatchable anyway, since bb needs a local checkout.

**Unregistered work is invisible.** The classifier picks from
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
| No intake lane set, or its thread errors | no classification, no expansion — pass `--project` |
| Enhancer command fails, or template lacks `$ARGUMENTS` | no expansion; request used as written |
| Classifier returns an unknown project id | ignored; pass `--project` |

**Threads run in the project checkout, not an isolated worktree.**
`environment: host` + `workspace: unmanaged` with a null path. Right default for
"go fix this"; if you want every dispatch branch-isolated, change the spawn call.

**The CLI cannot prompt.** A plugin command returns stdout and has no
interactive channel, so the preview/`--go` two-step *is* the confirmation.

## Settings

There are none — `bb plugin config dispatch` reports "This plugin declares no
settings." Both things that need configuring outgrew what a settings descriptor
can express, so each lives where it can be edited properly:

| What | Where | Headless |
|---|---|---|
| Intake lane | Settings → Plugins → Dispatch (bb's composer) | `bb dispatch lane` |
| Enhancer template | The **Dispatch** panel | `bb dispatch enhancer` |
| Dispatch history | The **Dispatch** panel (below the composer) | — |

Reload after changing either: `bb plugin reload dispatch`.

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

**Alias the SDK's `experimental_` components before using them in JSX.** A
lowercase-leading tag resolves to an intrinsic HTML element, never to a component
in scope, so `<experimental_NewThreadComposer />` renders a literal
`<experimental_newthreadcomposer>` custom element with every prop stringified
onto it. It type-checks, logs nothing, and shows an empty gap where the component
should be. Assign it to a capitalized name first.
