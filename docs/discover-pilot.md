# Controlled Discover pilot

Status: implementation for the first comparison is prepared; no experiment is activated and no calibration result is claimed.

## First comparison

`commercial-order-v1` compares the current ordinal commercial ordering with the same ranker with purchase, scheduled booking, checkout and product-tap ordering disabled. Relevance, personal preferences, qualified viewing, offer queues, unseen priority, creator spacing, new-post exploration and related-audience trials remain the same in both arms. This isolates commercial ordering, not the entire Discover system. Related-audience qualification still uses commercial evidence in both arms.

The randomization unit is the signed-in viewer. SHA-256 of the version, experiment ID and user ID selects a 50/50 arm; a private persisted assignment is authoritative thereafter. Anonymous visitors and Following do not enroll. Existing feed snapshots do not change order. Enrolled viewers remain in their original arm during the experiment; after its end the default ranking resumes. Changing algorithms or protocol requires a new experiment ID.

## Activation gates

1. Apply `20260914093000_discover_controlled_pilot.sql` to staging and verify private permissions and a deployed two-arm smoke test. The default path does not query pilot tables when `DISCOVER_PILOT_ID` is absent.
2. Register one disabled row in `discover_pilots_v1`. Specify enrollment start/end, follow-up days, and a written protocol identifying population, exclusions, primary outcome, minimum detectable effect, power/sample-size calculation, guardrails and stop criteria. Protocol dates/content freeze after first enrollment; `enabled=false` remains the emergency stop.
3. Use a distinct QA experiment to test both arms, session persistence, zero-event viewers and purchase/refund updates. Register the explicit participant UUID list in `eligible_user_ids`; an empty list enrolls nobody. Both application and database reject unlisted viewers, and the participant list freezes after the first enrollment. Do not include QA accounts in a real pilot population. Report the recruitment/eligibility criteria and limits of generalizing from this selected population.
4. Set server-only `DISCOVER_PILOT_ID` to the registered ID only on the pilot deployment, then enable that row. Missing or incompatible configuration fails the request instead of silently switching an enrolled viewer's treatment. A disabled or out-of-window experiment uses default ranking.

## Measurement

`discover_pilot_outcomes_v1` retains each randomized viewer, including zero-event viewers. It counts events from assignment through that viewer's fixed follow-up window, even after enrollment closes. These are intention-to-treat outcomes across all channels, not proof that every action originated in Discover. Use one binary purchaser outcome per viewer for the primary conversion comparison; multiple purchases are a separate count outcome. `discover_pilot_revenue_v1` keeps currency separate and reflects valid net purchase events after refund/dispute reconciliation. A missing revenue row means zero, not a reason to drop the randomized viewer.

Do not evaluate immature assignments as zero-conversion final outcomes. Select viewers whose observation end has passed for the final comparison, keep enrollment dates fixed, report assignment balance and uncertainty, and use the registered stopping rule. Shared creator evidence can cause interference between viewer arms; report that limitation rather than interpreting the result as an isolated marketplace-wide effect.

Before calling all ranking requirements validated, additionally implement durable Discover-only exposure/position diagnostics for new-video reach, repeat exposure, creator concentration, declared-interest/topic cohorts, related-audience trials and retest slots. Session snapshots currently record pilot ID/arm but expire after two hours; they are not a durable exposure ledger. The existing aggregate event views are useful diagnostics but do not identify which policy slot served an exposure.

The available QA transactions and small live inventory cannot determine commercial weights or statistically reliable distribution thresholds. Sample-size inputs require an actual eligible population and baseline conversion estimate. No fabricated traffic or local fixture may be reported as a real controlled pilot.
