import { NextResponse } from "next/server";
import { getNetworkProxyStatus } from "@/lib/network-proxy";

// Returns only source and health metadata. Proxy addresses and credentials are
// intentionally never exposed through the browser API.
export async function GET() {
  return NextResponse.json(getNetworkProxyStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
