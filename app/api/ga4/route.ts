import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !(session as any).accessToken) {
    return NextResponse.json({ error: "No auth" }, { status: 401 });
  }

  const token = (session as any).accessToken;
  const { searchParams } = new URL(req.url);
  const propertyId = searchParams.get("property") || "";
  const action = searchParams.get("action") || "pages";

  try {
    if (action === "accounts") {
      // List all GA4 accounts and properties
      const res = await fetch(
        "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      return NextResponse.json(data);
    }

    if (action === "pages") {
      // Top pages with sessions, engagement, ecommerce
      const res = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
            dimensions: [{ name: "pagePath" }],
            metrics: [
              { name: "sessions" },
              { name: "engagedSessions" },
              { name: "averageSessionDuration" },
              { name: "ecommercePurchases" },
              { name: "purchaseRevenue" },
            ],
            orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
            limit: 50,
          }),
        }
      );
      const data = await res.json();
      return NextResponse.json(data);
    }

    if (action === "channels") {
      const res = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
            dimensions: [{ name: "sessionDefaultChannelGroup" }],
            metrics: [
              { name: "sessions" },
              { name: "engagedSessions" },
              { name: "purchaseRevenue" },
              { name: "ecommercePurchases" },
            ],
            orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
            limit: 20,
          }),
        }
      );
      const data = await res.json();
      return NextResponse.json(data);
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
