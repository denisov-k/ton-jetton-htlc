// e2e-page.mjs — the page's exact logic, driven headlessly: a visitor with wallet2 swaps testnet
// jettons for regtest FRC against the live daemon. Everything the page does, this does — same
// verification, same claim building — minus the DOM.
import { Address, Cell, beginCell, contractAddress, toNano } from '@ton/core';
import { readFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { execFileSync } from 'node:child_process';
import { tonClient, tonWallet, jetton, OP } from './driver/ton-leg.mjs';
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';
import { parseTx, txid as txidOf } from '/root/free-money/freicoin-wallet/core/tx.mjs';
import { decodeWitness } from '/root/free-money/freicoin-wallet/core/address.mjs';
import { htlcLeaf, htlcSpk, htlcClaim, paymentHashOf } from '/root/free-money/freicoin-wallet/core/htlc.mjs';

const api = (m, body) => fetch(`http://127.0.0.1:5187/api/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  .then(async r => { const j = await r.json(); if (j.error) throw new Error(j.error); return j; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const HTLC_CODE_B64 = readFileSync('htlc.boc.b64', 'utf8').trim();
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const quote = await api('quote');
log('quote:', JSON.stringify(quote));

// the visitor: wallet2 on TON, an FRC payout address of their choosing
const client = await tonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC' });
const me = await tonWallet(client, 'testnet-wallet2.json');
const j = await jetton(client, Address.parse(quote.master));
const CLI = ['/root/fcbuild-31/bin/freicoin-cli', '-regtest', '-datadir=/root/fw-bdev', '-rpcport=19560'];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const payout = cli('getnewaddress');

const secret = randomBytes(32).toString('hex');
const claimKey = randomBytes(32).toString('hex');
const meAddr = me.address.toString({ bounceable: false, testOnly: true });
const o = await api('offer', { jettons: '1200', hash: paymentHashOf(secret),
  claimPub: pubkeyCompressed(claimKey), frcPayout: payout, tonGiver: meAddr });
log('offer accepted:', JSON.stringify(o));
ok(BigInt(o.frcAmount) === 1200n * BigInt(quote.rate), 'the FRC amount follows the quoted rate');

// lock the jettons exactly as the page instructs the wallet to
const data = beginCell()
  .storeUint(BigInt('0x' + paymentHashOf(secret)), 256).storeUint(o.tonDeadline, 32)
  .storeUint(0, 1).storeUint(quote.governed ? 1 : 0, 1).storeCoins(0)
  .storeRef(beginCell().storeAddress(Address.parse(quote.master)).storeAddress(me.address).storeAddress(Address.parse(o.tonTaker)).endCell())
  .storeRef(j.walletCode).endCell();
const init = { code: Cell.fromBase64(HTLC_CODE_B64), data };
const htlc = contractAddress(0, init);
log('locking 1200 units in', htlc.toString());
await me.send(htlc, toNano('0.04'), beginCell().endCell(), init);
const myJw = await j.walletOf(me.address);
await me.send(myJw, toNano('0.13'), beginCell()
  .storeUint(OP.transfer, 32).storeUint(1n, 64).storeCoins(1200n)
  .storeAddress(htlc).storeAddress(me.address).storeUint(0, 1)
  .storeCoins(toNano('0.05')).storeUint(0, 1).endCell());

// wait for the daemon to see it and lock FRC
let st;
for (let i = 0; i < 60; i++) {
  st = await api('status', { id: o.id });
  if (st.state === 'frc-locked') break;
  await sleep(6000);
}
ok(st.state === 'frc-locked', 'daemon verified the jetton lock and locked FRC');

// verify the FRC lock the way the page does: from raw bytes, not from claims
const leaf = htlcLeaf({ paymentHash: paymentHashOf(secret), claimPub: pubkeyCompressed(claimKey),
  refundPub: st.frcLock.refundPub, cltv: st.frcLock.cltv });
const tx = parseTx(st.frcRawTx);
ok(tx.vout[0].scriptPubKey === htlcSpk(leaf), 'lock script matches what we computed ourselves');
ok(BigInt(tx.vout[0].value) >= BigInt(o.frcAmount), 'locked value covers the promised amount');
ok(txidOf(tx) === st.frcLock.txid, 'reported txid matches the bytes');

// claim: payout to the visitor's own address, signed with the ephemeral key
const dec = decodeWitness(payout);
const spk = '00' + (dec.programHex.length / 2).toString(16).padStart(2, '0') + dec.programHex;
const claim = htlcClaim({ prevTxid: st.frcLock.txid, vout: 0, value: BigInt(tx.vout[0].value),
  refheight: st.frcLock.refheight, leafHex: leaf, preimage: secret, claimKey, toSpk: spk, fee: 50000n });
const r = await api('claim', { id: o.id, rawtx: claim.rawtx });
log('claim broadcast', r.txid);
cli('generatetoaddress', '1', cli('getnewaddress'));

// the daemon should now dig the preimage out of our chain and take the jettons
for (let i = 0; i < 60; i++) {
  st = await api('status', { id: o.id });
  if (st.state === 'done') break;
  await sleep(6000);
}
ok(st.state === 'done', 'daemon recovered the secret and claimed the jettons');
const got = cli('gettxout', r.txid, '0');
ok(!!got, 'the FRC payout output exists on chain');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
