import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile } from "../agent.ts";
import { InMemoryAgentStore } from "../in-memory-store.ts";
import { PiAgentRuntime } from "../pi-runtime.ts";
import type { SubagentInput } from "../tools/subagent.ts";
import { createSubagentTool, type SubagentTool } from "../tools/subagent.ts";

const AgentProfileParams = Type.Object({
	name: Type.String({ description: "Short role/name for the subagent." }),
	systemPrompt: Type.String({ description: "System prompt for the subagent." }),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist for the subagent." })),
	model: Type.Optional(Type.String({ description: "Optional provider/model id, for example anthropic/claude-sonnet-4-5." })),
});

const SubagentActionParams = Type.Union([
	Type.Literal("run"),
	Type.Literal("status"),
	Type.Literal("resume"),
	Type.Literal("push_bus"),
	Type.Literal("close"),
]);

const SubagentToolParams = Type.Object({
	action: SubagentActionParams,
	profile: Type.Optional(AgentProfileParams),
	task: Type.Optional(Type.String({ description: "Task to delegate to the subagent." })),
	id: Type.Optional(Type.String({ description: "Subagent id." })),
	message: Type.Optional(Type.String({ description: "Message for resume or push_bus." })),
});

interface ToolBundle {
	tool: SubagentTool;
}

export default function piWeaverExtension(pi: ExtensionAPI): void {
	const bundles = new Map<string, ToolBundle>();

	pi.registerTool(
		defineTool({
			name: "subagent",
			label: "Subagent",
			description: "Create and manage an isolated subagent without polluting the parent context.",
			promptSnippet: "Delegate isolated work to subagent and inspect or resume it later.",
			promptGuidelines: [
				"Use subagent for isolated research, inspection, or implementation tasks.",
				"Use action=status before resuming or closing an existing subagent if its state is unclear.",
				"Use action=push_bus to send updated parent context to a running subagent.",
			],
			parameters: SubagentToolParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const bundle = getBundle(bundles, ctx);
				const input = withDefaultModel(toSubagentInput(params), ctx);
				const output = await bundle.tool.execute(input);

				return {
					content: [{ type: "text", text: output.message }],
					details: output,
				};
			},
		}),
	);
}

function toSubagentInput(params: {
	action: "run" | "status" | "resume" | "push_bus" | "close";
	profile?: AgentProfile;
	task?: string;
	id?: string;
	message?: string;
}): SubagentInput {
	if (params.action === "run") {
		if (!params.profile) throw new Error("subagent action=run requires profile.");
		if (!params.task) throw new Error("subagent action=run requires task.");
		return { action: "run", profile: params.profile, task: params.task };
	}

	if (params.action === "status") {
		if (!params.id) throw new Error("subagent action=status requires id.");
		return { action: "status", id: params.id };
	}

	if (params.action === "resume") {
		if (!params.id) throw new Error("subagent action=resume requires id.");
		if (!params.message) throw new Error("subagent action=resume requires message.");
		return { action: "resume", id: params.id, message: params.message };
	}

	if (params.action === "push_bus") {
		if (!params.id) throw new Error("subagent action=push_bus requires id.");
		if (!params.message) throw new Error("subagent action=push_bus requires message.");
		return { action: "push_bus", id: params.id, message: params.message };
	}

	if (!params.id) throw new Error("subagent action=close requires id.");
	return { action: "close", id: params.id };
}

function getBundle(bundles: Map<string, ToolBundle>, ctx: ExtensionContext): ToolBundle {
	const existing = bundles.get(ctx.cwd);
	if (existing) return existing;

	const store = new InMemoryAgentStore();
	const runtime = new PiAgentRuntime({
		cwd: ctx.cwd,
		resolveModel: (model) => resolveModel(ctx, model),
	});
	const bundle = {
		tool: createSubagentTool({ runtime, store }),
	};
	bundles.set(ctx.cwd, bundle);
	return bundle;
}

function withDefaultModel(input: SubagentInput, ctx: ExtensionContext): SubagentInput {
	if (input.action !== "run" || input.profile.model || !ctx.model) return input;
	return {
		...input,
		profile: {
			...input.profile,
			model: formatModelId(ctx.model),
		},
	};
}

function resolveModel(ctx: ExtensionContext, model: string): ReturnType<ExtensionContext["modelRegistry"]["find"]> {
	const slashIndex = model.indexOf("/");
	if (slashIndex < 0) {
		const currentProvider = ctx.model?.provider;
		return currentProvider ? ctx.modelRegistry.find(currentProvider, model) : undefined;
	}

	const provider = model.slice(0, slashIndex);
	const modelId = model.slice(slashIndex + 1);
	return provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
}

function formatModelId(model: AgentProfileModel): string {
	return `${model.provider}/${model.id}`;
}

type AgentProfileModel = NonNullable<ExtensionContext["model"]>;
