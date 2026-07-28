// The token-contract repo has no #include lines — its build concatenates the sources in order.
import { compileFunc } from '@ton-community/func-js';
import { readFileSync, writeFileSync } from 'fs';
const base = ['contracts/stdlib.fc', 'contracts/jetton/compat.fc', 'contracts/jetton/op-codes.fc', 'contracts/jetton/params.fc', 'contracts/jetton/jetton-utils.fc'];
for (const [name, last] of [['minter', 'jetton-minter.fc'], ['wallet', 'jetton-wallet.fc']]) {
  const r = await compileFunc({ targets: [...base, 'contracts/jetton/' + last], sources: p => readFileSync(p, 'utf8') });
  if (r.status === 'error') { console.error(name, r.message.slice(0, 400)); process.exit(1); }
  writeFileSync(`jetton-${name}.boc.b64`, r.codeBoc);
  console.log('compiled', name, r.codeBoc.length);
}
