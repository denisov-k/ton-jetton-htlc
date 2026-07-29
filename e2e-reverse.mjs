// e2e-reverse.mjs — the reverse swap driven headlessly: a visitor gives regtest FRC and receives
// testnet jettons, against the live daemon. The visitor here plays both wallets it would really
// use — an FRC key (to fund the lock) and a TON wallet (to claim the jettons).
import { Address, Cell, beginCell, toNano } from '@ton/core';
import { readFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { execFileSync } from 'node:child_process';
import { tonClient, tonWallet, tonLock, tonState, tonClaim, jetton } from './driver/ton-leg.mjs';
import { frcNode, frcLock, frcFund } from './driver/frc-leg.mjs';
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';

const api = (m, body) => fetch(`http://127.0.0.1:5187/api/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  .then(async r => { const j = await r.json(); if (j.error) throw new Error(j.error); return j; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sha256hex = b => createHash('sha256').update(b).digest('hex');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const HTLC_CODE = Cell.fromBase64(readFileSync('htlc.boc.b64', 'utf8'));
const node = frcNode({ bin: '/root/fcbuild-31/bin/freicoin-cli', args: ['-regtest', '-datadir=/root/fw-bdev', '-rpcport=19560'] });
const guestKey = createHash('sha256').update('reverse-guest-frc').digest('hex');
const guestPub = pubkeyCompressed(guestKey);

const client = await tonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC' });
const guestTon = await tonWallet(client, 'testnet-wallet2.json');       // receives the jettons
const j = await jetton(client, Address.parse('kQCiLz4t3680hW0BZm6r4vcF_6fu4Mh9fYmQLkmId5Z_d0JT'));

const before = await j.balanceOf(guestTon.address);
log('guest jetton balance before:', before.toString());

// 1. the visitor asks for jettons, offering FRC; secret is theirs
const secret = randomBytes(32).toString('hex');
const hash = sha256hex(Buffer.from(secret, 'hex'));
const o = await api('offerReverse', { jettons: '800', hash, frcRefundPub: guestPub, tonRecipient: guestTon.address.toString() });
log('offer:', JSON.stringify(o));
ok(o.frcClaimPub && o.frcAddress, 'daemon returned its claim key and the FRC lock address');

// 2. the visitor funds the FRC lock the daemon named (claim = daemon, refund = guest, short cltv)
const lock = frcLock({ paymentHash: hash, claimPub: o.frcClaimPub, refundPub: guestPub, cltv: o.frcCltv, net: 'regtest' });
ok(lock.address === o.frcAddress, 'our own computation of the lock address agrees with the daemon');
const funding = frcFund({ node, key: guestKey, lock, amount: BigInt(o.frcAmount), fee: 50000n, net: 'regtest', maturity: 1 });
node.cli('generatetoaddress', '1', node.cli('getnewaddress'));
log('FRC locked by the visitor:', funding.txid);

// 3. the daemon should verify it and lock jettons for the visitor
let st;
for (let i = 0; i < 40; i++) { st = await api('statusReverse', { id: o.id }); if (st.state === 'jettons-locked') break; await sleep(6000); }
ok(st.state === 'jettons-locked', 'daemon verified the FRC lock and locked jettons');

// 4. the visitor claims the jettons — revealing the secret on TON
const tl = tonLock({ codeCell: HTLC_CODE, paymentHash: hash, deadline: st.tonDeadline ?? o.tonDeadline,
  master: Address.parse('kQCiLz4t3680hW0BZm6r4vcF_6fu4Mh9fYmQLkmId5Z_d0JT'), walletCode: j.walletCode,
  governed: false, sender: Address.parse(o.tonSender), recipient: guestTon.address });
log('claiming the jettons with the secret');
await tonClaim(guestTon, tl, secret, '0.15');
for (let i = 0; i < 40; i++) { if (await j.balanceOf(guestTon.address) > before) break; await sleep(6000); }
ok(await j.balanceOf(guestTon.address) >= before + 800n, 'visitor received the jettons');

// 5. the daemon reads the secret off TON and claims the FRC
node.cli('generatetoaddress', '1', node.cli('getnewaddress'));
for (let i = 0; i < 40; i++) { st = await api('statusReverse', { id: o.id }); if (st.state === 'done') break; node.cli('generatetoaddress', '1', node.cli('getnewaddress')); await sleep(6000); }
ok(st.state === 'done', 'daemon recovered the secret and claimed the FRC');
ok(st.frcClaimTxid && !!node.outAt(st.frcClaimTxid, 0), 'the FRC claim landed on chain');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
