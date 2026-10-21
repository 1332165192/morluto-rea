import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  BOOK_INIT_ROWS,
  BOOK_NOT_FOUND,
  FIRST_BOOK,
  SECOND_BOOK,
  THIRD_BOOK,
  book,
  bookClock,
  environmentStateViewOf,
  renamedBook,
  type Book,
} from "../../../tests/fixtures/environmentStateWrites.js";
import type { JsonValue } from "../jsonValue.js";
import { ok } from "../result.js";
import { updatedFields } from "./environmentStateWriteApply.js";
import {
  retainFixed,
  type EffectContext,
} from "./environmentStateWriteEffects.js";

/** The plan the gate gives `tool` over a capture of `rows`. */
const gated = (rows: readonly TimedCaptureRow[], tool: string) => {
  const { writes } = environmentStateViewOf(timedCaptureEvidence(rows));
  const plan = writes.find((candidate) => candidate.tool === tool);
  if (plan === undefined) throw new Error(`The gate planned no ${tool}`);
  return plan;
};

const RENAMED = renamedBook(FIRST_BOOK, "Renamed Book", 3);

describe("reads compared as the served environment answers them", () => {
  /** Item reads in a `{data, revision}` envelope, a rename, then a read recorded at `revision`. */
  const renamedInEnvelope = (revision: string): TimedCaptureRow[] => [
    ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
    ["GET", "/api/books/1", { data: FIRST_BOOK, revision: "r1" }],
    ["GET", "/api/books/2", { data: SECOND_BOOK, revision: "r1" }],
    ["PATCH", "/api/books/1", RENAMED, 200, { name: "Renamed Book" }],
    ["GET", "/api/books/1", { data: RENAMED, revision }],
  ];

  it("contradicts a write when an item read's envelope differs from the one served", () => {
    expect(gated(renamedInEnvelope("r2"), "patch_books_by_id")).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
    expect(gated(renamedInEnvelope("r1"), "patch_books_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [4],
    });
  });

  /** A list in a `{items, revision}` envelope, a create, then the list recorded at `revision`. */
  const createdInEnvelope = (revision: string): TimedCaptureRow[] => [
    ["GET", "/api/books", { items: [FIRST_BOOK, SECOND_BOOK], revision: "r1" }],
    ["GET", "/api/books/1", FIRST_BOOK],
    ["GET", "/api/books/2", SECOND_BOOK],
    ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
    [
      "GET",
      "/api/books",
      { items: [FIRST_BOOK, SECOND_BOOK, THIRD_BOOK], revision },
    ],
  ];

  it("contradicts a write when a list's envelope differs from its served line", () => {
    expect(gated(createdInEnvelope("r2"), "post_books")).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
    expect(gated(createdInEnvelope("r1"), "post_books")).toMatchObject({
      served: true,
      checked_record_ordinals: [4],
    });
  });

  /** A filtered list of both books, a delete of the second, then the filtered list recorded with `listed`. */
  const deletedFromFiltered = (listed: readonly Book[]): TimedCaptureRow[] => [
    ["GET", "/api/books/1", FIRST_BOOK],
    ["GET", "/api/books/2", SECOND_BOOK],
    ["GET", "/api/books?shelf=a", [FIRST_BOOK, SECOND_BOOK]],
    ["DELETE", "/api/books/2", "", 204],
    ["GET", "/api/books?shelf=a", [...listed]],
  ];

  it("contradicts a delete that a filtered list still shows, and confirms one it drops", () => {
    expect(
      gated(
        deletedFromFiltered([FIRST_BOOK, SECOND_BOOK]),
        "delete_books_by_id",
      ),
    ).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
    expect(
      gated(deletedFromFiltered([FIRST_BOOK]), "delete_books_by_id"),
    ).toMatchObject({ served: true, checked_record_ordinals: [4] });
  });

  /** A delete confirmed by an item read, then the filtered list recorded with its query reordered. */
  const deletedThenReordered = (listed: readonly Book[]): TimedCaptureRow[] => [
    ["GET", "/api/books/1", FIRST_BOOK],
    ["GET", "/api/books/2", SECOND_BOOK],
    ["GET", "/api/books?shelf=a&sort=id", [FIRST_BOOK, SECOND_BOOK]],
    ["DELETE", "/api/books/2", "", 204],
    ["GET", "/api/books/2", BOOK_NOT_FOUND, 404],
    ["GET", "/api/books?sort=id&shelf=a", [...listed]],
  ];

  it("checks a list read on a checked line however its query is ordered, as serving matches it", () => {
    // The item read already checked the delete, so a list still showing the book marks it a side effect.
    expect(
      gated(
        deletedThenReordered([FIRST_BOOK, SECOND_BOOK]),
        "delete_books_by_id",
      ),
    ).toMatchObject({ served: false, reason: "side-effect" });
    expect(
      gated(deletedThenReordered([FIRST_BOOK]), "delete_books_by_id"),
    ).toMatchObject({ served: true, checked_record_ordinals: [4] });
  });
});

describe("update constants", () => {
  const paper = (entry: Book, format = "PAPER"): Book => ({ ...entry, format });
  const RENAMED_PAPER = paper(RENAMED);
  const HARDCOVER = paper(
    { ...SECOND_BOOK, updated_at: bookClock(5) },
    "HARDCOVER",
  );
  /** A rename that keeps the format, then a format change the application stores in capitals. */
  const ROWS: TimedCaptureRow[] = [
    ["GET", "/api/books", [paper(FIRST_BOOK), paper(SECOND_BOOK)]],
    ["GET", "/api/books/1", paper(FIRST_BOOK)],
    ["GET", "/api/books/2", paper(SECOND_BOOK)],
    ["PATCH", "/api/books/1", RENAMED_PAPER, 200, { name: "Renamed Book" }],
    ["GET", "/api/books/1", RENAMED_PAPER],
    ["PATCH", "/api/books/2", HARDCOVER, 200, { format: "hardcover" }],
    ["GET", "/api/books/2", HARDCOVER],
  ];

  it("stores the value the call that showed a constant recorded, as serving applies the plan", () => {
    const plan = gated(ROWS, "patch_books_by_id");
    expect(plan).toMatchObject({
      served: true,
      observation: { ordinal: 3, pointer: "" },
      body: { fixed: [{ member: "format", sent: "hardcover" }] },
      checked_record_ordinals: [4, 6],
    });
    // Serving reads the plan's observation, the first update's answer, which still shows PAPER.
    const served = updatedFields(
      plan,
      { before: paper(SECOND_BOOK), observed: RENAMED_PAPER },
      {
        path: "/api/books/2",
        pathValues: new Map([["id", "2"]]),
        body: { format: "hardcover" },
        id: "2",
      },
      () => ok(bookClock(9)),
    );
    expect(served).toEqual(
      ok(paper({ ...SECOND_BOOK, updated_at: bookClock(9) }, "HARDCOVER")),
    );
  });
});

describe("write examples", () => {
  it("takes no modelled effect or exemplar from a redirected write", () => {
    const rows: TimedCaptureRow[] = [
      ...BOOK_INIT_ROWS,
      ["DELETE", "/api/books/2", "", 302],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["DELETE", "/api/books/2", "", 204],
      ["GET", "/api/books/2", BOOK_NOT_FOUND, 404],
    ];
    expect(gated(rows, "delete_books_by_id")).toMatchObject({
      served: true,
      exemplar_ordinal: 5,
      checked_record_ordinals: [6],
      contradicted_by: null,
    });
  });
});

describe("update rules learned from a later call", () => {
  const versioned = (entry: Book, version: number): Book => ({
    ...entry,
    version,
  });
  /** Two renames, of the first and the second book, each answered at the version given. */
  const renames = (first: number, second: number): TimedCaptureRow[] => {
    const firstAfter = versioned(
      renamedBook(FIRST_BOOK, "Renamed Book", 3),
      first,
    );
    const secondAfter = versioned(
      renamedBook(SECOND_BOOK, "Second Edition", 5),
      second,
    );
    return [
      [
        "GET",
        "/api/books",
        [versioned(FIRST_BOOK, 1), versioned(SECOND_BOOK, 1)],
      ],
      ["GET", "/api/books/1", versioned(FIRST_BOOK, 1)],
      ["GET", "/api/books/2", versioned(SECOND_BOOK, 1)],
      ["PATCH", "/api/books/1", firstAfter, 200, { name: "Renamed Book" }],
      ["GET", "/api/books/1", firstAfter],
      ["PATCH", "/api/books/2", secondAfter, 200, { name: "Second Edition" }],
      ["GET", "/api/books/2", secondAfter],
    ];
  };

  it("leaves an update unserved when one call increments a field another left as it was", () => {
    for (const [first, second] of [
      [1, 2],
      [2, 1],
    ] as const)
      expect(gated(renames(first, second), "patch_books_by_id")).toMatchObject({
        served: false,
        reason: "unexplained-change",
      });
    expect(gated(renames(2, 2), "patch_books_by_id")).toMatchObject({
      served: true,
      rules: expect.arrayContaining([{ field: "version", rule: "increment" }]),
      checked_record_ordinals: [4, 6],
    });
  });
});

describe("slug rules learned from a later call", () => {
  /** A patch of the first book sending `name`, answered with `answered`, then a rename of the second. */
  const renames = (name: string, answered: Book): TimedCaptureRow[] => {
    const second = renamedBook(SECOND_BOOK, "Second Edition", 5);
    return [
      ...BOOK_INIT_ROWS,
      ["PATCH", "/api/books/1", answered, 200, { name }],
      ["GET", "/api/books/1", answered],
      ["PATCH", "/api/books/2", second, 200, { name: "Second Edition" }],
      ["GET", "/api/books/2", second],
    ];
  };

  it("serves a slug rule an earlier call agrees with, and not one it contradicts", () => {
    const kept = { ...FIRST_BOOK, updated_at: bookClock(3) };
    expect(
      gated(renames("First Book", kept), "patch_books_by_id"),
    ).toMatchObject({
      served: true,
      rules: expect.arrayContaining([
        { field: "slug", rule: "slug", from: "name" },
      ]),
    });
    // The application renamed the first book without following its slug.
    expect(
      gated(
        renames("Renamed Book", { ...kept, name: "Renamed Book" }),
        "patch_books_by_id",
      ),
    ).toMatchObject({ served: false, reason: "unexplained-change" });
  });
});

describe("checked lines", () => {
  /** A list page that echoes its own request path, as some APIs do. */
  const page = (path: string, items: JsonValue[]): JsonValue => ({
    path,
    items,
  });
  const PLAIN = "/api/orgs/acme1/books";
  const ENCODED = "/api/orgs/%61cme1/books";
  const OTHER = "/api/orgs/beta2/books";
  /** Three organisations' books under one templated tool, two spelling one organisation differently, then deletes each confirmed by its list. */
  const ROWS: TimedCaptureRow[] = [
    ["GET", PLAIN, page(PLAIN, [FIRST_BOOK])],
    ["GET", ENCODED, page(ENCODED, [SECOND_BOOK])],
    ["GET", OTHER, page(OTHER, [THIRD_BOOK])],
    ["GET", `${PLAIN}/1`, FIRST_BOOK],
    ["GET", `${ENCODED}/2`, SECOND_BOOK],
    ["GET", `${OTHER}/3`, THIRD_BOOK],
    ["DELETE", `${ENCODED}/2`, "", 204],
    ["GET", ENCODED, page(ENCODED, [])],
    ["DELETE", `${OTHER}/3`, "", 204],
    ["GET", OTHER, page(OTHER, [])],
  ];

  it("keeps a line's path spelling, as replay prefers the verbatim one", () => {
    const view = environmentStateViewOf(timedCaptureEvidence(ROWS), [
      "sibling-variance",
    ]);
    expect(view.views).toContainEqual(
      expect.objectContaining({
        shape: "list",
        checked_record_ordinals: [0, 1, 2],
      }),
    );
    expect(
      view.writes.find((candidate) => candidate.effect === "delete"),
    ).toMatchObject({ served: true, checked_record_ordinals: [7, 9] });
  });
  /** Organisations listed only under encoded or other spellings, a delete in each, then a list of the first spelled plainly. */
  const deletedThenPlain = (listed: readonly Book[]): TimedCaptureRow[] => {
    const third = "/api/orgs/gamma3/books";
    const fourth = book(4, "Fourth Book", "2026-10-01T11:00:00Z");
    return [
      ["GET", ENCODED, [SECOND_BOOK]],
      ["GET", OTHER, [THIRD_BOOK]],
      ["GET", third, [fourth]],
      ["GET", `${ENCODED}/2`, SECOND_BOOK],
      ["GET", `${OTHER}/3`, THIRD_BOOK],
      ["DELETE", `${ENCODED}/2`, "", 204],
      ["GET", `${ENCODED}/2`, BOOK_NOT_FOUND, 404],
      ["DELETE", `${OTHER}/3`, "", 204],
      ["GET", `${OTHER}/3`, BOOK_NOT_FOUND, 404],
      ["GET", PLAIN, [...listed]],
    ];
  };

  it("checks a read spelled plainly against the encoded line serving answers it from", () => {
    const deleteOf = (listed: readonly Book[]) =>
      environmentStateViewOf(timedCaptureEvidence(deletedThenPlain(listed)), [
        "sibling-variance",
      ]).writes.find((candidate) => candidate.effect === "delete");
    // Serving lists the encoded collection for the plain argument, which no longer holds the book.
    expect(deleteOf([SECOND_BOOK])).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 9,
    });
    expect(deleteOf([])).toMatchObject({
      served: true,
      checked_record_ordinals: [6, 8, 9],
    });
  });
});

describe("insert rules", () => {
  it("still learns where a list places a create after an item read confirmed it", () => {
    const alpha = book(3, "Alpha", bookClock(3));
    const rows: TimedCaptureRow[] = [
      ...BOOK_INIT_ROWS,
      ["POST", "/api/books", alpha, 201, { name: "Alpha" }],
      ["GET", "/api/books/3", alpha],
      ["GET", "/api/books", [alpha, FIRST_BOOK, SECOND_BOOK]],
    ];
    expect(gated(rows, "post_books")).toMatchObject({
      served: true,
      insert: { rule: "sorted", field: "name", direction: "ascending" },
      checked_record_ordinals: [4, 5],
    });
  });
});

describe("reads the served answer no longer matches", () => {
  it("contradicts an update when a later read's body no longer holds the entity", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", { data: FIRST_BOOK }],
      ["GET", "/api/books/2", { data: SECOND_BOOK }],
      ["PATCH", "/api/books/1", RENAMED, 200, { name: "Renamed Book" }],
      ["GET", "/api/books/1", { data: null }],
      ["GET", "/api/books/1", { data: RENAMED }],
    ];
    // Serving still answers the renamed book, so the read that shows none is a check it fails, not one it skips.
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: false,
      reason: "contradicted",
      contradicted_by: 4,
    });
  });

  it("confirms no create by the absence of the entity a later delete removed", () => {
    const rows: TimedCaptureRow[] = [
      ...BOOK_INIT_ROWS,
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      ["DELETE", "/api/books/3", "", 204],
      ["GET", "/api/books/3", BOOK_NOT_FOUND, 404],
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
    ];
    expect(gated(rows, "post_books")).toMatchObject({
      served: false,
      reason: "unconfirmed",
      checked_record_ordinals: [],
    });
    expect(gated(rows, "delete_books_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [5, 6],
    });
  });

  it("confirms no create whose entity lacks a field every recording of its item view carried", () => {
    const detailed = (entry: Book): Book => ({ ...entry, detail: "x" });
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", detailed(FIRST_BOOK)],
      ["GET", "/api/books/2", detailed(SECOND_BOOK)],
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      ["GET", "/api/books/3", THIRD_BOOK],
    ];
    expect(gated(rows, "post_books")).toMatchObject({ served: false });
  });
});

describe("updates whose effect later writes erase", () => {
  const versioned = (entry: Book, version: number): Book => ({
    ...entry,
    version,
  });

  it("keeps an update confirmed when a later one rewrites only part of what it changed", () => {
    const again = versioned(renamedBook(FIRST_BOOK, "Again Book", 4), 2);
    const rows: TimedCaptureRow[] = [
      [
        "GET",
        "/api/books",
        [versioned(FIRST_BOOK, 1), versioned(SECOND_BOOK, 1)],
      ],
      ["GET", "/api/books/1", versioned(FIRST_BOOK, 1)],
      ["GET", "/api/books/2", versioned(SECOND_BOOK, 1)],
      [
        "PATCH",
        "/api/books/1",
        versioned(RENAMED, 2),
        200,
        { name: "Renamed Book" },
      ],
      ["PUT", "/api/books/1", again, 200, { name: "Again Book" }],
      ["GET", "/api/books/1", again],
    ];
    // The PUT keeps the version the PATCH incremented, so the read still shows the PATCH's effect.
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [5],
    });
  });

  it("confirms no update whose changes later writes overwrote between them", () => {
    const renamed = versioned(renamedBook(FIRST_BOOK, "Again Book", 4), 2);
    const final = versioned(renamedBook(FIRST_BOOK, "Again Book", 5), 9);
    const rows: TimedCaptureRow[] = [
      [
        "GET",
        "/api/books",
        [versioned(FIRST_BOOK, 1), versioned(SECOND_BOOK, 1)],
      ],
      ["GET", "/api/books/1", versioned(FIRST_BOOK, 1)],
      ["GET", "/api/books/2", versioned(SECOND_BOOK, 1)],
      [
        "PATCH",
        "/api/books/1",
        versioned(RENAMED, 2),
        200,
        { name: "Renamed Book" },
      ],
      ["PUT", "/api/books/1", renamed, 200, { name: "Again Book" }],
      ["POST", "/api/books/1", final, 200, { version: 9 }],
      ["GET", "/api/books/1", final],
    ];
    // The PUT overwrote the name, slug and clock, the POST the version: nothing of the PATCH is left to read.
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: false,
      checked_record_ordinals: [],
    });
    expect(gated(rows, "put_books_by_id")).toMatchObject({
      checked_record_ordinals: [6],
    });
  });

  it("confirms no update whose changes a recorded outcome replaced", () => {
    const described = (
      entry: Book,
      name: string,
      at: number,
      text: string,
    ): Book => ({
      ...renamedBook(entry, name, at),
      description: text,
    });
    const final = described(FIRST_BOOK, "Other Book", 7, "z");
    const rows: TimedCaptureRow[] = [
      [
        "GET",
        "/api/books",
        [
          { ...FIRST_BOOK, description: "d" },
          { ...SECOND_BOOK, description: "d" },
        ],
      ],
      ["GET", "/api/books/1", { ...FIRST_BOOK, description: "d" }],
      ["GET", "/api/books/2", { ...SECOND_BOOK, description: "d" }],
      [
        "PUT",
        "/api/books/2",
        described(SECOND_BOOK, "Second Book", 3, "x"),
        200,
        { description: "x" },
      ],
      [
        "PATCH",
        "/api/books/1",
        described(FIRST_BOOK, "Renamed Book", 4, "d"),
        200,
        { name: "Renamed Book" },
      ],
      // Without a body the PUT is not modelled: its recorded outcome becomes the book's values.
      ["PUT", "/api/books/1", described(FIRST_BOOK, "Other Book", 5, "d")],
      [
        "PATCH",
        "/api/books/1",
        described(FIRST_BOOK, "Other Book", 6, "y"),
        200,
        { description: "y" },
      ],
      ["PUT", "/api/books/1", final, 200, { description: "z" }],
      ["GET", "/api/books/1", final],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: false,
      checked_record_ordinals: [],
    });
  });
});

describe("reads as serving answers them", () => {
  it("checks a read with no query on the line serving answers it from, a whole list's paging line", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books?limit=50", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK, THIRD_BOOK]],
    ];
    expect(gated(rows, "post_books")).toMatchObject({
      served: true,
      checked_record_ordinals: [4],
    });
  });

  it("checks nothing by a line whose query repeats a name, which no call can name", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books?tag=a&tag=b", [FIRST_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["PATCH", "/api/books/1", RENAMED, 200, { name: "Renamed Book" }],
      ["GET", "/api/books?tag=a&tag=b", [RENAMED]],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      checked_record_ordinals: [],
    });
  });

  it("checks nothing by a read made while a write to its targets was still running", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      // The create runs from second 3 to 4.5; the list at second 4 still shows the books before it.
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }, 1500],
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK, THIRD_BOOK]],
    ];
    expect(gated(rows, "post_books")).toMatchObject({
      served: true,
      checked_record_ordinals: [5],
      contradicted_by: null,
    });
  });

  it("refuses an update a later call stores otherwise than the plan echoed", () => {
    const formatted = (at: number, format: string): Book => ({
      ...renamedBook(FIRST_BOOK, "First Book", at),
      format,
    });
    const rows: TimedCaptureRow[] = [
      [
        "GET",
        "/api/books",
        [
          { ...FIRST_BOOK, format: "EBOOK" },
          { ...SECOND_BOOK, format: "EBOOK" },
        ],
      ],
      ["GET", "/api/books/1", { ...FIRST_BOOK, format: "EBOOK" }],
      ["GET", "/api/books/2", { ...SECOND_BOOK, format: "EBOOK" }],
      [
        "PATCH",
        "/api/books/1",
        formatted(3, "PAPER"),
        200,
        { format: "PAPER" },
      ],
      ["GET", "/api/books/1", formatted(3, "PAPER")],
      [
        "PATCH",
        "/api/books/1",
        formatted(5, "HARDCOVER"),
        200,
        { format: "hardcover" },
      ],
      ["GET", "/api/books/1", formatted(5, "HARDCOVER")],
    ];
    // One call echoed the format, the other stored another value: no one plan serves both.
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: false,
      reason: "unexplained-change",
    });
  });
});

describe("what a read shows of a write", () => {
  it("confirms no update by a read that shows none of the fields it changed", () => {
    const rows: TimedCaptureRow[] = [
      [
        "GET",
        "/api/books",
        [
          { id: 1, name: "A" },
          { id: 2, name: "B" },
        ],
      ],
      ["GET", "/api/books/1", { id: 1, name: "A", description: "x" }],
      ["GET", "/api/books/2", { id: 2, name: "B", description: "y" }],
      [
        "PATCH",
        "/api/books/1",
        { id: 1, name: "A", description: "new" },
        200,
        { description: "new" },
      ],
      // The list passes, but it shows no description.
      [
        "GET",
        "/api/books",
        [
          { id: 1, name: "A" },
          { id: 2, name: "B" },
        ],
      ],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: false,
      reason: "unconfirmed",
      checked_record_ordinals: [],
    });
  });

  it("lets a read a create was observed through still contradict another write", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["PATCH", "/api/books/1", RENAMED, 200, { name: "Renamed Book" }],
      ["GET", "/api/books/1", RENAMED],
      // The create answers with its id alone, so the next list shows its entity; that list shows book 1 unrenamed.
      ["POST", "/api/books", { id: 3 }, 201, { name: "Third Book" }],
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK, THIRD_BOOK]],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: false,
      contradicted_by: 6,
    });
  });

  it("confirms no document write a later replacement overwrote", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/settings", { theme: "light", lang: "en" }],
      [
        "PATCH",
        "/api/settings",
        { theme: "dark", lang: "en" },
        200,
        { theme: "dark" },
      ],
      [
        "PUT",
        "/api/settings",
        { theme: "blue", lang: "fr" },
        200,
        { theme: "blue", lang: "fr" },
      ],
      ["GET", "/api/settings", { theme: "blue", lang: "fr" }],
    ];
    expect(gated(rows, "patch_settings")).toMatchObject({
      served: false,
      checked_record_ordinals: [],
    });
    expect(gated(rows, "put_settings")).toMatchObject({
      served: true,
      checked_record_ordinals: [3],
    });
  });
});

describe("reads named as serving names them", () => {
  const orgBook = (id: number, org: string, name: string): Book => ({
    id,
    org,
    name,
  });
  it("contradicts an update by a read spelled plainly of the encoded collection serving answers it from", () => {
    const alpha = orgBook(1, "acme1", "Alpha");
    const renamed = orgBook(1, "acme1", "Renamed");
    const beta = orgBook(2, "beta2", "Beta");
    const renamedBeta = orgBook(2, "beta2", "Renamed Beta");
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/orgs/%61cme1/books", [alpha]],
      ["GET", "/api/orgs/beta2/books", [beta]],
      ["GET", "/api/orgs/%61cme1/books/1", alpha],
      ["GET", "/api/orgs/beta2/books/2", beta],
      ["PATCH", "/api/orgs/%61cme1/books/1", renamed, 200, { name: "Renamed" }],
      [
        "PATCH",
        "/api/orgs/beta2/books/2",
        renamedBeta,
        200,
        { name: "Renamed Beta" },
      ],
      // Serving answers this plain spelling with the renamed book, which the recording shows absent.
      ["GET", "/api/orgs/acme1/books/1", null],
      ["GET", "/api/orgs/%61cme1/books/1", renamed],
      ["GET", "/api/orgs/beta2/books/2", renamedBeta],
    ];
    const { writes } = environmentStateViewOf(timedCaptureEvidence(rows), [
      "sibling-variance",
    ]);
    expect(writes.find((plan) => plan.effect === "update")).toMatchObject({
      served: false,
      contradicted_by: 6,
    });
  });

  it("checks a line whose query repeats a name with one value, which a call still names", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books?tag=a&tag=a", [FIRST_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["PATCH", "/api/books/1", RENAMED, 200, { name: "Renamed Book" }],
      // The list still shows the old name, though the item read after it shows the rename.
      ["GET", "/api/books?tag=a&tag=a", [FIRST_BOOK]],
      ["GET", "/api/books/1", RENAMED],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: false,
      contradicted_by: 4,
    });
  });
});

describe("what a write's own answer pins down", () => {
  it("observes a create that answers with its id alone only through a read of that id", () => {
    const fourth = book(4, "Fourth Book", "2026-10-01T11:00:00Z");
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["POST", "/api/books", { id: 3 }, 201, { name: "Third Book" }],
      // A book the capture never listed is not the one the create made.
      ["GET", "/api/books/4", fourth],
      ["GET", "/api/books/4", fourth],
      ["GET", "/api/books/3", THIRD_BOOK],
      ["GET", "/api/books/3", THIRD_BOOK],
    ];
    expect(gated(rows, "post_books")).toMatchObject({
      observation: { ordinal: 6, pointer: "" },
      checked_record_ordinals: [7],
    });
  });

  it("keeps an update served when a later call is the first to send the path's id in its body", () => {
    const renamedSecond = renamedBook(SECOND_BOOK, "Renamed Second", 5);
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["PATCH", "/api/books/1", RENAMED, 200, { name: "Renamed Book" }],
      ["GET", "/api/books/1", RENAMED],
      [
        "PATCH",
        "/api/books/2",
        renamedSecond,
        200,
        { id: 2, name: "Renamed Second" },
      ],
      ["GET", "/api/books/2", renamedSecond],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: true,
      body: { identity: "id" },
    });
  });
});

it("counts the sent values a plan keeps for fixed members against the view's allowance", () => {
  let retained = 0;
  const context = {
    io: { retain: (bytes: number) => (retained += bytes) },
  } as unknown as EffectContext;
  retainFixed(context, [{ sent: "x".repeat(10_000) }]);
  expect(retained).toBeGreaterThan(20_000);
  retained = 0;
  retainFixed(context, []);
  expect(retained).toBe(0);
});

describe("what a check leaves pending", () => {
  const summary = (books: readonly Book[]): JsonValue =>
    books.map(({ id, name }) => ({ id: id ?? null, name: name ?? null }));
  const described = (id: number, name: string, description: string) => ({
    id,
    name,
    description,
  });

  it("keeps an update a passing read showed nothing of for a later read to confirm", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", summary([FIRST_BOOK, SECOND_BOOK])],
      ["GET", "/api/books/1", described(1, "First Book", "x")],
      ["GET", "/api/books/2", described(2, "Second Book", "y")],
      [
        "PATCH",
        "/api/books/1",
        described(1, "First Book", "new"),
        200,
        { description: "new" },
      ],
      // The list passes but shows no description; the item read does.
      ["GET", "/api/books", summary([FIRST_BOOK, SECOND_BOOK])],
      ["GET", "/api/books/1", described(1, "First Book", "new")],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [5],
    });
  });

  it("neither resynchronises nor checks an entity by a read begun while a write to it still ran", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      // The rename runs from second 3 to 5.5, and an unmodelled action leaves book 1 unknown.
      ["PATCH", "/api/books/1", RENAMED, 200, { name: "Renamed Book" }, 2500],
      ["POST", "/api/books/1/archive", null, 204, {}],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/1", RENAMED],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [6],
      contradicted_by: null,
    });
  });

  it("checks nothing by a range read the collection has outgrown", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books?_start=0&_end=2", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      // The application still answers the range with two books.
      ["GET", "/api/books?_start=0&_end=2", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/3", THIRD_BOOK],
    ];
    expect(gated(rows, "post_books")).toMatchObject({
      served: true,
      checked_record_ordinals: [5],
    });
  });
});

describe("what a later call must follow", () => {
  it("refuses a create whose later call does not follow the sequence it learned", () => {
    const ranked = (at: Book, rank: number) => ({ ...at, rank });
    const third = ranked(book(3, "Third Book", bookClock(3)), 3);
    const fourth = ranked(book(4, "Fourth Book", bookClock(4)), 3);
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [ranked(FIRST_BOOK, 1), ranked(SECOND_BOOK, 2)]],
      ["GET", "/api/books/1", ranked(FIRST_BOOK, 1)],
      ["GET", "/api/books/2", ranked(SECOND_BOOK, 2)],
      ["POST", "/api/books", third, 201, { name: "Third Book" }],
      // Serving ranks the next create 4; the application recorded 3 again.
      ["POST", "/api/books", fourth, 201, { name: "Fourth Book" }],
      [
        "GET",
        "/api/books",
        [ranked(FIRST_BOOK, 1), ranked(SECOND_BOOK, 2), third, fourth],
      ],
    ];
    expect(gated(rows, "post_books")).toMatchObject({
      served: false,
      reason: "unexplained-change",
    });
  });

  it("keeps a document write a later replacement of another member left in place", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/settings", { theme: "light", prefs: { lang: "en" } }],
      [
        "PATCH",
        "/api/settings",
        { theme: "dark", prefs: { lang: "en" } },
        200,
        { theme: "dark" },
      ],
      // The replacement holds `lang`, so it replaces `prefs` alone.
      [
        "PUT",
        "/api/settings",
        { theme: "dark", prefs: { lang: "fr" } },
        200,
        { lang: "fr" },
      ],
      ["GET", "/api/settings", { theme: "dark", prefs: { lang: "fr" } }],
    ];
    expect(gated(rows, "patch_settings")).toMatchObject({
      served: true,
      checked_record_ordinals: [3],
    });
    expect(gated(rows, "put_settings")).toMatchObject({
      served: true,
      checked_record_ordinals: [3],
    });
  });

  it("applies a later document replacement at the plan's pointer, though it shares no member with the document", () => {
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/settings", { theme: "light", lang: "en" }],
      [
        "PUT",
        "/api/settings",
        { theme: "dark", lang: "fr" },
        200,
        { theme: "dark", lang: "fr" },
      ],
      ["PUT", "/api/settings", { theme: "blue" }, 200, { theme: "blue" }],
      ["PUT", "/api/settings", { lang: "de" }, 200, { lang: "de" }],
      ["GET", "/api/settings", { lang: "de" }],
    ];
    expect(gated(rows, "put_settings")).toMatchObject({
      served: true,
      checked_record_ordinals: [4],
    });
  });

  it("finds an update's entity as serving does when the write spells the collection plainly", () => {
    const alpha = { id: 1, org: "acme1", name: "Alpha" };
    const beta = { id: 2, org: "beta2", name: "Beta" };
    const renamed = { ...alpha, name: "Renamed" };
    const renamedBeta = { ...beta, name: "Renamed Beta" };
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/orgs/%61cme1/books", [alpha]],
      ["GET", "/api/orgs/beta2/books", [beta]],
      ["GET", "/api/orgs/%61cme1/books/1", alpha],
      ["GET", "/api/orgs/beta2/books/2", beta],
      ["PATCH", "/api/orgs/acme1/books/1", renamed, 200, { name: "Renamed" }],
      [
        "PATCH",
        "/api/orgs/beta2/books/2",
        renamedBeta,
        200,
        { name: "Renamed Beta" },
      ],
      ["GET", "/api/orgs/%61cme1/books/1", renamed],
      ["GET", "/api/orgs/beta2/books/2", renamedBeta],
    ];
    const { writes } = environmentStateViewOf(timedCaptureEvidence(rows), [
      "sibling-variance",
    ]);
    expect(writes.find((plan) => plan.effect === "update")).toMatchObject({
      served: true,
      checked_record_ordinals: [6, 7],
    });
  });
});

describe("what a write's effect keeps", () => {
  it("keeps an entity member a later write's other member does not cover, though both names look like pointers", () => {
    const flat = (id: number, prefs: string, lang: string) => ({
      id,
      name: `Book ${String(id)}`,
      "/prefs": prefs,
      "/prefs/lang": lang,
    });
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [flat(1, "x", "en"), flat(2, "x", "en")]],
      ["GET", "/api/books/1", flat(1, "x", "en")],
      ["GET", "/api/books/2", flat(2, "x", "en")],
      [
        "PATCH",
        "/api/books/1",
        flat(1, "x", "fr"),
        200,
        { "/prefs/lang": "fr" },
      ],
      ["PUT", "/api/books/1", flat(1, "y", "fr"), 200, { "/prefs": "y" }],
      ["GET", "/api/books/1", flat(1, "y", "fr")],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [5],
    });
  });

  const subtitled = (id: number, name: string, subtitle?: string) =>
    subtitle === undefined ? { id, name } : { id, name, subtitle };
  const summaries = (first: string): TimedCaptureRow => [
    "GET",
    "/api/books",
    [subtitled(1, first), subtitled(2, "B")],
  ];

  it("refuses an update a later read shows dropped a field serving would keep", () => {
    const rows: TimedCaptureRow[] = [
      summaries("A"),
      ["GET", "/api/books/1", subtitled(1, "A", "s")],
      ["GET", "/api/books/2", subtitled(2, "B", "t")],
      ["PATCH", "/api/books/1", "", 204, { name: "Z" }],
      ["GET", "/api/books/1", subtitled(1, "Z")],
      summaries("Z"),
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: false,
      reason: "unexplained-change",
    });
  });

  it("keeps an update whose partial response leaves out a field a later read still shows", () => {
    const rows: TimedCaptureRow[] = [
      summaries("A"),
      ["GET", "/api/books/1", subtitled(1, "A", "s")],
      ["GET", "/api/books/2", subtitled(2, "B", "t")],
      ["PATCH", "/api/books/1", subtitled(1, "Z"), 200, { name: "Z" }],
      ["GET", "/api/books/1", subtitled(1, "Z", "s")],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [4],
    });
  });
});

describe("what an unmodelled write explains", () => {
  it("weighs an unmodelled write against a tool's call on the entity a read checks, not its latest call elsewhere", () => {
    const tagged = (id: number, name: string, tag: string) => ({
      id,
      name,
      tag,
    });
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [tagged(1, "A", "x"), tagged(2, "B", "x")]],
      ["GET", "/api/books/1", tagged(1, "A", "x")],
      ["GET", "/api/books/2", tagged(2, "B", "x")],
      ["PATCH", "/api/books/1", tagged(1, "A2", "x"), 200, { name: "A2" }],
      ["POST", "/api/exports", { queued: true }, 202, { format: "csv" }],
      ["PATCH", "/api/books/2", tagged(2, "B2", "x"), 200, { name: "B2" }],
      // The export came after book 1's rename, so it may explain the changed tag; the rename itself shows.
      ["GET", "/api/books/1", tagged(1, "A2", "y")],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: true,
      contradicted_by: null,
      checked_record_ordinals: [6],
    });
  });

  it("lets an unmodelled write explain a list's change to an entity a tool made before it, whatever the tool did after", () => {
    const fourth = book(4, "Fourth Book", bookClock(5));
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      ["POST", "/api/exports", { queued: true }, 202, { format: "csv" }],
      ["POST", "/api/books", fourth, 201, { name: "Fourth Book" }],
      ["GET", "/api/books/4", fourth],
      // The export came after the third book was made, so it may explain the third book's other name.
      [
        "GET",
        "/api/books",
        [FIRST_BOOK, SECOND_BOOK, { ...THIRD_BOOK, name: "Retitled" }, fourth],
      ],
    ];
    expect(gated(rows, "post_books")).toMatchObject({
      served: true,
      contradicted_by: null,
    });
  });

  it("weighs no unmodelled write against a call whose effect a later write overwrote", () => {
    const named = (id: number, name: string) => ({
      ...book(id, name, bookClock(0)),
      id,
    });
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [named(1, "A"), named(2, "B")]],
      ["GET", "/api/books/1", named(1, "A")],
      ["GET", "/api/books/2", named(2, "B")],
      ["PATCH", "/api/books/1", named(1, "A2"), 200, { name: "A2" }],
      ["POST", "/api/exports", { queued: true }, 202, { format: "csv" }],
      // The PUT overwrites the patch's only change on book 1.
      ["PUT", "/api/books/1", named(1, "A3"), 200, { name: "A3" }],
      ["PATCH", "/api/books/2", named(2, "B2"), 200, { name: "B2" }],
      ["GET", "/api/books/2", named(2, "B2")],
      // The export came before book 2's patch, which the list shows undone.
      ["GET", "/api/books", [named(1, "A3"), named(2, "B")]],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: false,
      contradicted_by: 8,
    });
  });

  it("contradicts by a failed item read the writes no unmodelled write came after, checking only the others' members", () => {
    const enveloped = (data: Record<string, JsonValue>, revision: string) => ({
      data,
      revision,
    });
    const full = (name: string, description: string) => ({
      id: 1,
      name,
      description,
    });
    const summary = [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
    ];
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", summary],
      ["GET", "/api/books/1", enveloped(full("A", "x"), "r1")],
      [
        "GET",
        "/api/books/2",
        enveloped({ id: 2, name: "B", description: "y" }, "r1"),
      ],
      ["PATCH", "/api/books/1", full("A", "new"), 200, { description: "new" }],
      ["GET", "/api/books", summary],
      ["POST", "/api/exports", { queued: true }, 202, { format: "csv" }],
      // The rename sends the name alone, so the earlier description patch stays pending.
      ["PUT", "/api/books/1", full("Z", "new"), 200, { name: "Z" }],
      // The rename shows, but the envelope serving would answer with does not.
      ["GET", "/api/books/1", enveloped(full("Z", "new"), "r2")],
    ];
    expect(gated(rows, "put_books_by_id")).toMatchObject({
      served: false,
      contradicted_by: 7,
    });
  });

  it("contradicts a write made after an unmodelled one, though an earlier pending write came before it", () => {
    const summary = (name: string) => [
      { id: 1, name },
      { id: 2, name: "B" },
    ];
    const full = (name: string, description: string) => ({
      id: 1,
      name,
      description,
    });
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", summary("A")],
      ["GET", "/api/books/1", full("A", "x")],
      ["GET", "/api/books/2", { id: 2, name: "B", description: "y" }],
      ["PATCH", "/api/books/1", full("A", "new"), 200, { description: "new" }],
      ["GET", "/api/books", summary("A")],
      ["POST", "/api/exports", { queued: true }, 202, { format: "csv" }],
      [
        "PUT",
        "/api/books/1",
        full("Z", "new"),
        200,
        { name: "Z", description: "new" },
      ],
      ["GET", "/api/books/1", full("Z", "new")],
      // The export came before the rename, so it cannot explain the list showing the old name.
      ["GET", "/api/books", summary("A")],
    ];
    expect(gated(rows, "put_books_by_id")).toMatchObject({
      served: false,
      contradicted_by: 8,
    });
  });
});

describe("what later calls must keep consistent", () => {
  it("refuses an update one call sends an ignored id with and another the path's id", () => {
    const renamed = (at: Book, name: string) => ({ ...at, name });
    const rows: TimedCaptureRow[] = [
      ...BOOK_INIT_ROWS,
      [
        "PATCH",
        "/api/books/1",
        renamed(FIRST_BOOK, "B"),
        200,
        { id: 999, name: "B" },
      ],
      ["GET", "/api/books/1", renamed(FIRST_BOOK, "B")],
      [
        "PATCH",
        "/api/books/2",
        renamed(SECOND_BOOK, "C"),
        200,
        { id: 2, name: "C" },
      ],
      ["GET", "/api/books/2", renamed(SECOND_BOOK, "C")],
    ];
    expect(gated(rows, "patch_books_by_id")).toMatchObject({
      served: false,
      reason: "unexplained-change",
    });
  });

  it("refuses a create whose later call records a clock in another format", () => {
    const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    const fourth = {
      ...book(4, "Fourth Book", bookClock(5)),
      created_at: epoch(bookClock(5)),
      updated_at: epoch(bookClock(5)),
    };
    const rows: TimedCaptureRow[] = [
      ...BOOK_INIT_ROWS,
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      ["GET", "/api/books/3", THIRD_BOOK],
      ["POST", "/api/books", fourth, 201, { name: "Fourth Book" }],
      ["GET", "/api/books/4", fourth],
    ];
    expect(gated(rows, "post_books")).toMatchObject({
      served: false,
      reason: "unexplained-change",
    });
  });

  it("names no entity by a delete whose path id decodes to it only twice, as serving would not", () => {
    const uid = (key: string) => ({ uid: key, name: key });
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/books", [uid("book1"), uid("book2")]],
      ["GET", "/api/books/uid/book1", uid("book1")],
      ["GET", "/api/books/uid/book2", uid("book2")],
      ["DELETE", "/api/books/uid/book%2531", "", 204],
      ["GET", "/api/books/uid/book1", BOOK_NOT_FOUND, 404],
    ];
    const { writes } = environmentStateViewOf(timedCaptureEvidence(rows), [
      "after-uid-literal",
    ]);
    expect(writes.find((plan) => plan.effect === "delete")).toMatchObject({
      served: false,
      checked_record_ordinals: [],
    });
  });

  it("checks nothing by a whole line recorded empty under a zero limit once a create fills its collection", () => {
    const alpha = { id: 1, name: "Alpha", org: "1" };
    const beta = { id: 2, name: "Beta", org: "2" };
    const rows: TimedCaptureRow[] = [
      ["GET", "/api/orgs/1/books", [alpha]],
      ["GET", "/api/orgs/1/books/1", alpha],
      ["GET", "/api/orgs/2/books?limit=0", []],
      ["POST", "/api/orgs/2/books", beta, 201, { name: "Beta" }],
      ["GET", "/api/orgs/2/books/2", beta],
      // An empty recording does not show that zero lists every entity.
      ["GET", "/api/orgs/2/books?limit=0", []],
    ];
    const { writes } = environmentStateViewOf(timedCaptureEvidence(rows));
    expect(writes.find((plan) => plan.effect === "create")).toMatchObject({
      served: true,
      checked_record_ordinals: [4],
    });
  });
});
