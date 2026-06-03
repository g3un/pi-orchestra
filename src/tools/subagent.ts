import type { AgentProfile, AgentRun } from "../core/agent.ts";
import type { OrchestraApi } from "../core/orchestra.ts";

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
  orchestra: OrchestraApi;
}

export function createSubagentTool({ orchestra }: SubagentToolDeps): SubagentTool {
  return {
    name: "subagent",

    async execute(input) {
      if (input.action === "spawn") {
        const run = await orchestra.spawnAgent(input.profile, input.task, input.busId);
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "status") {
        const run = orchestra.getRun(input.id);
        if (!run) return { message: `Subagent ${input.id} not found.` };
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "resume") {
        const run = await orchestra.resumeAgent(input.id, input.message);
        return {
          run,
          message: formatRunMessage(run, `Resumed subagent ${run.id}; it is ${run.state}.`),
        };
      }

      const run = await orchestra.closeAgent(input.id);
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
