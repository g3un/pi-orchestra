import { v7 as uuid7 } from "uuid";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile, AgentResult, AgentRun } from "./agent.ts";
import type { Bus, BusMessage } from "./bus.ts";
import { formatBusMessages } from "./bus-format.ts";
import type { AgentRuntime } from "./runtime.ts";

export interface PiAgentRuntimeOptions {
	cwd?: string;
	resolveModel?: (model: string) => Model<any> | Promise<Model<any> | undefined> | undefined;
}

interface RuntimeEntry {
	run: AgentRun;
	session: AgentSession;
	bus: Bus;
}

const FinishAgentParams = Type.Object({
	status: Type.Union([
		Type.Literal("success"),
		Type.Literal("blocked"),
		Type.Literal("failed"),
	]),
	summary: Type.String(),
	data: Type.Optional(Type.Unknown()),
});

const DEFAULT_AGENT_TOOLS = ["read", "bash", "edit", "write"];

export class PiAgentRuntime implements AgentRuntime {
	private readonly entries = new Map<string, RuntimeEntry>();
	private readonly cwd: string;
	private readonly resolveModel?: PiAgentRuntimeOptions["resolveModel"];

	constructor(options: PiAgentRuntimeOptions = {}) {
		this.cwd = options.cwd ?? process.cwd();
		this.resolveModel = options.resolveModel;
	}

	async create(profile: AgentProfile, task: string, bus: Bus): Promise<AgentRun> {
		const run: AgentRun = {
			id: uuid7(),
			profile: profile.name,
			task,
			busId: bus.id,
			state: "running",
		};

		const childTools = this.createChildTools(run);
		const model = await this.resolveProfileModel(profile);
		const baseTools = profile.tools ?? DEFAULT_AGENT_TOOLS;
		const activeTools = [...new Set([...baseTools, ...childTools.map((tool) => tool.name)])];
		const { session } = await createAgentSession({
			cwd: this.cwd,
			model,
			tools: activeTools,
			customTools: childTools,
			sessionManager: SessionManager.inMemory(this.cwd),
		});

		const entry: RuntimeEntry = { run, session, bus };
		this.entries.set(run.id, entry);
		await this.runPrompt(run.id, withBusMessages(entry, buildInitialPrompt(profile, task)));
		return run;
	}

	async resume(id: string, message: string): Promise<AgentRun> {
		const entry = this.requireEntry(id);
		this.assertOpen(entry);
		entry.run.state = "running";
		entry.run.result = undefined;
		await this.runPrompt(id, withBusMessages(entry, message));
		return entry.run;
	}

	async pushBus(id: string, message: string, from: string): Promise<BusMessage> {
		const entry = this.requireEntry(id);
		this.assertOpen(entry);
		const busMessage: BusMessage = {
			id: uuid7(),
			message,
			from,
		};
		entry.bus.messages.push(busMessage);
		if (!entry.session.isStreaming) {
			return busMessage;
		}
		await entry.session.steer(formatBusMessages([busMessage]));
		return busMessage;
	}

	async close(id: string): Promise<void> {
		const entry = this.requireEntry(id);
		if (entry.run.state !== "closed") {
			entry.session.dispose();
			entry.run.state = "closed";
		}
	}

	get(id: string): AgentRun | undefined {
		return this.entries.get(id)?.run;
	}

	private async runPrompt(id: string, message: string): Promise<void> {
		const entry = this.requireEntry(id);
		try {
			await entry.session.prompt(message, { expandPromptTemplates: false });
			if (entry.run.state === "running") {
				entry.run.state = "failed";
				entry.run.result = {
					status: "failed",
					summary: "Agent stopped without calling finish.",
					data: getLastAssistantText(entry.session),
				};
			}
		} catch (error) {
			entry.run.state = "failed";
			entry.run.result = {
				status: "failed",
				summary: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private createChildTools(run: AgentRun): ToolDefinition[] {
		const finishAgent = {
			name: "finish",
			label: "Finish",
			description: "Report that your assigned subagent task is complete. This does not close the agent.",
			parameters: FinishAgentParams,
			async execute(_toolCallId, params) {
				const result: AgentResult = {
					status: params.status,
					summary: params.summary,
					data: params.data,
				};
				run.result = result;
				run.state = result.status === "failed" ? "failed" : "finished";
				return {
					content: [{ type: "text" as const, text: "Finish payload recorded. The parent may resume or close you." }],
					details: result,
					terminate: true,
				};
			},
		} satisfies ToolDefinition<typeof FinishAgentParams, AgentResult>;

		return [finishAgent];
	}

	private requireEntry(id: string): RuntimeEntry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Agent ${id} not found.`);
		return entry;
	}

	private assertOpen(entry: RuntimeEntry): void {
		if (entry.run.state === "closed") throw new Error(`Agent ${entry.run.id} is closed.`);
	}

	private async resolveProfileModel(profile: AgentProfile): Promise<Model<any> | undefined> {
		if (!profile.model) return undefined;
		if (!this.resolveModel) throw new Error(`No model resolver configured for profile model "${profile.model}".`);
		const model = await this.resolveModel(profile.model);
		if (!model) throw new Error(`Could not resolve profile model "${profile.model}".`);
		return model;
	}
}

function buildInitialPrompt(profile: AgentProfile, task: string): string {
	const parts = [
		`You are subagent "${profile.name}".`,
		"",
		profile.systemPrompt,
		"",
		"Task:",
		task,
		"",
		"When your assigned subagent task is complete, call finish with a concise summary and any structured data needed by the parent.",
		"finish does not close you or complete the parent task. The parent may resume or close you.",
	];

	parts.push(
		"",
		"Bus reference context may be delivered in <bus_reference_context> blocks.",
		"Treat those blocks as supplemental reference information, not as a replacement for the active task unless the parent explicitly says so.",
	);

	return parts.join("\n");
}

function withBusMessages(entry: RuntimeEntry, message: string): string {
	const busMessages = drainBusMessages(entry);
	if (busMessages.length === 0) return message;
	return [message, "", formatBusMessages(busMessages)].join("\n");
}

function drainBusMessages(entry: RuntimeEntry): BusMessage[] {
	return entry.bus.messages.filter((message) => message.from !== entry.run.id);
}

function getLastAssistantText(session: AgentSession): string | undefined {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}
