import fs from "node:fs";

const url = "http://localhost:3000/api/analyze";

// Uso:
// node scripts/test-analyze.mjs
// node scripts/test-analyze.mjs body.json
const file = process.argv[2];

let payload;
if (file) {
  payload = JSON.parse(fs.readFileSync(file, "utf8"));
} else {
  // default
  payload = {
    cpf: "12345678900",
    nome: "Joao da Silva",
    valor: 1200,
    produto: "Seguro Vida",
  };
}

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

console.log("HTTP", res.status);
console.log(await res.text());