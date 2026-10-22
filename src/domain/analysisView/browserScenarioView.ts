import { z } from "zod";

import type { AnalysisError } from "../analysisErrorBase.js";
import { sanitizedBrowserUrlSchema } from "../browserObservation.js";
import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "../browserScenarioCapture.js";
import {
  browserScenarioCompletenessSchema,
  browserScenarioEventKindSchema,
  browserScenarioEventSchema,
  browserStepArtifactsSchema,
  type BrowserScenarioStep,
} from "../browserScenarioCaptureValues.js";
import { compareAsciiStrings } from "../canonicalOrdering.js";
import { err, ok, type Result } from "../result.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { parseAnalysisViewResult } from "./analysisViewParent.js";
import type {
  AnalysisViewCoverage,
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";

const OPERATION = "capture_browser_scenario" as const;
const ARTIFACT_SECTIONS = browserStepArtifactsSchema.keyof().options;
const artifactSectionSchema = browserStepArtifactsSchema.keyof();
type ArtifactSection = z.infer<typeof artifactSectionSchema>;
type Step = BrowserScenarioStep;

const countSchema = z.number().int().nonnegative();
const statusClassSchema = z.enum([
  "1xx",
  "2xx",
  "3xx",
  "4xx",
  "5xx",
  "failed",
  "unknown",
]);
type StatusClass = z.infer<typeof statusClassSchema>;

/** Section names by recorded state; not_requested sections are omitted. */
const stepSectionsSchema = z.strictObject({
  captured: z.array(artifactSectionSchema),
  missing: z.array(artifactSectionSchema),
  truncated: z.array(artifactSectionSchema),
});

const summaryStepSchema = z.strictObject({
  step_index: countSchema,
  step_id: z.string().min(1),
  action: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled"]),
  error: z.string().nullable(),
  elapsed_ms: countSchema,
  before_url: sanitizedBrowserUrlSchema
    .exactOptional()
    .describe(
      "Present only when it differs from the previous step's after_url (always for step 0).",
    ),
  after_url: sanitizedBrowserUrlSchema,
  events: z.strictObject({
    sequence_start: z.number().int().min(1),
    sequence_end: countSchema,
  }),
  sections: stepSectionsSchema,
  completeness: z.enum(["complete", "incomplete", "truncated"]),
});

const focusAccessibilitySchema = z.strictObject({
  focus_step_index: countSchema,
  focus: z.enum(["first-unsuccessful-step", "last-step"]),
  /** The step whose tree is returned: the focus step, or the nearest earlier step that captured one. */
  step_index: countSchema.nullable(),
  accessibility: browserStepArtifactsSchema.shape.accessibility,
});

/** Compact capture overview; complete records stay in the retained parent. */
export const browserScenarioSummarySchema = z.strictObject({
  browser: browserScenarioCaptureSchema.shape.browser,
  scenario: browserScenarioCaptureSchema.shape.scenario,
  duration_ms: countSchema,
  completeness: browserScenarioCompletenessSchema,
  steps: z.array(summaryStepSchema),
  final_accessibility: focusAccessibilitySchema,
  events: z.strictObject({
    retained: countSchema,
    dropped: countSchema,
    by_kind: z.array(
      z.strictObject({
        kind: browserScenarioEventKindSchema,
        count: countSchema,
      }),
    ),
    omissions: z.strictObject({
      by_kind:
        browserScenarioCaptureSchema.shape.events.shape.omissions.shape.by_kind,
      network_transactions: countSchema,
      network_transaction_range:
        browserScenarioCaptureSchema.shape.events.shape.omissions.shape
          .network_transaction_range,
    }),
  }),
  network: z.strictObject({
    transactions: countSchema,
    by_origin: z.array(
      z.strictObject({
        origin: z.string().nullable(),
        transactions: countSchema,
      }),
    ),
    by_resource_type: z.array(
      z.strictObject({
        resource_type: z.string().min(1),
        transactions: countSchema,
      }),
    ),
    by_status_class: z
      .array(
        z.strictObject({
          status_class: statusClassSchema,
          transactions: countSchema,
        }),
      )
      .describe(
        "Final retained outcome per transaction: the first response status class, failed, or unknown when neither was retained.",
      ),
  }),
  limitation_count: countSchema,
});

const indicesSchema = z.array(countSchema);

/** Pages of exact retained steps or events, in original order. */
export const browserScenarioViewRequestSchema = z.strictObject({
  kind: z.literal("browser-scenario"),
  collection: z.enum(["steps", "events"]),
  step_indices: indicesSchema
    .optional()
    .describe("Exact step indices; omitted selects all, [] selects none."),
  artifacts: z
    .array(artifactSectionSchema)
    .default([])
    .describe(
      "Steps only: captured sections returned in full. Other recorded sections are listed in omitted_artifacts with their state.",
    ),
  event_kinds: z
    .array(browserScenarioEventKindSchema)
    .optional()
    .describe(
      "Events only: exact kinds; omitted selects all, [] selects none.",
    ),
  transaction_ids: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Events only: exact network transaction IDs; omitted selects all, [] selects none. Events without a transaction never match a transaction selection.",
    ),
  offset: countSchema.default(0),
  limit: z.number().int().positive().default(64),
});
export type BrowserScenarioViewRequest = z.output<
  typeof browserScenarioViewRequestSchema
>;

/** One exact step whose unselected captured sections are named rather than returned. */
const stepRowSchema = z.strictObject({
  step_index: countSchema,
  step_id: z.string().min(1),
  action: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled"]),
  error: z.string().nullable(),
  elapsed_ms: countSchema,
  before_url: sanitizedBrowserUrlSchema,
  after_url: sanitizedBrowserUrlSchema,
  event_sequence_start: z.number().int().min(1),
  event_sequence_end: countSchema,
  completeness: browserScenarioCompletenessSchema,
  artifacts: browserStepArtifactsSchema.partial(),
  omitted_artifacts: z.array(
    z.strictObject({
      section: artifactSectionSchema,
      state: z.enum(["captured", "missing", "truncated"]),
    }),
  ),
});
const eventRowSchema = z.strictObject({
  item_index: countSchema,
  event: browserScenarioEventSchema,
});

export const browserScenarioViewItemsSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      collection: z.literal("steps"),
      rows: z.array(stepRowSchema),
    }),
    z.strictObject({
      collection: z.literal("events"),
      rows: z.array(eventRowSchema),
    }),
  ],
);

/** Capture-wide facts every page repeats so exhaustion is not read as completeness. */
export const browserScenarioViewContextSchema = z.strictObject({
  source_completeness: browserScenarioCompletenessSchema,
  source_events: z.strictObject({
    retained: countSchema,
    dropped: countSchema,
  }),
});

const unsupportedView = (): AnalysisError =>
  analysisViewInputError([
    {
      path: ["view"],
      reason: "invalid_value",
      message:
        'Parent Evidence operation "capture_browser_scenario" supports the summary, browser-scenario, environment-manifest and environment-state views.',
    },
  ]);

const sameUrl = (
  left: Step["after_url"] | undefined,
  right: Step["before_url"],
): boolean =>
  left !== undefined &&
  left.url === right.url &&
  left.redacted === right.redacted;

const stepSections = (step: Step): z.infer<typeof stepSectionsSchema> => {
  const sections: z.infer<typeof stepSectionsSchema> = {
    captured: [],
    missing: [],
    truncated: [],
  };
  for (const section of ARTIFACT_SECTIONS) {
    const { state } = step.artifacts[section];
    if (state !== "not_requested") sections[state].push(section);
  }
  return sections;
};

const summaryStep = (
  step: Step,
  previous: Step | undefined,
): z.infer<typeof summaryStepSchema> => ({
  step_index: step.step_index,
  step_id: step.step_id,
  action: step.action,
  status: step.status,
  error: step.error,
  elapsed_ms: step.elapsed_ms,
  ...(sameUrl(previous?.after_url, step.before_url)
    ? {}
    : { before_url: step.before_url }),
  after_url: step.after_url,
  events: {
    sequence_start: step.event_sequence_start,
    sequence_end: step.event_sequence_end,
  },
  sections: stepSections(step),
  completeness: step.completeness.status,
});

/** The first unsuccessful step explains a failure; otherwise the final screen does. */
const focusAccessibility = (
  steps: readonly Step[],
): z.infer<typeof focusAccessibilitySchema> => {
  const unsuccessful = steps.findIndex(({ status }) => status !== "completed");
  const focusIndex = unsuccessful === -1 ? steps.length - 1 : unsuccessful;
  const focus = steps[focusIndex];
  if (focus === undefined) throw new Error("Capture has no steps");
  const kind =
    unsuccessful === -1 ? ("last-step" as const) : "first-unsuccessful-step";
  for (let index = focusIndex; index >= 0; index -= 1) {
    const accessibility = steps[index]?.artifacts.accessibility;
    if (accessibility?.state === "captured")
      return {
        focus_step_index: focusIndex,
        focus: kind,
        step_index: index,
        accessibility,
      };
  }
  return {
    focus_step_index: focusIndex,
    focus: kind,
    step_index: null,
    accessibility: focus.artifacts.accessibility,
  };
};

/** Counts in canonical key order; a null origin sorts first. */
const sortedCounts = <Key extends string | null>(
  counts: ReadonlyMap<Key, number>,
): [Key, number][] =>
  [...counts].sort(([left], [right]) =>
    left === null ? -1 : right === null ? 1 : compareAsciiStrings(left, right),
  );

const increment = <Key>(counts: Map<Key, number>, key: Key): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

/** Count retained network transactions once each, from their first retained request event. */
const networkCounts = (
  capture: BrowserScenarioCapture,
): z.infer<typeof browserScenarioSummarySchema>["network"] => {
  const origins = new Map<string | null, number>();
  const resourceTypes = new Map<string, number>();
  const outcomes = new Map<string, StatusClass>();
  for (const event of capture.events.items) {
    if (event.kind === "request") {
      if (outcomes.has(event.transaction_id)) continue;
      outcomes.set(event.transaction_id, "unknown");
      increment(origins, event.url.origin);
      increment(resourceTypes, event.resource_type);
    } else if (event.kind === "response") {
      if (outcomes.get(event.transaction_id) === "unknown")
        outcomes.set(
          event.transaction_id,
          `${String(Math.floor(event.status / 100))}xx` as StatusClass,
        );
    } else if (event.kind === "request-failed") {
      if (outcomes.get(event.transaction_id) === "unknown")
        outcomes.set(event.transaction_id, "failed");
    }
  }
  const statusClasses = new Map<StatusClass, number>();
  for (const outcome of outcomes.values()) increment(statusClasses, outcome);
  return {
    transactions: outcomes.size,
    by_origin: sortedCounts(origins).map(([origin, transactions]) => ({
      origin,
      transactions,
    })),
    by_resource_type: sortedCounts(resourceTypes).map(
      ([resource_type, transactions]) => ({ resource_type, transactions }),
    ),
    by_status_class: sortedCounts(statusClasses).map(
      ([status_class, transactions]) => ({ status_class, transactions }),
    ),
  };
};

const eventCounts = (
  capture: BrowserScenarioCapture,
): z.infer<typeof browserScenarioSummarySchema>["events"] => {
  const kinds = new Map<
    BrowserScenarioCapture["events"]["items"][number]["kind"],
    number
  >();
  for (const event of capture.events.items) increment(kinds, event.kind);
  const { omissions } = capture.events;
  return {
    retained: capture.events.retained,
    dropped: capture.events.dropped,
    by_kind: sortedCounts(kinds).map(([kind, count]) => ({ kind, count })),
    omissions: {
      by_kind: omissions.by_kind,
      network_transactions: omissions.network_transactions.length,
      network_transaction_range: omissions.network_transaction_range,
    },
  };
};

const selected = <Value>(
  filter: readonly Value[] | undefined,
): ((value: Value) => boolean) => {
  if (filter === undefined) return () => true;
  const values = new Set(filter);
  return (value) => values.has(value);
};

const stepRow = (
  { artifacts: recorded, ...step }: Step,
  selection: ReadonlySet<ArtifactSection>,
): z.infer<typeof stepRowSchema> => {
  const artifacts: z.infer<typeof stepRowSchema>["artifacts"] = {};
  const omitted: z.infer<typeof stepRowSchema>["omitted_artifacts"] = [];
  for (const section of ARTIFACT_SECTIONS) {
    const artifact = recorded[section];
    if (selection.has(section))
      Object.assign(artifacts, { [section]: artifact });
    else if (artifact.state !== "not_requested")
      omitted.push({ section, state: artifact.state });
  }
  return { ...step, artifacts, omitted_artifacts: omitted };
};

/** One stable page of matching steps or events, in original order. */
const pageRecords = (
  capture: BrowserScenarioCapture,
  view: BrowserScenarioViewRequest,
): {
  readonly items: z.infer<typeof browserScenarioViewItemsSchema>;
  readonly coverage: AnalysisViewCoverage;
} => {
  const stepSelected = selected(view.step_indices);
  const page = <Row>(rows: readonly Row[]) => {
    const returned = rows.slice(view.offset, view.offset + view.limit);
    return {
      rows: returned,
      coverage: pageViewCoverage(view.offset, returned.length, rows.length),
    };
  };
  if (view.collection === "steps") {
    const artifacts = new Set(view.artifacts);
    const { rows, coverage } = page(
      capture.steps.filter(({ step_index }) => stepSelected(step_index)),
    );
    return {
      items: {
        collection: "steps",
        rows: rows.map((step) => stepRow(step, artifacts)),
      },
      coverage,
    };
  }
  const kindSelected = selected(view.event_kinds);
  const transactionSelected = selected(view.transaction_ids);
  const { rows, coverage } = page(
    capture.events.items.flatMap((event, item_index) =>
      stepSelected(event.step_index) &&
      kindSelected(event.kind) &&
      (view.transaction_ids === undefined ||
        ("transaction_id" in event &&
          transactionSelected(event.transaction_id)))
        ? [{ item_index, event }]
        : [],
    ),
  );
  return { items: { collection: "events", rows }, coverage };
};

/** Project retained scenario Evidence without relaunching the browser or replaying actions. */
export const projectBrowserScenarioView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "browser-scenario")
    return err(unsupportedView());
  const parsed = parseAnalysisViewResult(browserScenarioCaptureSchema, parent);
  if (!parsed.ok) return parsed;
  const capture = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: "", sha256: null },
    limitations: [...parent.limitations],
    unknowns: [
      "Step states record one controlled replay; they do not establish the application's current state.",
      ...(capture.events.dropped > 0
        ? [
            `${String(capture.events.dropped)} events were dropped by capture budgets; counts and pages cover retained events only.`,
          ]
        : []),
    ],
  };
  if (view.kind === "summary")
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: {
        browser: capture.browser,
        scenario: capture.scenario,
        duration_ms: capture.duration_ms,
        completeness: capture.completeness,
        steps: capture.steps.map((step, index) =>
          summaryStep(step, capture.steps[index - 1]),
        ),
        final_accessibility: focusAccessibility(capture.steps),
        events: eventCounts(capture),
        network: networkCounts(capture),
        limitation_count: capture.limitations.length,
      },
      coverage: completeWithinViewCoverage(1, 1),
    });
  return ok({
    kind: "browser-scenario",
    view,
    ...shared,
    source_completeness: capture.completeness,
    source_events: {
      retained: capture.events.retained,
      dropped: capture.events.dropped,
    },
    ...pageRecords(capture, view),
  });
};
