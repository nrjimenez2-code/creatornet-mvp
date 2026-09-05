import {
  SOCIAL_PROOF_MIN_COUNT,
  formatSocialProof,
  formatSocialProofWithMin,
} from "@/lib/socialProof";

const MIN = 5;

describe("formatSocialProofWithMin threshold", () => {
  test("hides one below the threshold and shows at the threshold", () => {
    expect(formatSocialProofWithMin(MIN - 1, "video", MIN)).toBeNull();
    expect(formatSocialProofWithMin(MIN, "video", MIN)).toBe("5 purchases");
  });

  test("shows well above the threshold", () => {
    expect(formatSocialProofWithMin(38, "video", MIN)).toBe("38 purchases");
    expect(formatSocialProofWithMin(126, "course", MIN)).toBe("126 students");
  });

  test("threshold of 1 shows a single sale", () => {
    expect(formatSocialProofWithMin(1, "video", 1)).toBe("1 purchase");
    expect(formatSocialProofWithMin(0, "video", 1)).toBeNull();
  });
});

describe("wording per product type", () => {
  test("course reads students, singular and plural", () => {
    expect(formatSocialProofWithMin(1, "course", 1)).toBe("1 student");
    expect(formatSocialProofWithMin(2, "course", 1)).toBe("2 students");
    expect(formatSocialProofWithMin(2, "COURSE", 1)).toBe("2 students");
  });

  test("video, mentorship, unknown and null types read purchases", () => {
    expect(formatSocialProofWithMin(1, "video", 1)).toBe("1 purchase");
    expect(formatSocialProofWithMin(3, "video", 1)).toBe("3 purchases");
    expect(formatSocialProofWithMin(3, "mentorship", 1)).toBe("3 purchases");
    expect(formatSocialProofWithMin(3, "digital", 1)).toBe("3 purchases");
    expect(formatSocialProofWithMin(3, null, 1)).toBe("3 purchases");
    expect(formatSocialProofWithMin(3, undefined, 1)).toBe("3 purchases");
  });
});

describe("junk input", () => {
  test("null, undefined, NaN and negatives return null", () => {
    expect(formatSocialProofWithMin(null, "course", 0)).toBeNull();
    expect(formatSocialProofWithMin(undefined, "course", 0)).toBeNull();
    expect(formatSocialProofWithMin(Number.NaN, "course", 0)).toBeNull();
    expect(formatSocialProofWithMin(-1, "course", 0)).toBeNull();
    expect(formatSocialProofWithMin("7" as unknown as number, "course", 0)).toBeNull();
  });
});

describe("formatSocialProof (shipped threshold)", () => {
  test("ships OFF: the constant is MAX_SAFE_INTEGER and nothing renders", () => {
    // Noah picks the real threshold; until then no card can reach it.
    expect(SOCIAL_PROOF_MIN_COUNT).toBe(Number.MAX_SAFE_INTEGER);
    expect(formatSocialProof(126, "course")).toBeNull();
    expect(formatSocialProof(1_000_000, "video")).toBeNull();
    expect(formatSocialProof(null, "video")).toBeNull();
  });

  test("delegates to the helper with the shipped constant", () => {
    expect(formatSocialProof(Number.MAX_SAFE_INTEGER, "course")).toBe(
      formatSocialProofWithMin(Number.MAX_SAFE_INTEGER, "course", SOCIAL_PROOF_MIN_COUNT)
    );
  });
});
