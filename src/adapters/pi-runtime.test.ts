import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, test, vi } from "vitest";
import { createBusSubscriptionId, type BusSubscription } from "../core/bus.ts";
import type { AgentProfile, AgentRun } from "../core/subagent.ts";
import type { WorkgroupRun } from "../core/workgroup.ts";
import { InMemoryAgentStore } from "./in-memory-store.ts";
import { getProjectOrchestraSessionDir, PiAgentRuntime } from "./pi-runtime.ts";

const codingAgentMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  sessionManagerCreate: vi.fn((cwd: string, sessionDir: string) => ({
    cwd,
    sessionDir,
    type: "file",
    getSessionFile: () => `${sessionDir}/mock-session.jsonl`,
  })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: codingAgentMocks.createAgentSession,
  SessionManager: {
    create: codingAgentMocks.sessionManagerCreate,
  },
}));

test("pi runtime spawns sessions with resolved models, tools, and the initial prompt", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const session = queueSession();
  const resolvedModel = model({ provider: "mock-provider", id: "mock-model" });
  const resolveModel = vi.fn(async () => resolvedModel);
  const runtime = new PiAgentRuntime({ store, cwd: "/workspace", resolveModel, resolveCustomTools: undefined });

  const run = await runtime.spawn(
    {
      name: "researcher",
      systemPrompt: "Research the assigned task.",
      tools: ["read", "bash", "read"],
      model: "mock-provider/mock-model",
    },
    "Inspect the code.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );

  assert.deepEqual(run, {
    id: "agent-1",
    name: "Agent 1",
    profile: {
      name: "researcher",
      systemPrompt: "Research the assigned task.",
      tools: ["read", "bash", "read"],
      model: "mock-provider/mock-model",
    },
    task: "Inspect the code.",
    busId: "bus-1",
    parentRunId: null,
    sessionFile: `${getProjectOrchestraSessionDir("/workspace")}/mock-session.jsonl`,
    state: "running",
    result: null,
  });
  assert.deepEqual(store.getRun(run.id), run);
  assert.deepEqual(store.getBusSubscription(createBusSubscriptionId("bus-1", "agent", run.id)), {
    id: createBusSubscriptionId("bus-1", "agent", run.id),
    busId: "bus-1",
    subscriberId: run.id,
    subscriberKind: "agent",
    lastDeliveredMessageId: null,
    deliveredMessageIds: [],
  });
  assert.deepEqual(resolveModel.mock.calls, [["mock-provider/mock-model"]]);
  assert.deepEqual(codingAgentMocks.sessionManagerCreate.mock.calls, [
    ["/workspace", getProjectOrchestraSessionDir("/workspace")],
  ]);

  const options = lastCreateAgentSessionOptions();
  assert.equal(options.cwd, "/workspace");
  assert.equal(options.model, resolvedModel);
  assert.deepEqual(options.tools, ["read", "bash", "finish", "publish_bus"]);
  assert.deepEqual(
    options.customTools.map((tool) => tool.name),
    ["finish", "publish_bus"],
  );
  assert.equal(session.promptCalls.length, 1);
  assert.match(session.promptCalls[0]?.message ?? "", /You are subagent run "Agent 1" with profile "researcher"\./);
  assert.match(session.promptCalls[0]?.message ?? "", /## System prompt\nResearch the assigned task\./);
  assert.match(session.promptCalls[0]?.message ?? "", /## Task\nInspect the code\./);
  assert.match(session.promptCalls[0]?.message ?? "", /End with exactly one finalization path/);
  assert.deepEqual(session.promptCalls[0]?.options, { expandPromptTemplates: false });
});

test("pi runtime registers requested profile custom tools in child sessions", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  queueSession();
  const busTool = toolDefinition("bus");
  const workflowTool = toolDefinition("workflow");
  const workgroupTool = toolDefinition("workgroup");
  const runtime = new PiAgentRuntime({
    store,
    cwd: undefined,
    resolveModel: undefined,
    resolveCustomTools: () => [busTool, workflowTool, workgroupTool],
  });

  await runtime.spawn(
    { name: "flow-leader", systemPrompt: "Lead the workflow.", tools: ["bus", "workflow", "read"], model: undefined },
    "Lead the work.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );

  const options = lastCreateAgentSessionOptions();
  assert.deepEqual(options.tools, ["workflow", "read", "finish", "publish_bus"]);
  assert.deepEqual(
    options.customTools.map((tool) => tool.name),
    ["workflow", "finish", "publish_bus"],
  );
});

test("pi runtime rejects profiles without explicit tools", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });

  await assert.rejects(
    () =>
      runtime.spawn(
        { name: "researcher", systemPrompt: "Research the task.", model: undefined } as AgentProfile,
        "Inspect the code.",
        "bus-1",
        { id: "agent-1", name: "Agent 1" },
      ),
    /Profile "researcher" must specify tools\./,
  );
  assert.equal(codingAgentMocks.createAgentSession.mock.calls.length, 0);
  assert.equal(codingAgentMocks.sessionManagerCreate.mock.calls.length, 0);
});

test("pi runtime injects unread bus messages once and skips messages from the same run", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({
    id: "bus-1",
    name: "Bus 1",
    state: "open",
    messages: [
      { id: "message-1", from: "main", message: "Existing shared context." },
      { id: "message-2", from: "agent-1", message: "Own message." },
    ],
  });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });

  await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-1",
    {
      id: "agent-1",
      name: "Agent 1",
    },
  );

  assert.match(session.promptCalls[0]?.message ?? "", /<bus_reference_context>/);
  assert.match(session.promptCalls[0]?.message ?? "", /Existing shared context\./);
  assert.doesNotMatch(session.promptCalls[0]?.message ?? "", /Own message\./);

  session.isStreaming = false;
  await runtime.message("agent-1", "Continue with the same context.");

  assert.equal(session.promptCalls.length, 1);
  assert.equal(session.steerCalls.at(-1), "Continue with the same context.");
});

test("pi runtime publishes bus messages and steers active sibling sessions without replaying seen messages", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const firstSession = queueSession();
  const secondSession = queueSession();
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });
  const firstRun = await runtime.spawn(
    { name: "first", systemPrompt: "Do first task.", tools: ["read", "bash"], model: undefined },
    "First task.",
    "bus-1",
    {
      id: "agent-1",
      name: "Agent 1",
    },
  );
  const secondRun = await runtime.spawn(
    { name: "second", systemPrompt: "Do second task.", tools: ["read", "bash"], model: undefined },
    "Second task.",
    "bus-1",
    {
      id: "agent-2",
      name: "Agent 2",
    },
  );

  const busMessage = await runtime.publishBus("bus-1", "New shared fact.", firstRun.id);

  assert.equal(busMessage.message, "New shared fact.");
  assert.equal(busMessage.from, firstRun.id);
  assert.deepEqual(store.getBus("bus-1")?.messages, [busMessage]);
  assert.deepEqual(firstSession.steerCalls, []);
  assert.equal(secondSession.steerCalls.length, 1);
  assert.match(secondSession.steerCalls[0] ?? "", /<bus_reference_context>/);
  assert.match(secondSession.steerCalls[0] ?? "", /<bus_message from="Agent 1">/);
  assert.doesNotMatch(secondSession.steerCalls[0] ?? "", /<bus_message from="agent-1">/);
  assert.match(secondSession.steerCalls[0] ?? "", /New shared fact\./);

  secondSession.isStreaming = false;
  await runtime.message(secondRun.id, "Continue after seeing the bus fact.");

  assert.equal(secondSession.promptCalls.length, 1);
  assert.equal(secondSession.steerCalls.at(-1), "Continue after seeing the bus fact.");
});

test("pi runtime preserves skipped earlier bus messages after later steering delivery", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });
  const run = await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );

  session.isStreaming = false;
  const skippedMessage = await runtime.publishBus("bus-1", "Skipped while idle.", "main");
  session.isStreaming = true;
  const steeredMessage = await runtime.publishBus("bus-1", "Steered while streaming.", "main");

  assert.equal(session.steerCalls.length, 1);
  assert.match(session.steerCalls[0] ?? "", /Steered while streaming\./);
  assert.deepEqual(store.getBusSubscription(createBusSubscriptionId("bus-1", "agent", run.id)), {
    id: createBusSubscriptionId("bus-1", "agent", run.id),
    busId: "bus-1",
    subscriberId: run.id,
    subscriberKind: "agent",
    lastDeliveredMessageId: null,
    deliveredMessageIds: [steeredMessage.id],
  });

  session.isStreaming = false;
  await runtime.message(run.id, "Continue with bus context.");

  assert.equal(session.steerCalls.length, 2);
  assert.match(session.steerCalls[1] ?? "", /Skipped while idle\./);
  assert.doesNotMatch(session.steerCalls[1] ?? "", /Steered while streaming\./);
  assert.deepEqual(store.getBusSubscription(createBusSubscriptionId("bus-1", "agent", run.id)), {
    id: createBusSubscriptionId("bus-1", "agent", run.id),
    busId: "bus-1",
    subscriberId: run.id,
    subscriberKind: "agent",
    lastDeliveredMessageId: steeredMessage.id,
    deliveredMessageIds: [],
  });
  assert.equal(skippedMessage.id < steeredMessage.id, true);
});

test("pi runtime publishes bus messages to active subscribers rather than run bus membership", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  store.saveBus({ id: "bus-2", name: "Bus 2", state: "open", messages: [] });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });
  const run = await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-2",
    { id: "agent-1", name: "Agent 1" },
  );
  store.saveBusSubscription({
    id: createBusSubscriptionId("bus-1", "agent", run.id),
    busId: "bus-1",
    subscriberId: run.id,
    subscriberKind: "agent",
    lastDeliveredMessageId: null,
    deliveredMessageIds: [],
  });

  await runtime.publishBus("bus-1", "Subscribed fact.", "main");

  assert.equal(run.busId, "bus-2");
  assert.equal(session.steerCalls.length, 1);
  assert.match(session.steerCalls[0] ?? "", /Subscribed fact\./);
});

test("pi runtime child tools publish to the run bus, finish runs, and reject closed runs", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });
  const run = await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );
  const publishBusTool = customTool("publish_bus");
  const finishTool = customTool("finish");

  const publishOutput = await publishBusTool.execute("tool-call-1", { message: "Sibling reference." });
  const publishDetails = publishOutput.details;
  assert.ok(publishDetails && "message" in publishDetails);

  assert.equal(publishDetails.message, "Sibling reference.");
  assert.equal(publishDetails.from, run.id);
  assert.deepEqual(store.getBus(run.busId)?.messages, [publishDetails]);

  const finishOutput = await finishTool.execute("tool-call-2", {
    status: "success",
    summary: "Inspection complete.",
    data: { files: 3 },
  });

  assert.equal(finishOutput.terminate, true);
  assert.deepEqual(finishOutput.details, { status: "success", summary: "Inspection complete.", data: { files: 3 } });
  assert.deepEqual(store.getRun(run.id)?.result, finishOutput.details);
  assert.equal(store.getRun(run.id)?.state, "success");

  await runtime.close(run.id);
  assert.equal(store.getBusSubscription(createBusSubscriptionId(run.busId, "agent", run.id)), undefined);
  assert.equal(session.disposed, true);
  await assert.rejects(
    () => finishTool.execute("tool-call-3", { status: "success", summary: "Too late." }),
    /Agent Agent 1 is closed\./,
  );
});

test("pi runtime finish requires running workgroup leaders to finish the workgroup first", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  queueSession();
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });
  const run = await runtime.spawn(
    { name: "leader", systemPrompt: "Lead the group.", tools: ["workgroup"], model: undefined },
    "Lead the workgroup.",
    "bus-1",
    { id: "leader-1", name: "Leader 1" },
  );
  store.saveWorkgroup(workgroupRun({ leaderRunId: run.id, state: "running" }));
  const finishTool = customTool("finish");

  await assert.rejects(
    () => finishTool.execute("tool-call-1", { status: "success", summary: "Too early." }),
    /Agent Leader 1 leads running workgroup workgroup-1; use workgroup action=finish before finish\./,
  );

  store.saveWorkgroup(
    workgroupRun({ leaderRunId: run.id, state: "closed", result: { status: "success", summary: "Done." } }),
  );
  const output = await finishTool.execute("tool-call-2", { status: "success", summary: "Leader done." });

  assert.equal(output.terminate, true);
  assert.equal(store.getRun(run.id)?.state, "success");
});

test("pi runtime steers streaming running runs and restarts idle result runs on message", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });
  const run = await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );

  const steeredRun = await runtime.message(run.id, "Please adjust your approach.");

  assert.deepEqual(steeredRun, run);
  assert.deepEqual(session.steerCalls, ["Please adjust your approach."]);
  assert.equal(session.promptCalls.length, 1);

  store.saveRun({
    ...run,
    state: "blocked",
    result: { status: "blocked", summary: "Need direction." },
  });
  session.isStreaming = false;

  const restartedRun = await runtime.message(run.id, "Use option B.");

  assert.equal(restartedRun.state, "running");
  assert.equal(restartedRun.result, null);
  assert.equal(store.getRun(run.id)?.state, "running");
  assert.equal(session.promptCalls.at(-1)?.message, "Use option B.");
});

test("pi runtime steers running runs with an in-flight prompt task before streaming starts", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });
  const run = await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );
  session.isStreaming = false;

  const messagedRun = await runtime.message(run.id, "Use the new constraint.");

  assert.deepEqual(messagedRun, run);
  assert.deepEqual(session.steerCalls, ["Use the new constraint."]);
  assert.equal(session.promptCalls.length, 1);
  assert.equal(store.getRun(run.id)?.state, "running");
});

test("pi runtime close prunes entries while preserving closed-run message errors", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });
  const run = await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );

  await runtime.close(run.id);

  assert.equal(session.disposed, true);
  await assert.rejects(() => runtime.message(run.id, "Too late."), /Agent Agent 1 is closed\./);
});

test("pi runtime dispose closes runs before disposing sessions and does not prompt for missing finish", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const promptGate = createDeferred();
  const session = queueSession(new FakeSession(() => promptGate.promise));
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });
  const run = await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );

  runtime.dispose();
  promptGate.resolve();
  await waitForMicrotasks();

  assert.equal(store.getRun(run.id)?.state, "closed");
  assert.equal(session.disposed, true);
  assert.equal(session.promptCalls.length, 1);
  await assert.rejects(() => runtime.message(run.id, "Too late."), /PiAgentRuntime is disposed\./);
});

test("pi runtime dispose preserves completed run status", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });
  const run = await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );
  store.saveRun({ ...run, state: "success", result: { status: "success", summary: "Done." } });

  runtime.dispose();

  assert.equal(store.getRun(run.id)?.state, "success");
  assert.equal(session.disposed, true);
});

test("pi runtime reports prompt task rejections through the prompt task error hook", async () => {
  const store = new PromptTaskErrorStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  queueSession();
  const promptTaskErrors: Array<{ runId: string; error: unknown }> = [];
  const runtime = new PiAgentRuntime({
    store,
    cwd: undefined,
    resolveModel: undefined,
    resolveCustomTools: undefined,
    onPromptTaskError: (runId, error) => promptTaskErrors.push({ runId, error }),
  });

  await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );
  await waitForMicrotasks();

  assert.equal(promptTaskErrors.length, 1);
  assert.equal(promptTaskErrors[0]?.runId, "agent-1");
  assert.match(promptTaskErrors[0]?.error instanceof Error ? promptTaskErrors[0].error.message : "", /getRun failed/);
});

test("pi runtime marks a run failed when the session ends without finish", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  queueSession(
    new FakeSession((_message, _options, session) => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `assistant text ${session.promptCalls.length}` }],
      });
    }),
  );
  const runtime = new PiAgentRuntime({ store, cwd: undefined, resolveModel: undefined, resolveCustomTools: undefined });

  await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: undefined },
    "Inspect the code.",
    "bus-1",
    {
      id: "agent-1",
      name: "Agent 1",
    },
  );
  const failedRun = await waitForRunResultStatus(store, "agent-1", "failed");
  const session = queuedSessions[0];

  assert.equal(session?.promptCalls.length, 2);
  assert.match(session?.promptCalls[1]?.message ?? "", /Your previous response ended without finish\./);
  assert.deepEqual(failedRun.result, {
    status: "failed",
    summary: "Agent stopped without calling finish.",
    data: "assistant text 2",
  });
});

test("pi runtime rejects unresolved profile models before creating a session", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", state: "open", messages: [] });
  const runtime = new PiAgentRuntime({
    store,
    cwd: undefined,
    resolveModel: async () => undefined,
    resolveCustomTools: undefined,
  });

  await assert.rejects(
    () =>
      runtime.spawn(
        { name: "researcher", systemPrompt: "Research the task.", tools: ["read", "bash"], model: "missing/model" },
        "Inspect the code.",
        "bus-1",
        { id: "agent-1", name: "Agent 1" },
      ),
    /Could not resolve profile model "missing\/model"\./,
  );
  assert.equal(codingAgentMocks.createAgentSession.mock.calls.length, 0);
  assert.equal(codingAgentMocks.sessionManagerCreate.mock.calls.length, 0);
});

beforeEach(() => {
  queuedSessions.length = 0;
  codingAgentMocks.createAgentSession.mockReset();
  codingAgentMocks.sessionManagerCreate.mockClear();
});

const queuedSessions: FakeSession[] = [];

interface PromptOptions {
  expandPromptTemplates?: boolean;
}

interface PromptCall {
  message: string;
  options?: PromptOptions;
}

interface FakeMessage {
  role: string;
  content: Array<{ type: string; text?: string }>;
}

type PromptImpl = (message: string, options: PromptOptions | undefined, session: FakeSession) => void | Promise<void>;

class FakeSession {
  isStreaming = true;
  messages: FakeMessage[] = [];
  promptCalls: PromptCall[] = [];
  steerCalls: string[] = [];
  disposed = false;

  constructor(private readonly promptImpl?: PromptImpl) {}

  prompt(message: string, options?: PromptOptions): Promise<void> {
    this.promptCalls.push({ message, options });
    this.isStreaming = true;
    if (!this.promptImpl) return new Promise(() => {});

    try {
      return Promise.resolve(this.promptImpl(message, options, this)).finally(() => {
        this.isStreaming = false;
      });
    } catch (error) {
      this.isStreaming = false;
      return Promise.reject(error);
    }
  }

  async steer(message: string): Promise<void> {
    this.steerCalls.push(message);
  }

  dispose(): void {
    this.disposed = true;
  }
}

function queueSession(session = new FakeSession()): FakeSession {
  queuedSessions.push(session);
  codingAgentMocks.createAgentSession.mockResolvedValueOnce({ session });
  return session;
}

interface CreateAgentSessionOptions {
  cwd: string;
  model?: unknown;
  tools: string[];
  customTools: CapturedTool[];
  sessionManager: unknown;
}

interface CapturedToolOutput {
  content: Array<{ type: "text"; text: string }>;
  details?: CapturedToolDetails;
  terminate?: boolean;
}

type CapturedToolDetails =
  | {
      status: string;
      summary: string;
      data?: unknown;
    }
  | {
      id: string;
      from: string;
      message: string;
    };

interface CapturedTool {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<CapturedToolOutput>;
}

function lastCreateAgentSessionOptions(): CreateAgentSessionOptions {
  const call = codingAgentMocks.createAgentSession.mock.calls.at(-1);
  assert.ok(call);
  return call[0] as CreateAgentSessionOptions;
}

function customTool(name: string): CapturedTool {
  const tool = lastCreateAgentSessionOptions().customTools.find((current) => current.name === name);
  assert.ok(tool);
  return tool;
}

function toolDefinition(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text" as const, text: `${name} called.` }] }),
  } as unknown as ToolDefinition;
}

function model(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
  return {
    id: "model",
    name: "Model",
    api: "openai-responses",
    provider: "mock-provider",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    ...overrides,
  };
}

class PromptTaskErrorStore extends InMemoryAgentStore {
  private throwOnGetRun = false;

  override saveBusSubscription(subscription: BusSubscription): void {
    super.saveBusSubscription(subscription);
    this.throwOnGetRun = true;
  }

  override getRun(id: string): AgentRun | undefined {
    if (this.throwOnGetRun) throw new Error("getRun failed.");
    return super.getRun(id);
  }
}

function createDeferred(): { promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitForMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function workgroupRun(overrides: Partial<WorkgroupRun> = {}): WorkgroupRun {
  return {
    id: "workgroup-1",
    name: "workgroup-1",
    busId: "bus-1",
    goal: "Complete workgroup.",
    leaderRunId: null,
    memberRunIds: [],
    state: "running",
    result: null,
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function waitForRunResultStatus(
  store: InMemoryAgentStore,
  id: string,
  status: NonNullable<AgentRun["result"]>["status"],
): Promise<AgentRun> {
  const currentRun = store.getRun(id);
  if (currentRun?.result?.status === status) return Promise.resolve(currentRun);

  return new Promise((resolve) => {
    const unsubscribe = store.subscribeRuns(
      (run) => {
        if (run.result?.status !== status) return;
        unsubscribe();
        resolve(run);
      },
      (run) => run.id === id,
    );
  });
}
