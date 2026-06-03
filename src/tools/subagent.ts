import type { AgentProfile, AgentRun } from "../core/agent.ts";
import type { OrchestraApi } from "../core/orchestra.ts";

export type SubagentInput =
  | {
      action: "spawn";
      profile: AgentProfile;
      task: string;
      busId: string;
      name?: string;
    }
  | {
      action: "status";
      id: string;
      busId?: string;
    }
  | {
      action: "message";
      id: string;
      message: string;
      busId?: string;
    }
  | {
      action: "close";
      id: string;
      busId?: string;
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
  orchestra: OrchestraApi;
}

export function createSubagentTool({ orchestra }: SubagentToolDeps): SubagentTool {
  return {
    name: "subagent",

    async execute(input) {
      if (input.action === "spawn") {
        const run = await orchestra.spawnAgent(input.profile, input.task, input.busId, { name: input.name });
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "status") {
        const run = orchestra.getRun(input.id, { busId: input.busId });
        if (!run) return { message: `Subagent ${input.id} not found.` };
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "message") {
        const run = await orchestra.messageAgent(input.id, input.message, { busId: input.busId });
        return {
          run,
          message: formatRunMessage(run, `Messaged subagent ${formatRunLabel(run)}; it is ${run.state}.`),
        };
      }

      const run = await orchestra.closeAgent(input.id, { busId: input.busId });
      return {
        run,
        message: run
          ? formatRunMessage(run, `Closed subagent ${formatRunLabel(run)}.`)
          : `Closed subagent ${input.id}.`,
      };
    },
  };
}

function formatRunMessage(run: AgentRun, headline = `Subagent ${formatRunLabel(run)} is ${run.state}.`): string {
  if (!run.result) return headline;

  const parts = [headline, "", `Result: ${run.result.status}`, run.result.summary];
  if (run.result.data !== undefined) {
    parts.push("", "Data:", formatResultData(run.result.data));
  }
  return parts.join("\n");
}

function formatRunLabel(run: AgentRun): string {
  return run.name === run.id ? run.id : `${run.name} (${run.id})`;
}

function formatResultData(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2) ?? String(data);
}
