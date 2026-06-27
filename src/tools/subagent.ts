import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { OrchestraApi } from "../core/orchestra.ts";
import {
  AGENT_PROFILE_PRESET_VALUES,
  createAgentProfileFromPreset,
  type AgentProfilePreset,
} from "../profiles/presets.ts";

export interface SubagentSpawnInput {
  action: "spawn";
  profile: AgentProfile;
  task: string;
  busId: string;
  name: string;
}

export type SubagentInput =
  | SubagentSpawnInput
  | {
      action: "status";
      id: string;
    }
  | {
      action: "message";
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
  parentRunId: string | null;
}

export const SubagentRunNameParam = Type.String({
  description: "Unique readable name for this agent run.",
});

const AgentProfileToolsParam = Type.Array(Type.String(), {
  description: "Tool allowlist. finish/publish_bus are added automatically; do not include bus.",
});

const AgentProfileModelParam = Type.Optional(
  Type.String({
    description: "Optional exact provider/model id from /orchestra-models. Omit to inherit the current Pi model.",
  }),
);

export const AgentProfileParams = Type.Object(
  {
    preset: Type.Optional(
      Type.String({
        enum: [...AGENT_PROFILE_PRESET_VALUES],
        description: "Reusable profile preset.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description: "Readable role/profile name. Optional preset override; required when preset is omitted.",
      }),
    ),
    systemPrompt: Type.Optional(
      Type.String({ description: "Required when preset is omitted. Do not include with preset profiles." }),
    ),
    tools: AgentProfileToolsParam,
    model: AgentProfileModelParam,
  },
  {
    additionalProperties: false,
    description: "Required for spawn. Use preset, or provide custom name/systemPrompt/tools.",
  },
);

const SubagentActionParams = Type.String({
  enum: ["spawn", "status", "message", "close"],
  description: "spawn creates; status inspects; message steers; close disposes.",
});

export const SubagentSpawnParams = Type.Object(
  {
    action: Type.String({
      enum: ["spawn"],
      description: "spawn creates a subagent.",
    }),
    profile: AgentProfileParams,
    task: Type.String({
      description: "Required for spawn. Delegated task.",
    }),
    busId: Type.String({
      description: "Required for spawn. Existing bus name.",
    }),
    name: SubagentRunNameParam,
  },
  { additionalProperties: false },
);

const SubagentToolParams = Type.Object(
  {
    action: SubagentActionParams,
    profile: Type.Optional(AgentProfileParams),
    task: Type.Optional(
      Type.String({
        description: "Required for spawn. Delegated task.",
      }),
    ),
    busId: Type.Optional(
      Type.String({
        description: "Required for spawn. Existing bus name.",
      }),
    ),
    name: Type.Optional(SubagentRunNameParam),
    id: Type.Optional(
      Type.String({
        description: "Required for status/message/close. Subagent run name.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Required for message. Instruction to send.",
      }),
    ),
  },
  { additionalProperties: false },
);

export async function spawnSubagent(
  orchestra: OrchestraApi,
  input: SubagentSpawnInput,
  parentRunId: string | null,
): Promise<AgentRun> {
  return await orchestra.spawnAgent(input.profile, input.task, input.busId, { name: input.name, parentRunId });
}

export function createSubagentTool({ orchestra, parentRunId }: SubagentToolDeps): SubagentTool {
  return {
    name: "subagent",

    async execute(input) {
      if (input.action === "spawn") {
        const run = await spawnSubagent(orchestra, input, parentRunId);
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "status") {
        const run = orchestra.getRun(input.id, { busId: undefined });
        if (!run) return { message: formatMissingSubagentMessage(input.id) };
        return { run, message: formatRunMessage(run) };
      }

      if (input.action === "message") {
        const run = await orchestra.messageAgent(input.id, input.message, { busId: undefined });
        return {
          run,
          message: formatRunMessage(run, `Messaged subagent ${run.name}; it is ${run.state}.`),
        };
      }

      const run = await orchestra.closeAgent(input.id, { busId: undefined });
      return {
        run,
        message: run ? formatRunMessage(run, `Closed subagent ${run.name}.`) : formatMissingSubagentMessage(input.id),
      };
    },
  };
}

export function defineSubagentPiTool(resolveTool: (ctx: ExtensionContext) => SubagentTool) {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn and manage subagents.",
    promptSnippet: "Spawn, inspect, message, or close named subagents.",
    promptGuidelines: [
      "Use subagent spawn on an existing bus; related agents can share a bus.",
      "Use subagent status/message/close with the returned run name.",
    ],
    parameters: SubagentToolParams,
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = withDefaultModel(toSubagentInput(params as RawSubagentParams), ctx);
      const output = await resolveTool(ctx).execute(input);

      return {
        content: [{ type: "text", text: output.message }],
        details: output,
      };
    },
  });
}

function toSubagentInput(params: RawSubagentParams): SubagentInput {
  if (params.action === "spawn") {
    return toSubagentSpawnInput({
      action: params.action,
      profile: params.profile,
      task: params.task,
      busId: params.busId,
      name: params.name,
    });
  }

  if (params.action === "status") {
    if (!params.id) throw new Error("subagent action=status requires id.");
    return { action: "status", id: params.id };
  }

  if (params.action === "message") {
    if (!params.id) throw new Error("subagent action=message requires id.");
    if (!params.message) throw new Error("subagent action=message requires message.");
    return { action: "message", id: params.id, message: params.message };
  }

  if (!params.id) throw new Error("subagent action=close requires id.");
  return { action: "close", id: params.id };
}

export function toSubagentSpawnInput(
  params: RawSubagentSpawnParams,
  label = "subagent action=spawn",
): SubagentSpawnInput {
  if (params.action !== "spawn") throw new Error(`${label} requires action=spawn.`);
  if (!params.profile) throw new Error(`${label} requires profile.`);
  if (!params.task) throw new Error(`${label} requires task.`);
  if (!params.busId) throw new Error(`${label} requires busId.`);
  if (!params.name) throw new Error(`${label} requires name.`);
  return {
    action: "spawn",
    profile: toAgentProfile(params.profile),
    task: params.task,
    busId: params.busId,
    name: params.name,
  };
}

function withDefaultModel(input: SubagentInput, ctx: ExtensionContext): SubagentInput {
  if (input.action !== "spawn") return input;
  return {
    ...input,
    profile: withDefaultProfileModel(input.profile, ctx),
  };
}

export function toAgentProfile(profile: RawAgentProfileParams): AgentProfile {
  const profileLabel = profile.preset ? `Profile preset "${profile.preset}"` : `Profile "${profile.name ?? "custom"}"`;
  if (!Array.isArray(profile.tools)) throw new Error(`${profileLabel} requires tools.`);

  if (profile.preset) {
    if (profile.systemPrompt !== undefined) {
      throw new Error(
        `Profile preset "${profile.preset}" must not include systemPrompt; omit preset for a custom profile.`,
      );
    }

    return createAgentProfileFromPreset({
      preset: profile.preset,
      name: profile.name,
      tools: profile.tools,
      model: profile.model,
    });
  }

  if (profile.name === undefined) throw new Error("Custom profile requires name.");
  if (profile.systemPrompt === undefined) throw new Error(`Profile "${profile.name}" requires systemPrompt.`);
  return {
    name: profile.name,
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    model: profile.model,
  };
}

export function withDefaultProfileModel(profile: AgentProfile, ctx: ExtensionContext): AgentProfile {
  if (profile.model) return { ...profile, model: resolveAvailableModelId(profile.model, ctx) };
  if (!ctx.model) return profile;
  return {
    ...profile,
    model: formatModelId(ctx.model),
  };
}

export function withDefaultProfileModelInput<T extends { profile: AgentProfile }>(input: T, ctx: ExtensionContext): T {
  return {
    ...input,
    profile: withDefaultProfileModel(input.profile, ctx),
  };
}

export function formatAvailableModelSelectionGuide(ctx: ExtensionContext, query = ""): string {
  const models = getAvailableModels(ctx);
  const normalizedQuery = normalizeModelQuery(query);
  const currentModel = ctx.model ? formatModelId(ctx.model) : "none";
  const header = [
    "Pi-orchestra available models:",
    "",
    "- Omit profile.model to inherit the current Pi model.",
    "- Set profile.model only with an exact provider/model id from this guide.",
    "- Use /orchestra-models <query> to filter or drill down, e.g. openai-codex or openrouter/openai.",
    "",
    `Current model: ${currentModel}`,
    "",
  ];

  if (models.length === 0) {
    return [
      ...header,
      "No configured available models were reported by Pi. Omit profile.model or configure/login to a provider.",
    ].join("\n");
  }

  const entries = models.map(toModelPathEntry);
  const prefixMatches = normalizedQuery
    ? entries.filter((entry) => isModelPathPrefixMatch(entry.normalizedPath, normalizedQuery))
    : entries;

  if (prefixMatches.length > 0) {
    return [...header, ...formatModelDrilldown(prefixMatches, normalizedQuery)].join("\n");
  }

  const searchMatches = entries.filter((entry) => isModelSearchMatch(entry, normalizedQuery));
  if (searchMatches.length === 0) {
    return [
      ...header,
      `Filter: ${query.trim()}`,
      `No matching models among ${models.length} available models.`,
      `Available providers: ${formatAvailableModelProviderSummary(models)}.`,
    ].join("\n");
  }

  return [...header, ...formatModelSearchGroups(searchMatches, normalizedQuery, models.length)].join("\n");
}

function formatMissingSubagentMessage(id: string): string {
  return `Subagent ${id} not found.`;
}

function formatRunMessage(run: AgentRun, headline = `Subagent ${run.name} is ${run.state}.`): string {
  if (run.result === null) return headline;

  const parts = [headline, "", `Result: ${run.result.status}`, run.result.summary];
  if (run.result.data !== undefined) {
    parts.push("", "Data:", formatResultData(run.result.data));
  }
  return parts.join("\n");
}

export function formatResultData(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2) ?? String(data);
}

function resolveAvailableModelId(modelReference: string, ctx: ExtensionContext): string {
  const normalizedReference = modelReference.trim();
  if (!normalizedReference) throw new Error("profile.model must not be empty.");

  const models = getAvailableModels(ctx);
  if (models.length === 0) {
    throw new Error(
      `No available Pi models are configured for pi-orchestra. Omit profile.model to use the current session model, or configure/login to a provider before choosing a child model.`,
    );
  }

  const exact = findModelByReference(normalizedReference, models);
  if (exact) return formatModelId(exact);

  throw new Error(
    [
      `Model "${modelReference}" is not available to pi-orchestra.`,
      formatRequestedProviderHint(normalizedReference, models),
      "Run /orchestra-models to copy an exact provider/model id, or omit profile.model to inherit the current Pi model.",
      `Available providers: ${formatAvailableModelProviderSummary(models)}.`,
    ]
      .filter((part) => part.length > 0)
      .join(" "),
  );
}

function findModelByReference(modelReference: string, models: AgentProfileModel[]): AgentProfileModel | undefined {
  const normalizedReference = modelReference.toLowerCase();
  const canonical = models.find((model) => formatModelId(model).toLowerCase() === normalizedReference);
  if (canonical) return canonical;

  const slashIndex = modelReference.indexOf("/");
  if (slashIndex >= 0) {
    const provider = modelReference.slice(0, slashIndex).trim().toLowerCase();
    const modelId = modelReference
      .slice(slashIndex + 1)
      .trim()
      .toLowerCase();
    return models.find((model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId);
  }

  const idMatches = models.filter(
    (model) => model.id.toLowerCase() === normalizedReference || model.name?.toLowerCase() === normalizedReference,
  );
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

interface ModelPathEntry {
  model: AgentProfileModel;
  path: string;
  normalizedPath: string;
  segments: string[];
  normalizedSegments: string[];
}

function toModelPathEntry(model: AgentProfileModel): ModelPathEntry {
  const path = formatModelId(model);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return {
    model,
    path,
    normalizedPath: path.toLowerCase(),
    segments,
    normalizedSegments: segments.map((segment) => segment.toLowerCase()),
  };
}

function normalizeModelQuery(query: string): string {
  return query
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function isModelPathPrefixMatch(path: string, query: string): boolean {
  return path === query || path.startsWith(`${query}/`);
}

function isModelSearchMatch(entry: ModelPathEntry, query: string): boolean {
  const haystack = [entry.normalizedPath, entry.model.provider, entry.model.id, entry.model.name ?? ""]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function formatModelDrilldown(entries: ModelPathEntry[], normalizedPrefix: string): string[] {
  const prefixSegments = normalizedPrefix ? normalizedPrefix.split("/") : [];
  const depth = prefixSegments.length;
  const groups = new Map<string, number>();
  const leaves: ModelPathEntry[] = [];

  for (const entry of entries) {
    const remaining = entry.segments.slice(depth);
    if (remaining.length > 1) {
      const group = entry.segments.slice(0, depth + 1).join("/");
      groups.set(group, (groups.get(group) ?? 0) + 1);
    } else {
      leaves.push(entry);
    }
  }

  if (groups.size > 0 && leaves.length === 0) {
    return [
      normalizedPrefix ? `Filter: ${normalizedPrefix}` : "Available model groups:",
      `Groups (${groups.size}, ${entries.length} models):`,
      ...formatModelGroupLines(groups),
    ];
  }

  return [
    normalizedPrefix ? `Filter: ${normalizedPrefix}` : "Available models:",
    `Models (${entries.length}):`,
    ...entries.map(formatModelPathEntryLine),
  ];
}

function formatModelSearchGroups(entries: ModelPathEntry[], query: string, totalModelCount: number): string[] {
  const groups = new Map<string, number>();
  const leaves: ModelPathEntry[] = [];

  for (const entry of entries) {
    const matchingSegmentIndex = entry.normalizedSegments.findIndex((segment) => segment.includes(query));
    if (matchingSegmentIndex < 0 || matchingSegmentIndex === entry.segments.length - 1) {
      leaves.push(entry);
      continue;
    }

    const group = entry.segments.slice(0, matchingSegmentIndex + 1).join("/");
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }

  const lines = [`Filter: ${query}`, `Matching groups/models (${entries.length} of ${totalModelCount}):`];
  lines.push(...formatModelGroupLines(groups));
  lines.push(...leaves.map(formatModelPathEntryLine));
  return lines;
}

function formatModelGroupLines(groups: Map<string, number>): string[] {
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([group, count]) => `- ${group}: ${count} ${count === 1 ? "model" : "models"} — use /orchestra-models ${group}`,
    );
}

function formatModelPathEntryLine(entry: ModelPathEntry): string {
  return `- ${entry.path}${entry.model.name ? ` — ${entry.model.name}` : ""}`;
}

function formatRequestedProviderHint(modelReference: string, models: AgentProfileModel[]): string {
  const slashIndex = modelReference.indexOf("/");
  if (slashIndex < 0) return "";

  const requestedProvider = modelReference.slice(0, slashIndex).trim();
  if (!requestedProvider) return "";

  const hasProvider = models.some((model) => model.provider.toLowerCase() === requestedProvider.toLowerCase());
  return hasProvider
    ? `Provider "${requestedProvider}" is available, but that model id was not found.`
    : `Provider "${requestedProvider}" is not available.`;
}

function formatAvailableModelProviderSummary(models: AgentProfileModel[]): string {
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, count]) => `${provider} (${count} ${count === 1 ? "model" : "models"})`)
    .join(", ");
}

function getAvailableModels(ctx: ExtensionContext): AgentProfileModel[] {
  return ctx.modelRegistry.getAvailable();
}

function formatModelId(model: AgentProfileModel): string {
  return `${model.provider}/${model.id}`;
}

export type RawSubagentSpawnParams = {
  action?: "spawn";
  profile?: RawAgentProfileParams;
  task?: string;
  busId?: string;
  name?: string;
};

type RawSubagentParams = {
  action: "spawn" | "status" | "message" | "close";
  profile?: RawAgentProfileParams;
  task?: string;
  busId?: string;
  name?: string;
  id?: string;
  message?: string;
};

export type RawAgentProfileParams = {
  preset?: AgentProfilePreset;
  name?: string;
  systemPrompt?: string;
  tools?: string[];
  model?: string;
};

type AgentProfileModel = NonNullable<ExtensionContext["model"]>;
