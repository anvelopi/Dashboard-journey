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
  const siteUrl = searchParams.get("site") || "";
  const action = searchParams.get("action") || "keywords";

  try {
    if (action === "sites") {
      // List all GSC properties
      const res = await fetch(
        "https://www.googleapis.com/webmasters/v3/sites",
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      return NextResponse.json(data);
    }

    if (action === "keywords") {
      // Get top keywords by impressions
      const res = await fetch(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            startDate: getDateNDaysAgo(28),
            endDate: getDateNDaysAgo(1),
            dimensions: ["query"],
            rowLimit: 500,
            dataState: "final",
          }),
        }
      );
      const data = await res.json();
      return NextResponse.json(data);
    }

    if (action === "pages") {
      const res = await fetch(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            startDate: getDateNDaysAgo(28),
            endDate: getDateNDaysAgo(1),
            dimensions: ["page"],
            rowLimit: 100,
            dataState: "final",
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

function getDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}
