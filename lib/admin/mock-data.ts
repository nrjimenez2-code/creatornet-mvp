import type {
  ActivityEvent,
  AdminBooking,
  AdminOrder,
  AdminUser,
  AdminVideo,
} from "@/types/admin";

/**
 * Deterministic demo data for the Admin Launch Board.
 *
 * INTEGRATION POINT: every export here maps to one Supabase query in the real
 * app (see docs/ADMIN_HANDOFF.md for the exact query per dataset). Swap the
 * constants for those queries and the UI needs no changes.
 */

export const MOCK_USERS: AdminUser[] = [
  {
    id: "u_01", username: "fitwithmara", displayName: "Mara Delgado",
    email: "mara@example.com", isCreator: true,
    stripeAccountId: "acct_demo_mara", chargesEnabled: true, payoutsEnabled: true,
    onboardingComplete: true, totalEarningsCents: 482300, rating: 4.9,
    postCount: 24, followerCount: 12800, status: "active", flagReason: null,
    joinedAt: "2026-05-11T14:20:00Z", lastActiveAt: "2026-08-01T02:10:00Z",
  },
  {
    id: "u_02", username: "codewithdrew", displayName: "Drew Tanaka",
    email: "drew@example.com", isCreator: true,
    stripeAccountId: "acct_demo_drew", chargesEnabled: true, payoutsEnabled: true,
    onboardingComplete: true, totalEarningsCents: 291750, rating: 4.7,
    postCount: 31, followerCount: 9400, status: "active", flagReason: null,
    joinedAt: "2026-05-18T09:05:00Z", lastActiveAt: "2026-07-31T22:41:00Z",
  },
  {
    id: "u_03", username: "sellwithsofia", displayName: "Sofia Reyes",
    email: "sofia@example.com", isCreator: true,
    stripeAccountId: "acct_demo_sofia", chargesEnabled: true, payoutsEnabled: false,
    onboardingComplete: false, totalEarningsCents: 76900, rating: 4.5,
    postCount: 12, followerCount: 3600, status: "active", flagReason: null,
    joinedAt: "2026-06-02T17:44:00Z", lastActiveAt: "2026-07-30T19:12:00Z",
  },
  {
    id: "u_04", username: "chefluis", displayName: "Luis Herrera",
    email: "luis@example.com", isCreator: true,
    stripeAccountId: "acct_demo_luis", chargesEnabled: true, payoutsEnabled: true,
    onboardingComplete: true, totalEarningsCents: 158200, rating: 4.8,
    postCount: 18, followerCount: 7100, status: "active", flagReason: null,
    joinedAt: "2026-06-09T11:30:00Z", lastActiveAt: "2026-07-31T15:02:00Z",
  },
  {
    id: "u_05", username: "mindsetmax", displayName: "Max Okafor",
    email: "max@example.com", isCreator: true,
    stripeAccountId: null, chargesEnabled: false, payoutsEnabled: false,
    onboardingComplete: false, totalEarningsCents: 0, rating: null,
    postCount: 6, followerCount: 980, status: "flagged",
    flagReason: "Reported 3x: income claims without disclosure",
    joinedAt: "2026-07-14T08:12:00Z", lastActiveAt: "2026-07-31T23:55:00Z",
  },
  {
    id: "u_06", username: "jennawatches", displayName: "Jenna Ellis",
    email: "jenna@example.com", isCreator: false,
    stripeAccountId: null, chargesEnabled: false, payoutsEnabled: false,
    onboardingComplete: false, totalEarningsCents: 0, rating: null,
    postCount: 0, followerCount: 0, status: "active", flagReason: null,
    joinedAt: "2026-07-20T20:15:00Z", lastActiveAt: "2026-08-01T01:34:00Z",
  },
  {
    id: "u_07", username: "tradeking_247", displayName: "Trade King",
    email: "tradeking@example.com", isCreator: true,
    stripeAccountId: null, chargesEnabled: false, payoutsEnabled: false,
    onboardingComplete: false, totalEarningsCents: 0, rating: 1.2,
    postCount: 9, followerCount: 45, status: "banned",
    flagReason: "Guaranteed-returns crypto scheme; banned 7/28",
    joinedAt: "2026-07-25T03:40:00Z", lastActiveAt: "2026-07-28T04:00:00Z",
  },
  {
    id: "u_08", username: "gloupbyava", displayName: "Ava Lindqvist",
    email: "ava@example.com", isCreator: true,
    stripeAccountId: "acct_demo_ava", chargesEnabled: true, payoutsEnabled: true,
    onboardingComplete: true, totalEarningsCents: 121400, rating: 4.6,
    postCount: 15, followerCount: 5200, status: "active", flagReason: null,
    joinedAt: "2026-06-21T13:08:00Z", lastActiveAt: "2026-07-31T18:26:00Z",
  },
  {
    id: "u_09", username: "quietwatcher", displayName: "Sam Porter",
    email: "sam@example.com", isCreator: false,
    stripeAccountId: null, chargesEnabled: false, payoutsEnabled: false,
    onboardingComplete: false, totalEarningsCents: 0, rating: null,
    postCount: 0, followerCount: 0, status: "active", flagReason: null,
    joinedAt: "2026-07-28T16:50:00Z", lastActiveAt: "2026-07-31T21:07:00Z",
  },
  {
    id: "u_10", username: "freegiftcards4u", displayName: "Gift Card Pro",
    email: "gcpro@example.com", isCreator: false,
    stripeAccountId: null, chargesEnabled: false, payoutsEnabled: false,
    onboardingComplete: false, totalEarningsCents: 0, rating: null,
    postCount: 0, followerCount: 2, status: "flagged",
    flagReason: "Spam: comment-links to external gift-card site",
    joinedAt: "2026-07-30T05:22:00Z", lastActiveAt: "2026-07-31T05:19:00Z",
  },
  {
    id: "u_11", username: "languagelab_ko", displayName: "Hana Kim",
    email: "hana@example.com", isCreator: true,
    stripeAccountId: "acct_demo_hana", chargesEnabled: true, payoutsEnabled: true,
    onboardingComplete: true, totalEarningsCents: 64500, rating: 5.0,
    postCount: 11, followerCount: 2900, status: "active", flagReason: null,
    joinedAt: "2026-07-03T10:55:00Z", lastActiveAt: "2026-07-31T12:48:00Z",
  },
  {
    id: "u_12", username: "newbie_nate", displayName: "Nate Boone",
    email: "nate@example.com", isCreator: false,
    stripeAccountId: null, chargesEnabled: false, payoutsEnabled: false,
    onboardingComplete: false, totalEarningsCents: 0, rating: null,
    postCount: 0, followerCount: 0, status: "active", flagReason: null,
    joinedAt: "2026-08-01T00:18:00Z", lastActiveAt: "2026-08-01T00:44:00Z",
  },
];

export const MOCK_VIDEOS: AdminVideo[] = [
  {
    id: "v_01", creatorId: "u_01", creatorUsername: "fitwithmara", creatorName: "Mara Delgado",
    title: "3 mobility drills that fixed my squat", interests: ["fitness"],
    hashtags: ["#mobility", "#squat"], priceCents: 1900, allowBooking: false,
    viewCount: 48200, likeCount: 3900, commentCount: 214, shareCount: 480,
    status: "live", flagReason: null, createdAt: "2026-07-29T15:04:00Z",
  },
  {
    id: "v_02", creatorId: "u_02", creatorUsername: "codewithdrew", creatorName: "Drew Tanaka",
    title: "Ship your first API in 60 seconds", interests: ["coding"],
    hashtags: ["#webdev", "#api"], priceCents: 4900, allowBooking: true,
    viewCount: 31500, likeCount: 2700, commentCount: 188, shareCount: 350,
    status: "live", flagReason: null, createdAt: "2026-07-30T18:22:00Z",
  },
  {
    id: "v_03", creatorId: "u_05", creatorUsername: "mindsetmax", creatorName: "Max Okafor",
    title: "How I made $40k in 30 days (no skills needed)", interests: ["business"],
    hashtags: ["#hustle", "#passive"], priceCents: 9900, allowBooking: false,
    viewCount: 12100, likeCount: 240, commentCount: 96, shareCount: 33,
    status: "flagged", flagReason: "Income claim, no disclosure — 3 user reports",
    createdAt: "2026-07-31T02:11:00Z",
  },
  {
    id: "v_04", creatorId: "u_04", creatorUsername: "chefluis", creatorName: "Luis Herrera",
    title: "The only knife skill 90% of cooks skip", interests: ["cooking"],
    hashtags: ["#knifeskills", "#chef"], priceCents: null, allowBooking: true,
    viewCount: 27600, likeCount: 2300, commentCount: 145, shareCount: 210,
    status: "live", flagReason: null, createdAt: "2026-07-28T12:40:00Z",
  },
  {
    id: "v_05", creatorId: "u_07", creatorUsername: "tradeking_247", creatorName: "Trade King",
    title: "Guaranteed 10x: send me $100, get $1000", interests: ["finance"],
    hashtags: ["#crypto", "#guaranteed"], priceCents: 10000, allowBooking: false,
    viewCount: 3400, likeCount: 18, commentCount: 41, shareCount: 2,
    status: "removed", flagReason: "Financial scam — removed & creator banned 7/28",
    createdAt: "2026-07-26T22:38:00Z",
  },
  {
    id: "v_06", creatorId: "u_08", creatorUsername: "gloupbyava", creatorName: "Ava Lindqvist",
    title: "5-minute glow routine before every stream", interests: ["beauty"],
    hashtags: ["#skincare", "#glowup"], priceCents: 1500, allowBooking: false,
    viewCount: 19800, likeCount: 1750, commentCount: 92, shareCount: 160,
    status: "live", flagReason: null, createdAt: "2026-07-30T09:15:00Z",
  },
  {
    id: "v_07", creatorId: "u_03", creatorUsername: "sellwithsofia", creatorName: "Sofia Reyes",
    title: "Etsy SEO: the 3 tags doing all the work", interests: ["business"],
    hashtags: ["#etsy", "#seo"], priceCents: 2900, allowBooking: true,
    viewCount: 8900, likeCount: 720, commentCount: 63, shareCount: 88,
    status: "live", flagReason: null, createdAt: "2026-07-31T14:03:00Z",
  },
  {
    id: "v_08", creatorId: "u_11", creatorUsername: "languagelab_ko", creatorName: "Hana Kim",
    title: "Korean particles in one whiteboard", interests: ["language"],
    hashtags: ["#korean", "#studytok"], priceCents: 1200, allowBooking: true,
    viewCount: 15400, likeCount: 1980, commentCount: 240, shareCount: 310,
    status: "live", flagReason: null, createdAt: "2026-07-29T07:48:00Z",
  },
  {
    id: "v_09", creatorId: "u_02", creatorUsername: "codewithdrew", creatorName: "Drew Tanaka",
    title: "Stop writing useEffect for this", interests: ["coding"],
    hashtags: ["#react", "#hooks"], priceCents: null, allowBooking: true,
    viewCount: 22100, likeCount: 2450, commentCount: 201, shareCount: 275,
    status: "live", flagReason: null, createdAt: "2026-07-31T20:30:00Z",
  },
  {
    id: "v_10", creatorId: "u_01", creatorUsername: "fitwithmara", creatorName: "Mara Delgado",
    title: "Hotel workout: zero equipment, 12 minutes", interests: ["fitness"],
    hashtags: ["#travel", "#workout"], priceCents: 1900, allowBooking: false,
    viewCount: 9700, likeCount: 840, commentCount: 51, shareCount: 77,
    status: "hidden", flagReason: "Hidden by admin: duplicate upload",
    createdAt: "2026-07-27T19:26:00Z",
  },
  {
    id: "v_11", creatorId: "u_10", creatorUsername: "freegiftcards4u", creatorName: "Gift Card Pro",
    title: "FREE $500 gift card — link in bio!!", interests: ["other"],
    hashtags: ["#free", "#giftcard"], priceCents: null, allowBooking: false,
    viewCount: 610, likeCount: 4, commentCount: 12, shareCount: 0,
    status: "flagged", flagReason: "Spam/phishing — 6 user reports",
    createdAt: "2026-07-31T05:12:00Z",
  },
  {
    id: "v_12", creatorId: "u_04", creatorUsername: "chefluis", creatorName: "Luis Herrera",
    title: "Meal prep 5 lunches for $12 total", interests: ["cooking"],
    hashtags: ["#mealprep", "#budget"], priceCents: 2400, allowBooking: true,
    viewCount: 33800, likeCount: 3100, commentCount: 260, shareCount: 420,
    status: "live", flagReason: null, createdAt: "2026-08-01T01:05:00Z",
  },
];

export const MOCK_ORDERS: AdminOrder[] = [
  {
    id: "o_01", buyerUserId: "u_06", buyerUsername: "jennawatches",
    creatorId: "u_01", creatorUsername: "fitwithmara", postId: "v_01",
    offerTitle: "Mobility Reset Program", kind: "product",
    grossCents: 1900, feeCents: 228, creatorCents: 1672,
    status: "paid", createdAt: "2026-07-31T23:58:00Z",
  },
  {
    id: "o_02", buyerUserId: "u_09", buyerUsername: "quietwatcher",
    creatorId: "u_02", creatorUsername: "codewithdrew", postId: "v_02",
    offerTitle: "API Bootcamp (recorded)", kind: "product",
    grossCents: 4900, feeCents: 588, creatorCents: 4312,
    status: "paid", createdAt: "2026-07-31T21:14:00Z",
  },
  {
    id: "o_03", buyerUserId: "u_12", buyerUsername: "newbie_nate",
    creatorId: "u_04", creatorUsername: "chefluis", postId: "v_12",
    offerTitle: "Budget Meal Prep Guide", kind: "product",
    grossCents: 2400, feeCents: 288, creatorCents: 2112,
    status: "paid", createdAt: "2026-08-01T01:22:00Z",
  },
  {
    id: "o_04", buyerUserId: "u_06", buyerUsername: "jennawatches",
    creatorId: "u_08", creatorUsername: "gloupbyava", postId: "v_06",
    offerTitle: "Stream-Ready Skincare List", kind: "product",
    grossCents: 1500, feeCents: 180, creatorCents: 1320,
    status: "refunded", createdAt: "2026-07-30T10:02:00Z",
  },
  {
    id: "o_05", buyerUserId: "u_09", buyerUsername: "quietwatcher",
    creatorId: "u_11", creatorUsername: "languagelab_ko", postId: "v_08",
    offerTitle: "Korean Grammar Map (PDF)", kind: "product",
    grossCents: 1200, feeCents: 144, creatorCents: 1056,
    status: "paid", createdAt: "2026-07-30T08:31:00Z",
  },
  {
    id: "o_06", buyerUserId: "u_12", buyerUsername: "newbie_nate",
    creatorId: "u_02", creatorUsername: "codewithdrew", postId: null,
    offerTitle: "1:1 Code Review Call", kind: "booking",
    grossCents: 12000, feeCents: 1440, creatorCents: 10560,
    status: "paid", createdAt: "2026-07-31T19:45:00Z",
  },
  {
    id: "o_07", buyerUserId: "u_06", buyerUsername: "jennawatches",
    creatorId: "u_03", creatorUsername: "sellwithsofia", postId: "v_07",
    offerTitle: "Etsy SEO Mini-Course", kind: "installments",
    grossCents: 2900, feeCents: 348, creatorCents: 2552,
    status: "pending", createdAt: "2026-08-01T00:52:00Z",
  },
  {
    id: "o_08", buyerUserId: "u_09", buyerUsername: "quietwatcher",
    creatorId: "u_04", creatorUsername: "chefluis", postId: null,
    offerTitle: "Private Cooking Session", kind: "booking",
    grossCents: 8500, feeCents: 1020, creatorCents: 7480,
    status: "paid", createdAt: "2026-07-29T17:40:00Z",
  },
  {
    id: "o_09", buyerUserId: "u_12", buyerUsername: "newbie_nate",
    creatorId: "u_01", creatorUsername: "fitwithmara", postId: "v_10",
    offerTitle: "Hotel Workout Pack", kind: "product",
    grossCents: 1900, feeCents: 228, creatorCents: 1672,
    status: "failed", createdAt: "2026-07-28T22:19:00Z",
  },
  {
    id: "o_10", buyerUserId: "u_06", buyerUsername: "jennawatches",
    creatorId: "u_11", creatorUsername: "languagelab_ko", postId: null,
    offerTitle: "30-min Tutoring Session", kind: "booking",
    grossCents: 4500, feeCents: 540, creatorCents: 3960,
    status: "paid", createdAt: "2026-07-31T13:27:00Z",
  },
];

export const MOCK_BOOKINGS: AdminBooking[] = [
  {
    id: "b_01", creatorId: "u_02", creatorUsername: "codewithdrew",
    buyerUserId: "u_12", buyerUsername: "newbie_nate",
    offerTitle: "1:1 Code Review Call", amountCents: 12000,
    status: "confirmed", createdAt: "2026-07-31T19:45:00Z",
  },
  {
    id: "b_02", creatorId: "u_04", creatorUsername: "chefluis",
    buyerUserId: "u_09", buyerUsername: "quietwatcher",
    offerTitle: "Private Cooking Session", amountCents: 8500,
    status: "completed", createdAt: "2026-07-29T17:40:00Z",
  },
  {
    id: "b_03", creatorId: "u_11", creatorUsername: "languagelab_ko",
    buyerUserId: "u_06", buyerUsername: "jennawatches",
    offerTitle: "30-min Tutoring Session", amountCents: 4500,
    status: "confirmed", createdAt: "2026-07-31T13:27:00Z",
  },
  {
    id: "b_04", creatorId: "u_03", creatorUsername: "sellwithsofia",
    buyerUserId: "u_12", buyerUsername: "newbie_nate",
    offerTitle: "Shop Audit Call", amountCents: null,
    status: "pending", createdAt: "2026-08-01T00:58:00Z",
  },
  {
    id: "b_05", creatorId: "u_02", creatorUsername: "codewithdrew",
    buyerUserId: "u_09", buyerUsername: "quietwatcher",
    offerTitle: "Career Strategy Call", amountCents: 12000,
    status: "canceled", createdAt: "2026-07-27T11:05:00Z",
  },
  {
    id: "b_06", creatorId: "u_01", creatorUsername: "fitwithmara",
    buyerUserId: "u_06", buyerUsername: "jennawatches",
    offerTitle: "Form Check Session", amountCents: 6000,
    status: "completed", createdAt: "2026-07-30T16:22:00Z",
  },
];

export const MOCK_ACTIVITY: ActivityEvent[] = [
  { id: "a_01", kind: "purchase", actorUsername: "newbie_nate", message: "bought \"Budget Meal Prep Guide\" from @chefluis ($24.00)", occurredAt: "2026-08-01T01:22:00Z" },
  { id: "a_02", kind: "upload", actorUsername: "chefluis", message: "uploaded \"Meal prep 5 lunches for $12 total\"", occurredAt: "2026-08-01T01:05:00Z" },
  { id: "a_03", kind: "booking", actorUsername: "newbie_nate", message: "requested \"Shop Audit Call\" with @sellwithsofia", occurredAt: "2026-08-01T00:58:00Z" },
  { id: "a_04", kind: "signup", actorUsername: "newbie_nate", message: "created an account", occurredAt: "2026-08-01T00:18:00Z" },
  { id: "a_05", kind: "purchase", actorUsername: "jennawatches", message: "bought \"Mobility Reset Program\" from @fitwithmara ($19.00)", occurredAt: "2026-07-31T23:58:00Z" },
  { id: "a_06", kind: "flag", actorUsername: "freegiftcards4u", message: "video \"FREE $500 gift card\" hit 6 reports — needs review", occurredAt: "2026-07-31T22:50:00Z" },
  { id: "a_07", kind: "purchase", actorUsername: "quietwatcher", message: "bought \"API Bootcamp (recorded)\" from @codewithdrew ($49.00)", occurredAt: "2026-07-31T21:14:00Z" },
  { id: "a_08", kind: "upload", actorUsername: "codewithdrew", message: "uploaded \"Stop writing useEffect for this\"", occurredAt: "2026-07-31T20:30:00Z" },
  { id: "a_09", kind: "booking", actorUsername: "newbie_nate", message: "booked \"1:1 Code Review Call\" with @codewithdrew ($120.00)", occurredAt: "2026-07-31T19:45:00Z" },
  { id: "a_10", kind: "flag", actorUsername: "mindsetmax", message: "video \"How I made $40k in 30 days\" hit 3 reports — needs review", occurredAt: "2026-07-31T16:33:00Z" },
  { id: "a_11", kind: "stripe_connect", actorUsername: "languagelab_ko", message: "completed Stripe Connect onboarding — payouts enabled", occurredAt: "2026-07-30T09:41:00Z" },
  { id: "a_12", kind: "signup", actorUsername: "freegiftcards4u", message: "created an account", occurredAt: "2026-07-30T05:22:00Z" },
];

// Platform aggregates are computed live in AdminDataContext (single source of
// truth) so they always reflect the current session state and can never drift
// from the datasets above.
