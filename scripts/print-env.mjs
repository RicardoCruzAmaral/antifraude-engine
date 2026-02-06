import fs from "node:fs";

// força carregar .env.local explicitamente
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

console.log("SUPABASE_URL:", process.env.SUPABASE_URL ? "OK" : "MISSING");
console.log("SERVICE_ROLE:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "OK" : "MISSING");

// só pra confirmar que ele enxerga o arquivo
console.log("ENV FILE EXISTS:", fs.existsSync(".env.local"));