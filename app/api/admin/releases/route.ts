import { NextRequest } from "next/server";
import { releaseManagement } from "@/lib/release/management";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => releaseManagement(req);
export const PATCH = (req: NextRequest) => releaseManagement(req);
