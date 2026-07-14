import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRun } from "../core/subagent.ts";
import { OrchestraEventController } from "../extension/orchestra-events.ts";
import { InMemoryAgentStore } from "./in-memory-store.ts";
import { observeAgentSessionHealth, PiAgentRuntime } from "./pi-runtime.ts";

const profile = { name: "researcher", systemPrompt: "Research.", tools: [], model: undefined };
const settlingPromptTask = new Promise<void>(() => undefined);

test("runtime health reads context live and hides errors during recoverable phases", () => {
  const harness = createHealthHarness({ contextPercent: 40 });
  harness.state.errorMessage = "provider context error";

  harness.runtimeState.isStreaming = true;
  assert.deepEqual(harness.health.getSnapshot(), { phase: "active", contextPercent: 40 });

  harness.runtimeState.isStreaming = false;
  harness.runtimeState.isRetrying = true;
  assert.deepEqual(harness.health.getSnapshot(), { phase: "retrying", contextPercent: 40 });

  harness.runtimeState.isRetrying = false;
  harness.runtimeState.isCompacting = true;
  assert.deepEqual(harness.health.getSnapshot(), { phase: "compacting", contextPercent: 40 });

  harness.runtimeState.isCompacting = false;
  harness.health.setWaiting();
  assert.deepEqual(harness.health.getSnapshot(), { phase: "waiting", contextPercent: 40 });

  harness.health.beginPrompt();
  assert.equal(harness.health.getSnapshot().finalError, "provider context error");

  harness.runtimeState.contextPercent = 60;
  assert.equal(harness.health.getSnapshot().contextPercent, 60);
});

test("finish-required retry preserves a final provider error and bounds its summary", async () => {
  const store = new InMemoryAgentStore();
  const runId = "finish-required-error";
  store.saveRun(run(runId, null));
  let promptCalls = 0;
  const providerError = "provider context error ".repeat(100);
  let harness: HealthHarness;
  harness = createHealthHarness({
    prompt: async () => {
      if (++promptCalls === 2) harness.state.errorMessage = providerError;
    },
  });
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness);

  await runtimeInternals(runtime).runPrompt(runId, { content: "Task.", busDeliveries: [] });

  const failedRun = store.getRun(runId);
  assert.equal(promptCalls, 2);
  assert.equal(failedRun?.state, "failed");
  assert.equal(failedRun?.result?.status, "failed");
  assert.match(failedRun?.result?.summary ?? "", /provider context error/);
  assert.ok((failedRun?.result?.summary.length ?? 0) <= 500);
  assert.match(failedRun?.result?.summary ?? "", /truncated/);
  assert.deepEqual(failedRun?.result?.data, { providerError });
  runtime.dispose();
});

test("final provider error waits while a direct child is active", async () => {
  const store = new InMemoryAgentStore();
  const runId = "errored-parent";
  store.saveRun(run(runId, null));
  store.saveRun(run("active-child", runId));
  let promptCalls = 0;
  const harness = createHealthHarness({
    prompt: async () => {
      promptCalls++;
      harness.state.errorMessage = "provider failed";
    },
  });
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness);

  await runtimeInternals(runtime).runPrompt(runId, { content: "Task.", busDeliveries: [] });

  assert.equal(promptCalls, 1);
  assert.equal(store.getRun(runId)?.state, "running");
  assert.equal(store.getRun(runId)?.result, null);
  assert.deepEqual(harness.health.getSnapshot(), { phase: "waiting" });
  runtime.dispose();
});

test("a thrown prompt error waits while a direct child is active", async () => {
  const store = new InMemoryAgentStore();
  const runId = "throwing-parent";
  store.saveRun(run(runId, null));
  store.saveRun(run("active-child", runId));
  const harness = createHealthHarness({
    prompt: async () => {
      throw new Error("provider unavailable");
    },
  });
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness);

  await runtimeInternals(runtime).runPrompt(runId, { content: "Task.", busDeliveries: [] });

  assert.equal(store.getRun(runId)?.state, "running");
  assert.equal(harness.health.getSnapshot().phase, "waiting");
  runtime.dispose();
});

test("a child completion resumes a parent parked with a provider error", async () => {
  const store = new InMemoryAgentStore();
  const runId = "resumed-parent";
  const parent = run(runId, null);
  store.saveRun(parent);
  const harness = createHealthHarness({
    prompt: async () => {
      harness.state.errorMessage = undefined;
      store.saveRun({ ...parent, state: "success", result: { status: "success", summary: "Resumed." } });
    },
  });
  harness.state.errorMessage = "previous provider error";
  harness.health.setWaiting();
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness, settlingPromptTask);

  await runtime.message(runId, "Child finished.");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(store.getRun(runId)?.state, "success");
  assert.equal(store.getRun(runId)?.result?.summary, "Resumed.");
  runtime.dispose();
});

test("finish-required prompt waits for a newly spawned child", async () => {
  const store = new InMemoryAgentStore();
  const runId = "finish-required-child";
  store.saveRun(run(runId, null));
  let promptCalls = 0;
  const harness = createHealthHarness({
    prompt: async () => {
      if (++promptCalls === 2) store.saveRun(run("new-child", runId));
    },
  });
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness);

  await runtimeInternals(runtime).runPrompt(runId, { content: "Task.", busDeliveries: [] });

  assert.equal(promptCalls, 2);
  assert.equal(store.getRun(runId)?.state, "running");
  assert.equal(harness.health.getSnapshot().phase, "waiting");
  runtime.dispose();
});

test.each([
  { label: "waiting", waiting: true, promptCalls: 1, steerCalls: 0 },
  { label: "non-waiting", waiting: false, promptCalls: 0, steerCalls: 1 },
])("message handles a $label settling prompt without overlap", async (expected) => {
  const store = new InMemoryAgentStore();
  const runId = `${expected.label}-parent`;
  const parent = run(runId, null);
  store.saveRun(parent);
  let promptCalls = 0;
  let steerCalls = 0;
  const harness = createHealthHarness({
    prompt: async () => {
      promptCalls++;
      store.saveRun({ ...parent, state: "success", result: { status: "success", summary: "Child finished." } });
    },
    steer: async () => {
      steerCalls++;
    },
  });
  if (expected.waiting) harness.health.setWaiting();
  const runtime = createRuntime(store);
  installEntry(runtime, runId, harness, settlingPromptTask);

  const messagedRun = await runtime.message(runId, "Child finished.");

  assert.equal(messagedRun.state, "running");
  assert.equal(promptCalls, expected.promptCalls);
  assert.equal(steerCalls, expected.steerCalls);
  assert.equal(harness.runtimeState.contextUsageCalls, 0);
  runtime.dispose();
});

test("message safely resumes and raw-steers a finished streaming run", async () => {
  const store = new InMemoryAgentStore();
  const finishedRun: AgentRun = {
    ...run("agent-1", null),
    state: "success",
    result: { status: "success", summary: "Done." },
  };
  const resumedRun: AgentRun = { ...finishedRun, state: "running", result: null };
  const concurrentFinishedRun: AgentRun = {
    ...finishedRun,
    state: "blocked",
    result: { status: "blocked", summary: "Concurrent finish." },
  };
  store.saveRun(finishedRun);
  const deliveredEvents: unknown[] = [];
  const events = new OrchestraEventController({
    store,
    sendEvents: (sentEvents) => deliveredEvents.push(...sentEvents),
    isRunWaiting: () => false,
    flushDelayMs: 0,
  });

  const sentUserMessages: Array<{
    content: Parameters<AgentSession["sendUserMessage"]>[0];
    options: Parameters<AgentSession["sendUserMessage"]>[1];
  }> = [];
  const session = {
    isStreaming: true,
    prompt: async () => assert.fail("message must not start a new prompt task"),
    steer: async () => assert.fail("finished-run messages must use the raw user-message pipeline"),
    sendUserMessage: async (
      content: Parameters<AgentSession["sendUserMessage"]>[0],
      options: Parameters<AgentSession["sendUserMessage"]>[1],
    ) => {
      assert.deepEqual(store.getRun(finishedRun.id), resumedRun);
      if (content === "Continue.") throw new Error("Steer rejected.");
      if (content === "Concurrent finish.") {
        store.saveRun(concurrentFinishedRun);
        throw new Error("Steer rejected after finish.");
      }
      sentUserMessages.push({ content, options });
    },
  } as unknown as AgentSession;
  const runtime = new PiAgentRuntime({
    store,
    cwd: undefined,
    resolveModel: undefined,
    resolveCustomTools: undefined,
    ownerSessionId: "session-1",
    onRunRollback: (runId) => events.suppressRunFinish(runId),
  });
  const runtimeWithEntries = runtime as unknown as RuntimeInternals;
  runtimeWithEntries.entries.set(finishedRun.id, {
    session,
    health: observeAgentSessionHealth(session),
  });

  await assert.rejects(runtime.message(finishedRun.id, "Continue."), /Steer rejected/);
  events.flush();
  assert.deepEqual(store.getRun(finishedRun.id), finishedRun);
  assert.deepEqual(deliveredEvents, []);

  await assert.rejects(runtime.message(finishedRun.id, "Concurrent finish."), /Steer rejected after finish/);
  events.flush();
  assert.deepEqual(store.getRun(finishedRun.id), concurrentFinishedRun);
  assert.equal(deliveredEvents.length, 1);

  store.saveRun(resumedRun);
  store.saveRun(finishedRun);
  events.flush();
  assert.equal(deliveredEvents.length, 2);

  const messagedRun = await runtime.message(finishedRun.id, "/review unchanged");

  assert.deepEqual(messagedRun, resumedRun);
  assert.deepEqual(store.getRun(finishedRun.id), resumedRun);
  assert.equal(runtimeWithEntries.entries.get(finishedRun.id)?.promptTask, undefined);
  assert.deepEqual(sentUserMessages, [{ content: "/review unchanged", options: { deliverAs: "steer" } }]);
  events.dispose();
});

interface HealthHarnessOptions {
  contextPercent?: number;
  prompt?: () => Promise<void>;
  steer?: () => Promise<void>;
}

function createHealthHarness(options: HealthHarnessOptions = {}) {
  const state = { errorMessage: undefined as string | undefined };
  const runtimeState = {
    isStreaming: false,
    isRetrying: false,
    isCompacting: false,
    contextPercent: options.contextPercent,
    contextUsageCalls: 0,
  };
  const session = {
    state,
    get isStreaming() {
      return runtimeState.isStreaming;
    },
    get isRetrying() {
      return runtimeState.isRetrying;
    },
    get isCompacting() {
      return runtimeState.isCompacting;
    },
    dispose() {},
    getContextUsage() {
      runtimeState.contextUsageCalls++;
      return runtimeState.contextPercent === undefined
        ? undefined
        : { tokens: null, contextWindow: 1_000, percent: runtimeState.contextPercent };
    },
    prompt: options.prompt ?? (async () => undefined),
    steer: options.steer ?? (async () => undefined),
    messages: [],
  } as unknown as AgentSession;
  return {
    session,
    state,
    runtimeState,
    health: observeAgentSessionHealth(session),
  };
}

type HealthHarness = ReturnType<typeof createHealthHarness>;
type RuntimeInternals = {
  entries: Map<
    string,
    {
      session: AgentSession;
      health: ReturnType<typeof observeAgentSessionHealth>;
      promptTask?: Promise<void>;
    }
  >;
  runPrompt(id: string, message: { content: string; busDeliveries: [] }): Promise<void>;
};

function createRuntime(store: InMemoryAgentStore): PiAgentRuntime {
  return new PiAgentRuntime({
    store,
    cwd: undefined,
    resolveModel: undefined,
    resolveCustomTools: () => [],
    ownerSessionId: "owner",
  });
}

function installEntry(
  runtime: PiAgentRuntime,
  runId: string,
  { session, health }: HealthHarness,
  promptTask?: Promise<void>,
): void {
  runtimeInternals(runtime).entries.set(runId, { session, health, ...(promptTask ? { promptTask } : {}) });
}

function runtimeInternals(runtime: PiAgentRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals;
}

function run(id: string, parentRunId: string | null): AgentRun {
  return {
    id,
    name: id,
    profile,
    task: "Task.",
    busId: "bus-1",
    ownerSessionId: "session-1",
    parentRunId,
    sessionFile: `.pi/orchestra/sessions/${id}.jsonl`,
    state: "running",
    result: null,
  };
}
