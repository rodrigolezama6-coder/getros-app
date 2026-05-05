// api/keep-alive.js
// Vercel cron job that pings Supabase every 3 days to prevent the project
// from being paused due to inactivity (free tier auto-pauses after 7 days).
// Triggered by the cron config in vercel.json: 0 0 */3 * *

export default async function handler(req, res) {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SB_URL || !SB_ANON_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables',
    });
  }

  try {
    // Simple SELECT against the profiles table to keep the project active
    const resp = await fetch(`${SB_URL}/rest/v1/profiles?select=id&limit=1`, {
      headers: {
        'apikey': SB_ANON_KEY,
        'Authorization': `Bearer ${SB_ANON_KEY}`,
      },
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return res.status(500).json({
        ok: false,
        error: 'Supabase query failed',
        status: resp.status,
        detail,
      });
    }

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: 'Error connecting to Supabase',
      detail: e.message,
    });
  }
}
