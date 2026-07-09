import { BUS_NAME_MAX_LENGTH } from "./core/bus.ts";
import { normalizeEntityName } from "./utils.ts";

export type OrchestraNamePrefix = "agent" | "bus" | "group" | "flow";

export function createPrefixedName(
  prefix: OrchestraNamePrefix,
  name: string,
  entityLabel: string,
  maxLength = 64,
): string {
  const normalizedName = normalizeEntityName(name, entityLabel, maxLength);
  if (hasPrefix(normalizedName, prefix)) return normalizedName;

  const prefixLength = `${prefix}-`.length;
  const maxLogicalNameLength = maxLength - prefixLength;
  if (normalizedName.length > maxLogicalNameLength) {
    throw new Error(
      `${entityLabel} name must be ${maxLogicalNameLength} characters or fewer before the ${prefix}- prefix is added.`,
    );
  }
  return `${prefix}-${normalizedName}`;
}

export function createBusNameFromOwnerName(
  ownerName: string,
  entityLabel = "Bus",
  maxLength = BUS_NAME_MAX_LENGTH,
): string {
  const normalizedOwner = normalizeEntityName(ownerName, entityLabel);
  const busName = `bus-${normalizedOwner}`;
  if (busName.length > maxLength) {
    throw new Error(
      `${entityLabel} name derived from ${normalizedOwner} is ${busName.length} characters; use a shorter owner name so the internal bus name is ${maxLength} characters or fewer.`,
    );
  }
  return busName;
}

export function getBusOwnerRawNameBudget(ownerPrefix: OrchestraNamePrefix, maxLength = BUS_NAME_MAX_LENGTH): number {
  return maxLength - "bus-".length - `${ownerPrefix}-`.length;
}

function hasPrefix(name: string, prefix: OrchestraNamePrefix): boolean {
  return name.startsWith(`${prefix}-`);
}
