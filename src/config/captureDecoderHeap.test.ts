import { expect, it } from "vitest";

import { NodeCaptureAdapter } from "../browser/history/NodeCaptureAdapter.js";
import { HistoricalCaptureDecoder } from "../browser/history/HistoricalCaptureDecoder.js";
import { historicalCaptureFailure } from "../browser/history/CaptureFailures.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { inspectWebNetworkCaptureInputSchema } from "../domain/webNetworkCapture.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { createWebNetworkCaptureService } from "../composition/webNetworkCaptures.js";
import { parseEnvironment } from "./environment.js";
import { parseConfig } from "./parseConfig.js";
import {
  CAPTURE_DECODER_OLD_GENERATION_SETTING,
  captureDecoderHeapConstraint,
  captureDecoderHeapRecovery,
  DEFAULT_CAPTURE_DECODER_HEAP,
  MAXIMUM_CAPTURE_DECODER_OLD_GENERATION_MIB,
  parseCaptureDecoderHeap,
} from "./captureDecoderHeap.js";

const configured = (oldGenerationMiB: number) =>
  ({ oldGenerationMiB, source: "setting" }) as const;

const heapExhaustion = () => {
  const stderr =
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n";
  return new OwnedCommandFailure("process", "Decoder failed", {
    stdout: { text: "", bytes: 0, observedBytes: 0 },
    stderr: {
      text: stderr,
      bytes: Buffer.byteLength(stderr),
      observedBytes: Buffer.byteLength(stderr),
    },
    exitCode: null,
    signal: "SIGABRT",
  });
};

it("keeps the 192 MiB decoder heap when the setting is unset", async () => {
  expect(parseCaptureDecoderHeap(undefined)).toEqual({
    ok: true,
    value: DEFAULT_CAPTURE_DECODER_HEAP,
  });
  const parsed = parseConfig({});
  if (!parsed.ok) throw new Error("unset heap was rejected");
  const recovery = captureDecoderHeapRecovery(DEFAULT_CAPTURE_DECODER_HEAP);
  expect(recovery).toContain(
    "The effective REA_CAPTURE_DECODER_OLD_GENERATION_MIB value is 192 MiB (source default; default 192 MiB, floor 8 MiB, maximum 16384 MiB).",
  );
  expect(recovery).toContain(
    "Set REA_CAPTURE_DECODER_OLD_GENERATION_MIB in the environment that starts REA to a decimal integer from 8 to 16384, then restart REA.",
  );
  expect(recovery).not.toContain("no runtime override");
  const command = await new NodeCaptureAdapter("har").command(
    "/owned/request.json",
  );
  expect(command.arguments).toContain("--max-old-space-size=192");
  expect(command.arguments).toContain("--max-semi-space-size=8");
});

it("uses a valid REA_CAPTURE_DECODER_OLD_GENERATION_MIB override", async () => {
  expect(parseCaptureDecoderHeap("256")).toEqual({
    ok: true,
    value: configured(256),
  });
  expect(
    parseCaptureDecoderHeap(String(MAXIMUM_CAPTURE_DECODER_OLD_GENERATION_MIB)),
  ).toEqual({
    ok: true,
    value: configured(MAXIMUM_CAPTURE_DECODER_OLD_GENERATION_MIB),
  });
  const environment = { REA_CAPTURE_DECODER_OLD_GENERATION_MIB: "256" };
  const parsed = parseConfig(environment);
  if (!parsed.ok) throw new Error("valid heap was rejected");
  const adapter = new NodeCaptureAdapter("har", environment);
  expect(adapter.heap).toEqual(configured(256));
  const command = await adapter.command("/owned/request.json");
  expect(command.arguments).toContain("--max-old-space-size=256");
  expect(command.arguments).toContain("--max-semi-space-size=8");
  const input = inspectWebNetworkCaptureInputSchema.parse({
    capture_path: "/selected/input.har",
    format: "har",
  });
  const projected = projectAnalysisError(
    historicalCaptureFailure(
      input,
      heapExhaustion(),
      "decoder",
      undefined,
      configured(256),
    ),
  );
  const recovery = captureDecoderHeapRecovery(configured(256));
  expect(projected.message).toContain(
    "exhausted its 256 MiB V8 old-generation heap (source setting)",
  );
  expect(projected.remediation.action).toContain(recovery);
  expect(projected.message).not.toContain("no runtime override");
  if (process.versions.bun === undefined)
    expect(projected.details).toMatchObject({
      reported_limits: {
        old_generation_heap_mib: 256,
        old_generation_heap_source: "setting",
      },
    });
});

it.each([
  "",
  "0",
  "7",
  "-1",
  "0192",
  "192.5",
  " 192",
  "192 ",
  "1e3",
  String(MAXIMUM_CAPTURE_DECODER_OLD_GENERATION_MIB + 1),
  "9".repeat(40),
])("rejects invalid %j as a configuration error", (value) => {
  const parsed = parseCaptureDecoderHeap(value);
  if (parsed.ok) throw new Error(`Accepted ${JSON.stringify(value)}`);
  expect(parsed.error).toBeInstanceOf(ConfigurationError);
  expect(parsed.error.settings).toEqual([
    {
      setting: CAPTURE_DECODER_OLD_GENERATION_SETTING,
      constraint: captureDecoderHeapConstraint,
    },
  ]);
  expect(parsed.error.message).toBe(captureDecoderHeapConstraint);
  const startup = parseEnvironment({
    REA_CAPTURE_DECODER_OLD_GENERATION_MIB: value,
  });
  if (startup.ok) throw new Error(`Startup accepted ${JSON.stringify(value)}`);
  expect(startup.error.settings).toContainEqual({
    setting: "REA_CAPTURE_DECODER_OLD_GENERATION_MIB",
    constraint: expect.stringContaining("from 8 to 16384 MiB"),
  });
  const config = parseConfig({
    REA_CAPTURE_DECODER_OLD_GENERATION_MIB: value,
  });
  if (config.ok)
    throw new Error(`parseConfig accepted ${JSON.stringify(value)}`);
  expect(projectAnalysisError(config.error)).toMatchObject({
    code: "configuration_invalid",
    message: expect.stringContaining("REA_CAPTURE_DECODER_OLD_GENERATION_MIB"),
  });
  expect(
    () =>
      new NodeCaptureAdapter("har", {
        REA_CAPTURE_DECODER_OLD_GENERATION_MIB: value,
      }),
  ).toThrow(ConfigurationError);
  expect(
    () =>
      new HistoricalCaptureDecoder([], {
        REA_CAPTURE_DECODER_OLD_GENERATION_MIB: value,
      }),
  ).toThrow(ConfigurationError);
  expect(() =>
    createWebNetworkCaptureService({
      REA_CAPTURE_DECODER_OLD_GENERATION_MIB: value,
    }),
  ).toThrow(ConfigurationError);
});
