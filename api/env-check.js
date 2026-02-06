module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    hasSupabaseUrl: !!process.env.SUPABASE_URL,
    hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseUrlPrefix: process.env.SUPABASE_URL
      ? process.env.SUPABASE_URL.slice(0, 25)
      : null,
  });
};