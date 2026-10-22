import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../application/OptionalObservationProviders.js";
import { err } from "../domain/result.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
} from "../application/analysisView/AnalysisViewService.js";
import { analysisDetailSchema } from "../contracts/analysisDetail.js";

import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "../application/BrowserScenarioCaptureService.js";
import { toolContract } from "../contracts/toolContracts.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";
import type { Logger } from "pino";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";
import { deliverEvidenceResult } from "./contractToolHandler.js";

interface BrowserScenarioToolRegistration {
  readonly logger: Logger;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
  readonly provider: BrowserScenarioCapturePort | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  readonly evidenceById?: EvidenceLookup | undefined;
  readonly withAdmittedAnalysis?: WithAdmittedAnalysis;
}

/** Register the browser scenario tool with execution-time provider diagnostics. */
export const registerBrowserScenarioTool = (
  server: EvidenceMcpServer,
  options: BrowserScenarioToolRegistration,
): void => {
  const contract = toolContract("capture_browser_scenario");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      // Delivery detail is not part of the scenario or its recorded parameters.
      const { detail: requestedDetail, ...scenarioInput } = input;
      const parsedScenario = browserScenarioSchema.safeParse(scenarioInput);
      const parsedDetail = analysisDetailSchema.safeParse(requestedDetail);
      if (!parsedScenario.success || !parsedDetail.success) {
        const issues = [
          ...(parsedScenario.error?.issues ?? []),
          ...(parsedDetail.error?.issues.map((issue) => ({
            ...issue,
            path: ["detail", ...issue.path],
          })) ?? []),
        ];
        return server.delivery.toCallToolResult(
          err(
            analysisInputErrorFromIssues(contract.name, issues, input, {
              cause: parsedScenario.error ?? parsedDetail.error,
            }),
          ),
          contract,
        );
      }
      const scenario = parsedScenario.data;
      const detail = parsedDetail.data;
      if (options.loadFailure !== undefined)
        return server.delivery.toCallToolResult(
          err(optionalProviderUnavailable(options.loadFailure, contract.name)),
          contract,
        );
      return runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const retention = {
            recordEvidence: options.recordEvidence,
            evidenceById: options.evidenceById,
          };
          // Refuse summary delivery before launching a browser that could not retain its Evidence.
          if (detail === "summary") {
            const ready = requireAnalysisViewRetention(
              contract.name,
              retention,
            );
            if (!ready.ok)
              return server.delivery.toCallToolResult(ready, contract);
          }
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () =>
              captureBrowserScenario(options.provider, scenario, {
                signal: context.mcpReq.signal,
              }),
          );
          return deliverEvidenceResult(
            server,
            detail === "summary" && result.ok
              ? summarizeRetainedAnalysis(result.value, retention)
              : result,
            contract,
            options.recordEvidence,
          );
        },
      );
    },
  );
};
