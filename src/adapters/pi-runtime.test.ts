import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { beforeEach, test, vi } from "vitest";
import type { AgentRun } from "../core/subagent.ts";
import { InMemoryAgentStore } from "./in-memory-store.ts";
import { PiAgentRuntime } from "./pi-runtime.ts";

const codingAgentMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  sessionManagerInMemory: vi.fn((cwd: string) => ({ cwd, type: "in-memory" })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: codingAgentMocks.createAgentSession,
  SessionManager: {
    inMemory: codingAgentMocks.sessionManagerInMemory,
  },
}));

test("pi runtime spawns sessions with resolved models, tools, and the initial prompt", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", messages: [] });
  const session = queueSession();
  const resolvedModel = model({ provider: "mock-provider", id: "mock-model" });
  const resolveModel = vi.fn(async () => resolvedModel);
  const runtime = new PiAgentRuntime({ store, cwd: "/workspace", resolveModel });

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
    profile: "researcher",
    task: "Inspect the code.",
    busId: "bus-1",
    state: "idle",
  });
  assert.equal(store.getRun(run.id), run);
  assert.deepEqual(resolveModel.mock.calls, [["mock-provider/mock-model"]]);
  assert.deepEqual(codingAgentMocks.sessionManagerInMemory.mock.calls, [["/workspace"]]);

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
  assert.match(session.promptCalls[0]?.message ?? "", /Task:\nInspect the code\./);
  assert.match(session.promptCalls[0]?.message ?? "", /You MUST call the finish tool/);
  assert.deepEqual(session.promptCalls[0]?.options, { expandPromptTemplates: false });
});

test("pi runtime injects unread bus messages once and skips messages from the same run", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({
    id: "bus-1",
    name: "Bus 1",
    messages: [
      { id: "message-1", from: "main", message: "Existing shared context." },
      { id: "message-2", from: "agent-1", message: "Own message." },
    ],
  });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store });

  await runtime.spawn({ name: "researcher", systemPrompt: "Research the task." }, "Inspect the code.", "bus-1", {
    id: "agent-1",
    name: "Agent 1",
  });

  assert.match(session.promptCalls[0]?.message ?? "", /<bus_reference_context>/);
  assert.match(session.promptCalls[0]?.message ?? "", /Existing shared context\./);
  assert.doesNotMatch(session.promptCalls[0]?.message ?? "", /Own message\./);

  session.isStreaming = false;
  await runtime.message("agent-1", "Continue with the same context.");

  assert.equal(session.promptCalls.at(-1)?.message, "Continue with the same context.");
});

test("pi runtime publishes bus messages and steers active sibling sessions without replaying seen messages", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", messages: [] });
  const firstSession = queueSession();
  const secondSession = queueSession();
  const runtime = new PiAgentRuntime({ store });
  const firstRun = await runtime.spawn({ name: "first", systemPrompt: "Do first task." }, "First task.", "bus-1", {
    id: "agent-1",
    name: "Agent 1",
  });
  const secondRun = await runtime.spawn({ name: "second", systemPrompt: "Do second task." }, "Second task.", "bus-1", {
    id: "agent-2",
    name: "Agent 2",
  });

  const busMessage = await runtime.publishBus("bus-1", "New shared fact.", firstRun.id);

  assert.equal(busMessage.message, "New shared fact.");
  assert.equal(busMessage.from, firstRun.id);
  assert.deepEqual(store.getBus("bus-1")?.messages, [busMessage]);
  assert.deepEqual(firstSession.steerCalls, []);
  assert.equal(secondSession.steerCalls.length, 1);
  assert.match(secondSession.steerCalls[0] ?? "", /<bus_reference_context>/);
  assert.match(secondSession.steerCalls[0] ?? "", /New shared fact\./);

  secondSession.isStreaming = false;
  await runtime.message(secondRun.id, "Continue after seeing the bus fact.");

  assert.equal(secondSession.promptCalls.at(-1)?.message, "Continue after seeing the bus fact.");
});

test("pi runtime child tools publish to the run bus, finish runs, and reject closed runs", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", messages: [] });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store });
  const run = await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task." },
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
  assert.equal(session.disposed, true);
  await assert.rejects(
    () => finishTool.execute("tool-call-3", { status: "success", summary: "Too late." }),
    /Agent agent-1 is closed\./,
  );
});

test("pi runtime steers streaming idle runs and restarts terminal runs on message", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", messages: [] });
  const session = queueSession();
  const runtime = new PiAgentRuntime({ store });
  const run = await runtime.spawn(
    { name: "researcher", systemPrompt: "Research the task." },
    "Inspect the code.",
    "bus-1",
    { id: "agent-1", name: "Agent 1" },
  );

  const steeredRun = await runtime.message(run.id, "Please adjust your approach.");

  assert.equal(steeredRun, run);
  assert.deepEqual(session.steerCalls, ["Please adjust your approach."]);
  assert.equal(session.promptCalls.length, 1);

  store.saveRun({
    ...run,
    state: "blocked",
    result: { status: "blocked", summary: "Need direction." },
  });
  session.isStreaming = false;

  const restartedRun = await runtime.message(run.id, "Use option B.");

  assert.equal(restartedRun.state, "idle");
  assert.equal(restartedRun.result, undefined);
  assert.equal(store.getRun(run.id)?.state, "idle");
  assert.equal(session.promptCalls.at(-1)?.message, "Use option B.");
});

test("pi runtime marks a run failed when the session ends without finish", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", messages: [] });
  queueSession(
    new FakeSession((_message, _options, session) => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `assistant text ${session.promptCalls.length}` }],
      });
    }),
  );
  const runtime = new PiAgentRuntime({ store });

  await runtime.spawn({ name: "researcher", systemPrompt: "Research the task." }, "Inspect the code.", "bus-1", {
    id: "agent-1",
    name: "Agent 1",
  });
  const failedRun = await waitForRunState(store, "agent-1", "failed");
  const session = queuedSessions[0];

  assert.equal(session?.promptCalls.length, 2);
  assert.match(
    session?.promptCalls[1]?.message ?? "",
    /Your previous response ended without calling the finish tool\./,
  );
  assert.deepEqual(failedRun.result, {
    status: "failed",
    summary: "Agent stopped without calling finish.",
    data: "assistant text 2",
  });
});

test("pi runtime rejects unresolved profile models before creating a session", async () => {
  const store = new InMemoryAgentStore();
  store.saveBus({ id: "bus-1", name: "Bus 1", messages: [] });
  const runtime = new PiAgentRuntime({ store, resolveModel: async () => undefined });

  await assert.rejects(
    () =>
      runtime.spawn(
        { name: "researcher", systemPrompt: "Research the task.", model: "missing/model" },
        "Inspect the code.",
        "bus-1",
        { id: "agent-1", name: "Agent 1" },
      ),
    /Could not resolve profile model "missing\/model"\./,
  );
  assert.equal(codingAgentMocks.createAgentSession.mock.calls.length, 0);
});

beforeEach(() => {
  queuedSessions.length = 0;
  codingAgentMocks.createAgentSession.mockReset();
  codingAgentMocks.sessionManagerInMemory.mockClear();
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

function waitForRunState(store: InMemoryAgentStore, id: string, state: AgentRun["state"]): Promise<AgentRun> {
  const currentRun = store.getRun(id);
  if (currentRun?.state === state) return Promise.resolve(currentRun);

  return new Promise((resolve) => {
    const unsubscribe = store.subscribeRun(id, (run) => {
      if (run.state !== state) return;
      unsubscribe();
      resolve(run);
    });
  });
}
