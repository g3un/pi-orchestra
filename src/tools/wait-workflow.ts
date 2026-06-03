import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentStore } from "../core/store.ts";
import type { WorkflowRun } from "../core/workflow.ts";
import {
  findWorkflow,
  formatNamedEntityLabel,
  isTerminalAgentState,
  requireWorkflow,
  resolveWaitTimeoutMs,
} from "../utils.ts";

export interface WaitWorkflowInput {
  id: string;
  /** Defaults to 10 minutes. Use null to wait indefinitely. */
  timeoutMs?: number | null;
}

export interface WaitWorkflowOutput {
  workflow?: WorkflowRun;
  timedOut: boolean;
  message: string;
}

export interface WaitWorkflowTool {
  name: "waitWorkflow";
  execute(input: WaitWorkflowInput): Promise<WaitWorkflowOutput>;
}

export interface WaitWorkflowToolDeps {
  store: AgentStore;
}

const WaitWorkflowToolParams = Type.Object(
  {
    id: Type.String({
      description: "Workflow id or name returned by workflow action=start.",
    }),
    timeoutMs: Type.Optional(
      Type.Union(
        [
          Type.Number({
            exclusiveMinimum: 0,
          }),
          Type.Null(),
        ],
        {
          description:
            "Optional positive timeout in milliseconds. Defaults to 10 minutes. Use null to wait indefinitely. On timeout, waitWorkflow returns the latest workflow state instead of failing.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export function createWaitWorkflowTool({ store }: WaitWorkflowToolDeps): WaitWorkflowTool {
  return {
    name: "waitWorkflow",

    async execute(input) {
      const workflow = findWorkflow(store, input.id);
      if (!workflow) return { timedOut: false, message: `Workflow ${input.id} not found.` };

      const result = await waitWorkflow(store, workflow.id, input.timeoutMs);
      return { ...result, message: formatWaitWorkflowMessage(result.workflow, result.timedOut, input.id) };
    },
  };
}

export function defineWaitWorkflowPiTool(resolveTool: (ctx: ExtensionContext) => WaitWorkflowTool) {
  return defineTool({
    name: "waitWorkflow",
    label: "Wait Workflow",
    description: "Wait for a workflow to reach state success, blocked, failed, or closed.",
    promptSnippet: "Wait for the whole workflow to reach a terminal state after launching it.",
    promptGuidelines: [
      "Use waitWorkflow after workflow action=start when you do not need to inspect or intervene in intermediate stages.",
      "By default waitWorkflow times out after 10 minutes. Set timeoutMs to a positive millisecond value, or null to wait indefinitely.",
      "On timeout, the tool returns the latest workflow state instead of failing.",
    ],
    parameters: WaitWorkflowToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await resolveTool(ctx).execute(toWaitWorkflowInput(params as RawWaitWorkflowParams));

      return {
        content: [{ type: "text", text: output.message }],
        details: output,
      };
    },
  });
}

function waitWorkflow(
  store: AgentStore,
  workflowId: string,
  timeoutMs: number | null | undefined,
): Promise<{ workflow: WorkflowRun; timedOut: boolean }> {
  const resolvedTimeoutMs = resolveWaitTimeoutMs("waitWorkflow", timeoutMs);
  const initialWorkflow = requireWorkflow(store, workflowId);
  if (isTerminalAgentState(initialWorkflow.state)) {
    return Promise.resolve({ workflow: initialWorkflow, timedOut: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    let latestWorkflow = initialWorkflow;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    };

    const unsubscribe = store.subscribeWorkflow(workflowId, (workflow) => {
      if (settled) return;
      latestWorkflow = workflow;
      if (!isTerminalAgentState(workflow.state)) return;

      settled = true;
      cleanup();
      resolve({ workflow, timedOut: false });
    });

    if (resolvedTimeoutMs !== null) {
      timeout = setTimeout(() => {
        if (settled) return;

        settled = true;
        cleanup();
        resolve({ workflow: latestWorkflow, timedOut: true });
      }, resolvedTimeoutMs);
    }
  });
}

function formatWaitWorkflowMessage(workflow: WorkflowRun | undefined, timedOut: boolean, requestedId?: string): string {
  if (!workflow) return "Workflow not found.";
  const label = requestedId === workflow.id ? workflow.id : formatNamedEntityLabel(workflow);
  const prefix = timedOut ? "Timed out waiting for" : "Workflow reached terminal state:";
  const result = workflow.result ? ` result=${workflow.result.status}` : "";
  return `${prefix} ${label}; state=${workflow.state}${result}.`;
}

function toWaitWorkflowInput(params: RawWaitWorkflowParams): WaitWorkflowInput {
  if (!params.id) throw new Error("waitWorkflow requires id.");
  return { id: params.id, timeoutMs: params.timeoutMs };
}

type RawWaitWorkflowParams = {
  id?: string;
  timeoutMs?: number | null;
};
