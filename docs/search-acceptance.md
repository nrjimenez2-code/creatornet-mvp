# Search release acceptance

The release must satisfy the revised ten-point search plan. No expertise form is required and personal learning interests must not imply expertise.

1. Creator discovery uses existing public profile, post and offering text; updates and removals propagate.
2. Relevant posts and offerings contribute to creator discovery. Luis appears for e-commerce based on his existing content.
3. Equivalent terms normalize consistently; related topics rank below direct matches; typos have bounded tolerance.
4. Exact identities and strong topical evidence rank first. Repeated evidence gives a capped boost; follower counts are not required.
5. Unrelated fallback accounts are removed; empty and failed searches are distinct.
6. All, Creators, Videos and Offerings retrieve independently. Name matches do not suppress other relevant videos.
7. Creator cards explain matches using actual source evidence, without inventing expertise or revealing private content.
8. Both entry points offer live creator/topic completions. Discovery topics come from eligible public content and are labeled accurately.
9. Hashtags use their real array type; stale requests cannot replace current results; clearing/back navigation work; pagination is deterministic; hidden/removed content and banned creators stay excluded.
10. Instrument result impressions, empty searches, reformulations, result opens and latency; document measurable relevance checks. Extend content understanding to transcripts and on-screen text as specified in the plan, with truthful source handling and verified ingestion before claiming it works.

Verification must include database integration fixtures, API validation/failure/rate-limit coverage, client race and navigation checks, mobile/desktop hosted preview, existing CI, and production verification of the exact merge commit.

Release workflow: latest main → feature branch → tests and hosted preview → green PR → merge → GitHub-triggered Vercel production. Database changes must be additive and verified before application cutover.
