import { compileFunc } from '@ton-community/func-js';
import { readFileSync, writeFileSync } from 'fs';
const r = await compileFunc({
  targets: ['contracts/stdlib.fc', 'contracts/jetton/compat.fc', 'contracts/jetton/params.fc',
            'contracts/jetton/op-codes.fc', 'contracts/jetton/jetton-utils.fc', 'contracts/htlc.fc'],
  sources: p => readFileSync(p, 'utf8'),
});
if (r.status === 'error') { console.error(r.message.slice(0, 600)); process.exit(1); }
writeFileSync('htlc.boc.b64', r.codeBoc);
console.log('OK, code cell base64 length', r.codeBoc.length);
