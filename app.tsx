// bb-plugin-dispatch — nav panel.
//
// Registered as a navPanel (a sidebar menu entry owning its own route) rather
// than a homepageSection: dispatch is somewhere you go to start work, not a
// status card you glance at.
//
// Preview and dispatch are separate actions on purpose. Project classification
// from a one-liner is not always right and the classifier reports its own
// confidence, so the flow shows you where it decided to send the work before
// anything is spawned — the UI mirror of --go on the CLI.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Project = { id: string; name: string };
type Intake = {
  projectId: string | null;
  projectName: string | null;
  prompt: string;
  notes: string[];
};

function DispatchPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [request, setRequest] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [raw, setRaw] = useState(false);
  const [result, setResult] = useState<Intake | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "dispatch">("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("projects").then((p) => setProjects(p as Project[])).catch(() => {});
  }, [rpc]);

  const args = { request, projectId: projectId || null, raw };

  const preview = useCallback(() => {
    setBusy("preview"); setError(null);
    rpc.call("preview", args)
      .then((r) => setResult(r as Intake))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(""));
  }, [rpc, request, projectId, raw]);

  const dispatch = useCallback(() => {
    setBusy("dispatch"); setError(null);
    rpc.call("dispatch", args)
      .then((r) => {
        const res = r as Intake & { threadId: string };
        setResult(res);
        // Land the user in the thread they just started — the whole point is to
        // get from an idea to running work without navigating.
        if (res.threadId) navigate.toThread(res.threadId);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(""));
  }, [rpc, navigate, request, projectId, raw]);

  const lowConfidence = result?.notes.some((n) => n.startsWith("LOW CONFIDENCE"));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
      <textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        placeholder="fix the flaky auth test"
        rows={3}
        className="w-full resize-y rounded-md border bg-background p-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Project: auto-detect</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />
          skip expansion
        </label>
        <div className="ml-auto flex gap-2">
          <button onClick={preview} disabled={!request.trim() || busy !== ""} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">
            {busy === "preview" ? "Checking…" : "Preview"}
          </button>
          <button onClick={dispatch} disabled={!request.trim() || busy !== ""} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {busy === "dispatch" ? "Dispatching…" : "Dispatch"}
          </button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {result ? (
        <div className="rounded-lg border">
          <div className="space-y-3 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">
                {result.projectName ?? "No project resolved — pick one above"}
              </span>
              {lowConfidence ? (
                <span className="text-xs text-destructive">low confidence</span>
              ) : null}
            </div>
            {result.notes.map((n) => (
              <p key={n} className="text-xs text-muted-foreground">{n}</p>
            ))}
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
              {result.prompt}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dispatch",
    title: "Dispatch",
    icon: "Send",
    path: "dispatch",
    component: DispatchPanel,
  });
});
