import { v7 as uuid7 } from "uuid";
import type { AgentProfile, AgentRun } from "../agent.ts";
import type { Bus } from "../bus.ts";
import type { AgentRuntime } from "../runtime.ts";
import type { AgentStore } from "../store.ts";

export type SubagentInput =
	| {
			action: "run";
			profile: AgentProfile;
			task: string;
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
			action: "push_bus";
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
			if (input.action === "run") {
				const bus: Bus = { id: uuid7(), messages: [] };
				store.saveBus(bus);
				const run = await runtime.create(input.profile, input.task, bus);
				store.saveRun(run);
				return { run, message: `Subagent ${run.id} is ${run.state}.` };
			}

			if (input.action === "status") {
				const run = runtime.get(input.id) ?? store.getRun(input.id);
				if (!run) return { message: `Subagent ${input.id} not found.` };
				return { run, message: `Subagent ${run.id} is ${run.state}.` };
			}

			if (input.action === "resume") {
				const run = await runtime.resume(input.id, input.message);
				store.saveRun(run);
				return { run, message: `Resumed subagent ${run.id}.` };
			}

			if (input.action === "push_bus") {
				const busMessage = await runtime.pushBus(input.id, input.message, "main");
				const run = runtime.get(input.id) ?? store.getRun(input.id);
				if (run) store.addBusMessage(run.busId, busMessage);
				if (run) store.saveRun(run);
				return { run, message: `Pushed bus message to subagent ${input.id}.` };
			}

			await runtime.close(input.id);
			const current = store.getRun(input.id);
			const run = current ? { ...current, state: "closed" as const } : undefined;
			if (run) store.saveRun(run);
			return { run, message: `Closed subagent ${input.id}.` };
		},
	};
}
