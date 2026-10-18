// SPDX-License-Identifier: GPL-3.0-or-later
// POST /api/examples: labelled category examples (lib/examples.ts), for a
// signed-in member of the household. Scrubbed here, then saved with the
// person's own session through fulla_category_examples_save, so the database
// checks membership; this server holds no key of its own for it.
import { NextResponse } from "next/server";
import { readExamples } from "@/lib/server/examples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!/^Bearer \S+$/.test(auth)) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (!url || !anon) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  const read = readExamples(body);
  if (!read) return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  if (read.examples.length === 0) return NextResponse.json({ saved: 0 });
  const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/fulla_category_examples_save`, {
    method: "POST",
    headers: { apikey: anon, authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ p_household_id: read.householdId, p_examples: read.examples }),
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (!res.ok) return NextResponse.json({ error: "not_saved" }, { status: 502 });
  const saved = ((await res.json()) as { saved?: number }).saved ?? 0;
  return NextResponse.json({ saved }, { headers: { "cache-control": "no-store" } });
}
