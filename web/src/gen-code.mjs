// bake the compiled contract into the page, so the page can only ever deploy OUR code
import { readFileSync, writeFileSync } from 'fs';
const b64 = readFileSync('htlc.boc.b64', 'utf8').trim();
writeFileSync('web/src/htlc-code.mjs', `// generated from htlc.boc.b64 — do not edit\nexport default ${JSON.stringify(b64)};\n`);
console.log('embedded', b64.length, 'base64 chars of contract code');
