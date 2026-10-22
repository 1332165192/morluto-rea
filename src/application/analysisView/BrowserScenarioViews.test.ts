import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SCENARIO_ORIGIN,
  scenarioCaptureEvidence,
  scenarioCaptureFixture,
} from "../../../tests/fixtures/browserScenarioCapture.js";
import { inspectAnalysisView } from "./AnalysisViewService.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { sanitizeBrowserUrl } from "../../domain/browserObservation.js";
import type { BrowserScenarioCapture } from "../../domain/browserScenarioCapture.js";
import type { AnalysisViewRequest } from "../../domain/analysisView/analysisView.js";

const tree = (text: string) => ({
  state: "captured" as const,
  value: {
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
    text,
  },
});

/** Three steps: navigate to /quiz, capture its tree, then fail on a missing control. */
const quizCapture = (
  thirdStep: "failed" | "completed" = "failed",
): BrowserScenarioCapture => {
  const base = scenarioCaptureFixture();
  const [initial, browse] = base.steps;
  if (initial === undefined || browse === undefined)
    throw new Error("Fixture lacks steps");
  const quiz = sanitizeBrowserUrl(`${SCENARIO_ORIGIN}/quiz`);
  return {
    ...base,
    scenario: { ...base.scenario, action_count: 2 },
    steps: [
      {
        ...initial,
        artifacts: {
          ...initial.artifacts,
          url: { state: "captured", value: initial.after_url },
        },
      },
      {
        ...browse,
        after_url: quiz,
        artifacts: {
          ...browse.artifacts,
          accessibility: tree('- heading "Question 1"'),
          screenshot: { state: "missing", reason: "page closed" },
        },
      },
      {
        ...browse,
        step_index: 2,
        step_id: "answer",
        action: "click",
        before_url: quiz,
        after_url: quiz,
        ...(thirdStep === "failed"
          ? { status: "failed" as const, error: "locator not found" }
          : { status: "completed" as const, error: null }),
      },
    ],
  };
};

const view = (
  capture: BrowserScenarioCapture,
  request: AnalysisViewRequest,
) => {
  const projected = inspectAnalysisView({
    source: { kind: "inline", evidence: scenarioCaptureEvidence(capture) },
    view: request,
  });
  if (!projected.ok) throw projected.error;
  return projected.value.normalized_result as Record<string, unknown>;
};

describe("browser scenario analysis views", () => {
  it("summarizes steps compactly and focuses the first failing step's nearest captured tree", () => {
    const summary = view(quizCapture(), { kind: "summary" });
    expect(summary).toMatchObject({
      kind: "summary",
      parent_operation: "capture_browser_scenario",
      artifact: { path: "", sha256: null },
      coverage: { status: "complete-within-view", exhausted: true },
    });
    const { steps, final_accessibility, network, events } =
      summary.summary as Record<string, unknown> & {
        steps: Record<string, unknown>[];
      };
    // before_url repeats only across a discontinuity; not_requested sections are omitted.
    expect(steps[0]).toHaveProperty("before_url");
    expect(steps[1]).not.toHaveProperty("before_url");
    expect(steps[2]).not.toHaveProperty("before_url");
    expect(steps[0]?.sections).toEqual({
      captured: ["url"],
      missing: [],
      truncated: [],
    });
    expect(steps[1]?.sections).toEqual({
      captured: ["accessibility"],
      missing: ["screenshot"],
      truncated: [],
    });
    expect(steps[2]).toMatchObject({
      status: "failed",
      error: "locator not found",
      after_url: { url: `${SCENARIO_ORIGIN}/quiz` },
    });
    expect(final_accessibility).toEqual({
      focus_step_index: 2,
      focus: "first-unsuccessful-step",
      step_index: 1,
      accessibility: tree('- heading "Question 1"'),
    });
    expect(network).toEqual({
      transactions: 8,
      by_origin: [{ origin: SCENARIO_ORIGIN, transactions: 8 }],
      by_resource_type: [
        { resource_type: "document", transactions: 1 },
        { resource_type: "fetch", transactions: 7 },
      ],
      by_status_class: [
        { status_class: "2xx", transactions: 7 },
        { status_class: "failed", transactions: 1 },
      ],
    });
    expect(events).toMatchObject({ retained: 24, dropped: 0 });
  });

  it("reports the last step's own state when no step captured a tree", () => {
    const capture = scenarioCaptureFixture();
    expect(view(capture, { kind: "summary" })).toMatchObject({
      summary: {
        final_accessibility: {
          focus_step_index: 1,
          focus: "last-step",
          step_index: null,
          accessibility: { state: "not_requested" },
        },
      },
    });
  });
});

describe("browser scenario analysis view pages", () => {
  it("pages exact steps with only the selected captured sections", () => {
    const page = view(quizCapture("completed"), {
      kind: "browser-scenario",
      collection: "steps",
      step_indices: [1, 2],
      artifacts: ["accessibility"],
      offset: 0,
      limit: 1,
    });
    expect(page).toMatchObject({
      kind: "browser-scenario",
      source_completeness: { status: "complete" },
      source_events: { retained: 24, dropped: 0 },
      coverage: { status: "page", examined: 1, total: 2, next_offset: 1 },
      items: {
        collection: "steps",
        rows: [
          {
            step_index: 1,
            artifacts: { accessibility: tree('- heading "Question 1"') },
            omitted_artifacts: [{ section: "screenshot", state: "missing" }],
          },
        ],
      },
    });
  });

  it("filters events by step, kind and transaction, keeping original item indices", () => {
    const capture = scenarioCaptureFixture();
    const responses = view(capture, {
      kind: "browser-scenario",
      collection: "events",
      event_kinds: ["response", "request-failed"],
      transaction_ids: ["request-2", "request-8"],
      artifacts: [],
      offset: 0,
      limit: 64,
    }) as { items: { rows: { item_index: number; event: unknown }[] } };
    expect(
      responses.items.rows.map(({ item_index, event }) => ({
        item_index,
        event,
      })),
    ).toEqual(
      capture.events.items.flatMap((event, item_index) =>
        (event.kind === "response" || event.kind === "request-failed") &&
        ["request-2", "request-8"].includes(event.transaction_id)
          ? [{ item_index, event }]
          : [],
      ),
    );
    expect(responses.items.rows).toHaveLength(2);
    for (const empty of [
      { step_indices: [] },
      { event_kinds: [] },
      { transaction_ids: [] },
      { step_indices: [0] },
    ])
      expect(
        view(capture, {
          kind: "browser-scenario",
          collection: "events",
          artifacts: [],
          offset: 0,
          limit: 64,
          ...empty,
        }),
      ).toMatchObject({
        items: { rows: [] },
        coverage: { status: "empty", total: 0, exhausted: true },
      });
  });

  it("states dropped events and refuses views of other parents", () => {
    const base = scenarioCaptureFixture();
    const dropped = {
      ...base,
      events: {
        ...base.events,
        dropped: 3,
        omissions: {
          ...base.events.omissions,
          by_kind: [
            {
              kind: "console" as const,
              count: 3,
              reasons: ["max-events" as const],
            },
          ],
        },
      },
      completeness: {
        status: "truncated" as const,
        equality_eligible: false as const,
        missing_sections: [],
        truncated_sections: ["events" as const],
      },
    };
    const summary = view(dropped, { kind: "summary" });
    expect(summary.unknowns).toContain(
      "3 events were dropped by capture budgets; counts and pages cover retained events only.",
    );
    expect(summary).toMatchObject({
      summary: {
        events: {
          dropped: 3,
          omissions: {
            by_kind: [{ kind: "console", count: 3 }],
            network_transactions: 0,
          },
        },
      },
    });
    const refused = inspectAnalysisView({
      source: { kind: "inline", evidence: scenarioCaptureEvidence() },
      view: { kind: "go", collection: "dependencies" },
    });
    if (refused.ok) throw new Error("Expected an unsupported view refusal");
    expect(projectAnalysisError(refused.error)).toMatchObject({
      code: "invalid_request",
    });
  });
});
