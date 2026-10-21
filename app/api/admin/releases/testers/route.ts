import { NextRequest } from "next/server";
import { releaseManagement } from "@/lib/release/management";
export const dynamic = "force-dynamic";
export const POST = (req: NextRequest) => releaseManagement(req, true);
