import { accessSync, constants, statSync } from "node:fs";

import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import { readIdaConfiguration } from "./IdaConfiguration.js";
import { privateRuntimeRootCapability } from "../process/PrivateRuntimeRoot.js";

/** Check the registration without launching IDA, and retain only the configuration file reference. */
export const inspectIdaRegistration = (
  path: string | undefined,
): DoctorProviderInspection => {
  const parsed = path === undefined ? undefined : readIdaConfiguration(path);
  const valid = parsed?.ok === true;
  const workspaceChecks =
    parsed?.ok === true && parsed.value.mode === "headless"
      ? [inspectPrivateWorkspace(parsed.value.workspaceRoot)]
      : [];
  return {
    id: "ida",
    configured: path !== undefined,
    available: valid && workspaceChecks.every(({ ok }) => ok),
    providerVersion: null,
    registrationEnvironment:
      valid && path !== undefined ? { REA_IDA_MCP_CONFIG: path } : {},
    checks: [
      {
        name: "registration",
        ok: valid,
        code: valid
          ? null
          : path === undefined
            ? "not_configured"
            : "invalid_configuration",
        detail: valid
          ? "IDA MCP registration is valid. Upstream availability, compatibility, and target binding are checked when analysis starts; no IDA process was launched."
          : parsed !== undefined && !parsed.ok
            ? parsed.error.message
            : "IDA MCP registration is not configured.",
        remediation: valid
          ? null
          : "Set REA_IDA_MCP_CONFIG to your upstream IDA MCP registration JSON; see docs/ida-provider.md.",
        classification:
          path === undefined ? "missing_analysis_engine" : "config_drift",
      },
      ...workspaceChecks,
    ],
  };
};

/**
 * Check private workspace authority and, when selected, the existing parent
 * that IdaWorkspace.allocate creates its private directory in. Diagnosis only
 * inspects the parent; it never creates or repairs it.
 */
const inspectPrivateWorkspace = (
  workspaceRoot: string | undefined,
): DoctorProviderCheck => {
  const privacy = privateRuntimeRootCapability();
  if (!privacy.available)
    return {
      name: "private_workspace",
      ok: false,
      code: privacy.code,
      detail: privacy.reason,
      remediation: privacy.remediation,
      classification:
        privacy.code === "runtime_missing"
          ? "missing_dependency"
          : privacy.code === "runtime_unavailable"
            ? "runtime_failure"
            : "unsupported_host",
    };
  const unusable =
    workspaceRoot === undefined
      ? undefined
      : workspaceRootFailure(workspaceRoot);
  return unusable === undefined
    ? {
        name: "private_workspace",
        ok: true,
        code: null,
        detail: `Private workspace authority is available (${privacy.proof})${workspaceRoot === undefined ? "" : ` under workspaceRoot ${workspaceRoot}`}.`,
        remediation: null,
        classification: "unsupported_host",
      }
    : {
        name: "private_workspace",
        ok: false,
        code: "invalid_configuration",
        detail: unusable,
        remediation:
          "Set the IDA registration's workspaceRoot to an existing directory REA can create entries in, or omit it to use the system temporary directory; see docs/ida-provider.md.",
        classification: "config_drift",
      };
};

/** Why the selected parent cannot hold a new private directory, if it cannot. */
const workspaceRootFailure = (root: string): string | undefined => {
  try {
    if (!statSync(root).isDirectory())
      return `IDA workspaceRoot ${root} is not a directory.`;
    accessSync(root, constants.W_OK | constants.X_OK);
    return undefined;
  } catch (cause: unknown) {
    return `IDA workspaceRoot ${root} is not a usable directory: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
};
