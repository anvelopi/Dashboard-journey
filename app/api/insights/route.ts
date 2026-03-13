export const maxDuration = 60;
export const runtime = "nodejs";

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ enabled: true });
}

export async function POST() {
  return NextResponse.json({
    enabled: true,
    journey: {
      archetypes: [
        {id:"A1",name:"Test Arquetipo",icon:"🏊",desc:"Esto es un test",pct:100,color:"#00b4d8"}
      ],
      keywords_classified: [],
      pain_points: [],
      insights: {},
      content_gaps: [],
      recommendations: [],
    },
  });
}
