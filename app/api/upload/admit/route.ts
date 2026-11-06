import { NextRequest } from "next/server";
import { admitUpload } from "@/lib/uploadTrackingHttp";
export async function POST(req: NextRequest) { return admitUpload(req); }
