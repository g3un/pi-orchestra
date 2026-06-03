import type { AgentProfile, AgentRun } from "../core/agent.ts";
import type { AgentRuntime } from "../core/runtime.ts";
import type { AgentStore } from "../core/store.ts";

export type SubagentInput =
  | {
      action: "spawn";
      profile: AgentProfile;
      task: string;
      busId: string;
    }
  | {
      action: "status";
      id: string;
    }
  | {
      action: "resume";
      id: string;
      message: string;
    }
  | {
      action: "close";
      id: string;
    };

export interface SubagentOutput {
  run?: AgentRun;
  message: string;
}

export interface SubagentTool {
  name: "subagent";
  execute(input: SubagentInput): Promise<SubagentOutput>;
}

export interface SubagentToolDeps {
  runtime: AgentRuntime;
  store: AgentStore;
}

export function createSubagentTool({ runtime, store }: SubagentToolDeps): SubagentTool {
  return {
    name: "subagent",

    async execute(input) {
      if (input.action === "spawn") {
        const bus = store.getBus(input.busId);
        if (!bus) throw new Error(`Bus ${input.busId} not found.`);

        const run = await runtime.spawn(input.profile, input.task, bus);
        store.saveRun(run);
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "status") {
        const run = runtime.get(input.id) ?? store.getRun(input.id);
        if (!run) return { message: `Subagent ${input.id} not found.` };
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "resume") {
        const run = await runtime.resume(input.id, input.message);
        store.saveRun(run);
        return {
          run,
          message: formatRunMessage(run, `Resumed subagent ${run.id}; it is ${run.state}.`),
        };
      }

      await runtime.close(input.id);
      const current = store.getRun(input.id);
      const run = current ? { ...current, state: "closed" as const } : undefined;
      if (run) store.saveRun(run);
      return {
        run,
        message: run ? formatRunMessage(run, `Closed subagent ${input.id}.`) : `Closed subagent ${input.id}.`,
      };
    },
  };
}

function formatRunMessage(run: AgentRun, headline = `Subagent ${run.id} is ${run.state}.`): string {
  if (!run.result) return headline;

  const parts = [headline, "", `Result: ${run.result.status}`, run.result.summary];
  if (run.result.data !== undefined) {
    parts.push("", "Data:", formatResultData(run.result.data));
  }
  return parts.join("\n");
}

function formatResultData(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2) ?? String(data);
}
