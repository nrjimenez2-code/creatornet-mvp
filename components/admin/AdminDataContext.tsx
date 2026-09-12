"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  MOCK_BOOKINGS,
  MOCK_ORDERS,
  MOCK_USERS,
  MOCK_VIDEOS,
} from "@/lib/admin/mock-data";
import { useToast } from "@/components/admin/Toast";
import { DEMO_TODAY_ISO } from "@/lib/admin/series";
import type {
  AdminBooking,
  AdminInitialData,
  AdminOrder,
  AdminUser,
  AdminVideo,
  PlatformStats,
} from "@/types/admin";

/**
 * Endpoint names the moderation actions POST to. The API agent implements
 * each as app/api/admin/<name>/route.ts guarded by requireAdmin().
 * Bodies: ban/unban -> { userId }, the four post actions -> { postId }.
 */
type AdminActionEndpoint =
  | "ban"
  | "unban"
  | "hide-post"
  | "unhide-post"
  | "remove-post"
  | "approve-post";

async function postAdminAction(
  endpoint: AdminActionEndpoint,
  body: Record<string, string>,
): Promise<void> {
  const res = await fetch(`/api/admin/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`/api/admin/${endpoint} responded ${res.status}`);
  }
}

/**
 * Session-wide admin data store.
 *
 * One source of truth for users/videos so moderation actions propagate
 * everywhere (sidebar badge, Overview attention queue, tables) and survive
 * navigation between admin pages.
 *
 * Two modes:
 * - Seeded (initialData passed by the server layout/pages): actions update
 *   local state optimistically AND call the matching POST /api/admin/* route,
 *   reverting with an error toast when the request fails.
 * - Demo (no initialData): mock rows, local-state-only actions, no fetches.
 */
interface AdminData {
  asOf: string;
  users: AdminUser[];
  videos: AdminVideo[];
  orders: AdminOrder[];
  bookings: AdminBooking[];
  stats: PlatformStats;
  banUser: (id: string) => void;
  unbanUser: (id: string) => void;
  approveVideo: (id: string) => void;
  hideVideo: (id: string) => void;
  unhideVideo: (id: string) => void;
  removeVideo: (id: string) => void;
}

const AdminDataContext = createContext<AdminData | null>(null);

interface AdminDataProviderProps {
  children: ReactNode;
  /** Server-fetched rows; omit to run the self-contained mock demo. */
  initialData?: AdminInitialData;
}

export function AdminDataProvider({
  children,
  initialData,
}: AdminDataProviderProps) {
  const seeded = initialData !== undefined;
  const [users, setUsers] = useState<AdminUser[]>(
    initialData?.users ?? MOCK_USERS,
  );
  const [videos, setVideos] = useState<AdminVideo[]>(
    initialData?.videos ?? MOCK_VIDEOS,
  );
  const orders = initialData?.orders ?? MOCK_ORDERS;
  const bookings = initialData?.bookings ?? MOCK_BOOKINGS;
  const asOf = initialData?.asOf ?? DEMO_TODAY_ISO;
  const { toast } = useToast();

  const callAction = useCallback(
    (
      endpoint: AdminActionEndpoint,
      body: Record<string, string>,
      revert: () => void,
    ) => {
      if (!seeded) return; // Demo mode has no API behind it.
      void postAdminAction(endpoint, body).catch((error: unknown) => {
        revert();
        const message =
          error instanceof Error ? error.message : "request failed";
        toast("danger", `Action failed — reverted (${message})`);
      });
    },
    [seeded, toast],
  );

  const runUserAction = useCallback(
    (id: string, endpoint: "ban" | "unban", patch: Partial<AdminUser>) => {
      const previous = users.find((user) => user.id === id);
      if (!previous) return null;
      setUsers((prev) =>
        prev.map(
          (user): AdminUser => (user.id === id ? { ...user, ...patch } : user),
        ),
      );
      callAction(endpoint, { userId: id }, () =>
        setUsers((prev) =>
          prev.map((user) => (user.id === id ? previous : user)),
        ),
      );
      return previous;
    },
    [users, callAction],
  );

  const banUser = useCallback(
    (id: string) => {
      const previous = runUserAction(id, "ban", { status: "banned" });
      if (previous) {
        toast("danger", `@${previous.username} banned — sessions revoked`);
      }
    },
    [runUserAction, toast],
  );

  const unbanUser = useCallback(
    (id: string) => {
      const previous = runUserAction(id, "unban", {
        status: "active",
        flagReason: null,
      });
      if (previous) {
        toast("success", `@${previous.username} restored to active`);
      }
    },
    [runUserAction, toast],
  );

  // Status derives on the real `posts` row: removed_at → removed, hidden_at →
  // hidden, flag_reason → flagged, else live.
  const runVideoAction = useCallback(
    (id: string, endpoint: AdminActionEndpoint, patch: Partial<AdminVideo>) => {
      const previous = videos.find((video) => video.id === id);
      if (!previous) return false;
      setVideos((prev) =>
        prev.map((video) => (video.id === id ? { ...video, ...patch } : video)),
      );
      callAction(endpoint, { postId: id }, () =>
        setVideos((prev) =>
          prev.map((video) => (video.id === id ? previous : video)),
        ),
      );
      return true;
    },
    [videos, callAction],
  );

  const approveVideo = useCallback(
    (id: string) => {
      if (runVideoAction(id, "approve-post", { status: "live", flagReason: null })) {
        toast("success", "Video approved — live in the feed");
      }
    },
    [runVideoAction, toast],
  );
  const hideVideo = useCallback(
    (id: string) => {
      if (runVideoAction(id, "hide-post", { status: "hidden" })) {
        toast("info", "Video hidden from the feed");
      }
    },
    [runVideoAction, toast],
  );
  const unhideVideo = useCallback(
    (id: string) => {
      if (runVideoAction(id, "unhide-post", { status: "live", flagReason: null })) {
        toast("success", "Video restored — live in the feed");
      }
    },
    [runVideoAction, toast],
  );
  const removeVideo = useCallback(
    // remove-post sets posts.removed_at (feeds stop serving it). The R2 file
    // itself is NOT deleted yet — retention is an open product decision, and
    // the copy below must not claim otherwise.
    (id: string) => {
      if (runVideoAction(id, "remove-post", { status: "removed" })) {
        toast("danger", "Video removed from the platform (file retained pending purge policy)");
      }
    },
    [runVideoAction, toast],
  );

  const todayPrefix = asOf.slice(0, 10);

  const stats = useMemo<PlatformStats>(() => {
    const paidOrders = orders.filter((order) => order.status === "paid");
    return {
      totalUsers: users.length,
      totalCreators: users.filter((user) => user.isCreator).length,
      totalVideos: videos.length,
      gmvCents: paidOrders.reduce((sum, order) => sum + order.grossCents, 0),
      platformFeeCents: paidOrders.reduce((sum, order) => sum + order.feeCents, 0),
      purchaseCount: paidOrders.length,
      bookingCount: bookings.length,
      flaggedCount:
        videos.filter((video) => video.status === "flagged").length +
        users.filter((user) => user.status === "flagged").length,
      newUsersToday: users.filter((user) => user.joinedAt.startsWith(todayPrefix))
        .length,
      uploadsToday: videos.filter((video) =>
        video.createdAt.startsWith(todayPrefix),
      ).length,
    };
  }, [users, videos, orders, bookings, todayPrefix]);

  const value = useMemo<AdminData>(
    () => ({
      asOf,
      users,
      videos,
      orders,
      bookings,
      stats,
      banUser,
      unbanUser,
      approveVideo,
      hideVideo,
      unhideVideo,
      removeVideo,
    }),
    [
      asOf,
      users,
      videos,
      orders,
      bookings,
      stats,
      banUser,
      unbanUser,
      approveVideo,
      hideVideo,
      unhideVideo,
      removeVideo,
    ],
  );

  return (
    <AdminDataContext.Provider value={value}>
      {children}
    </AdminDataContext.Provider>
  );
}

export function useAdminData(): AdminData {
  const context = useContext(AdminDataContext);
  if (!context) {
    throw new Error("useAdminData must be used inside AdminDataProvider");
  }
  return context;
}
