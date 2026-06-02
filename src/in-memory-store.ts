import type { AgentRun } from "./agent.ts";
import type { Bus, BusMessage } from "./bus.ts";
import type { AgentStore } from "./store.ts";

export class InMemoryAgentStore implements AgentStore {
	private readonly runs = new Map<string, AgentRun>();
	private readonly buses = new Map<string, Bus>();

	saveRun(run: AgentRun): void {
		this.runs.set(run.id, run);
	}

	getRun(id: string): AgentRun | undefined {
		return this.runs.get(id);
	}

	listRuns(): AgentRun[] {
		return [...this.runs.values()];
	}

	saveBus(bus: Bus): void {
		this.buses.set(bus.id, bus);
	}

	getBus(id: string): Bus | undefined {
		return this.buses.get(id);
	}

	addBusMessage(busId: string, message: BusMessage): void {
		const bus = this.buses.get(busId);
		if (!bus) throw new Error(`Bus ${busId} not found.`);

		const existingIndex = bus.messages.findIndex((current) => current.id === message.id);
		if (existingIndex >= 0) {
			bus.messages[existingIndex] = message;
			return;
		}

		bus.messages.push(message);
	}
}
