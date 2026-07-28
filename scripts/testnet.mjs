// testnet.mjs — the same run as the sandbox, but on a chain we do not control: deploy a jetton,
// mint it, lock it under a hash, then open the lock with the secret. State is kept in state.json
// so a rate-limited run can be resumed instead of restarted.
import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { Cell, beginCell, contractAddress, toNano, Address } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';

import { getHttpEndpoint } from '@orbs-network/ton-access';
const ENDPOINT = process.env.TON_ENDPOINT || await getHttpEndpoint({ network: 'testnet' });
const HTLC_CODE = Cell.fromBase64(readFileSync('htlc.boc.b64', 'utf8'));
const MINTER_CODE = Cell.fromBase64(readFileSync('jetton-minter.boc.b64', 'utf8'));
const WALLET_CODE = Cell.fromBase64(readFileSync('jetton-wallet.boc.b64', 'utf8'));
const OP = { mint: 21, internal: 0x178d4519, transfer: 0xf8a7ea5, claim: 0x636c6169, refund: 0x72656664 };

const S = existsSync('state.json') ? JSON.parse(readFileSync('state.json', 'utf8')) : {};
const save = () => writeFileSync('state.json', JSON.stringify(S, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// the free tier allows about one request a second; every call goes through here
console.log('endpoint', ENDPOINT);
const raw = new TonClient({ endpoint: ENDPOINT });
// public nodes answer 429 when pushed; back off and try again rather than dying mid-swap
const retry = async (fn, tries = 8) => {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      // public endpoints load-balance across nodes and some of them lag: a get method can come
      // back with exit_code -13 ("no such account") on an account that plainly exists. Retry.
      if (i >= tries) throw e;
      await sleep(2500 * (i + 1));
    }
  }
};
const THROTTLED = new Set(['getContractState', 'runMethod', 'callGetMethod', 'getBalance', 'isContractDeployed']);
const client = new Proxy(raw, {
  get(t, k) {
    const v = t[k];
    if (typeof v !== 'function') return typeof v === 'object' && v !== null ? v : v;
    if (!THROTTLED.has(k)) return v.bind(t);
    return async (...args) => { await sleep(600); return retry(() => v.apply(t, args)); };
  },
});
process.on('unhandledRejection', e => { console.error('ERR', e?.message?.slice(0, 300) ?? e); process.exit(1); });
const { mnemonic } = JSON.parse(readFileSync('testnet-wallet.json', 'utf8'));
const key = await mnemonicToPrivateKey(mnemonic);
const wallet = client.open(WalletContractV4.create({ workchain: 0, publicKey: key.publicKey }));
const me = wallet.address;
log('wallet', me.toString({ testOnly: true, bounceable: false }));

// one message at a time, waiting for the seqno to move — simple and enough for a trial
async function send(to, value, body, init) {
  const seqno = await retry(() => wallet.getSeqno());
  await retry(() => wallet.sendTransfer({
    seqno, secretKey: key.secretKey,
    messages: [internal({ to, value, body, init, bounce: !!init ? false : true })],
  }));
  for (let i = 0; i < 60; i++) {
    await sleep(2500);
    try { if (await retry(() => wallet.getSeqno()) > seqno) return; } catch {}
  }
  throw new Error('transfer did not confirm');
}
async function deployed(addr) {
  const s = await client.getContractState(Address.parse(addr));
  return s.state === 'active';
}
async function waitActive(addr, what) {
  for (let i = 0; i < 60; i++) {
    if (await deployed(addr)) { log(what, 'active'); return; }
    await sleep(3000);
  }
  throw new Error(what + ' never went active');
}
async function get(addr, method, stack = []) {
  return client.runMethod(Address.parse(addr), method, stack);
}
async function walletOf(minter, owner) {
  const r = await get(minter, 'get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }]);
  return r.stack.readAddress();
}
// no retry here on purpose: "not deployed yet" is the normal answer while we wait for a mint
async function jettonBalance(addr) {
  try { await sleep(600); return (await raw.runMethod(Address.parse(addr), 'get_wallet_data')).stack.readBigNumber(); }
  catch { return 0n; }
}

// ---- 1. the jetton ---------------------------------------------------------------------------
const minterInit = {
  code: MINTER_CODE,
  data: beginCell().storeCoins(0).storeAddress(me)
    .storeRef(beginCell().storeUint(0, 8).endCell()).storeRef(WALLET_CODE).endCell(),
};
const minter = contractAddress(0, minterInit);
S.minter = minter.toString({ testOnly: true }); save();
if (!await deployed(S.minter)) {
  log('deploying jetton minter', S.minter);
  await send(minter, toNano('0.15'), beginCell().endCell(), minterInit);
  await waitActive(S.minter, 'minter');
} else log('minter already deployed', S.minter);

// ---- 2. mint to ourselves ---------------------------------------------------------------------
const myJetton = await walletOf(S.minter, me);
log('our jetton wallet', myJetton.toString({ testOnly: true }));
if (await jettonBalance(myJetton.toString()) === 0n) {
  log('minting 10 000 units');
  const inner = beginCell().storeUint(OP.internal, 32).storeUint(0n, 64).storeCoins(10000n)
    .storeAddress(minter).storeAddress(me).storeCoins(0).storeUint(0, 1).endCell();
  await send(minter, toNano('0.25'), beginCell().storeUint(OP.mint, 32).storeUint(0n, 64)
    .storeAddress(me).storeCoins(toNano('0.1')).storeRef(inner).endCell());
  for (let i = 0; i < 40 && await jettonBalance(myJetton.toString()) === 0n; i++) await sleep(3000);
}
log('jetton balance', (await jettonBalance(myJetton.toString())).toString());

// ---- 3. the lock -------------------------------------------------------------------------------
if (!S.secret) { S.secret = randomBytes(32).toString('hex'); save(); }
const secret = Buffer.from(S.secret, 'hex');
const hash = createHash('sha256').update(secret).digest();
if (!S.deadline) { S.deadline = Math.floor(Date.now() / 1000) + 3600; save(); }
log('secret', S.secret);
log('hash  ', hash.toString('hex'), '(this is what the Freicoin script locks against too)');

const htlcInit = {
  code: HTLC_CODE,
  data: beginCell().storeUint(BigInt('0x' + hash.toString('hex')), 256).storeUint(S.deadline, 32)
    .storeUint(0, 1).storeCoins(0)
    .storeRef(beginCell().storeAddress(minter).storeAddress(me).storeAddress(me).endCell())
    .storeRef(WALLET_CODE).endCell(),
};
const htlc = contractAddress(0, htlcInit);
S.htlc = htlc.toString({ testOnly: true }); save();
if (!await deployed(S.htlc)) {
  log('deploying HTLC', S.htlc);
  await send(htlc, toNano('0.2'), beginCell().endCell(), htlcInit);
  await waitActive(S.htlc, 'htlc');
} else log('htlc already deployed', S.htlc);

const htlcJetton = (await get(S.htlc, 'get_jetton_wallet')).stack.readAddress();
log('htlc jetton wallet (derived on-chain)', htlcJetton.toString({ testOnly: true }));

// ---- 4. fund it ---------------------------------------------------------------------------------
const before = await jettonBalance(htlcJetton.toString());
if (before === 0n) {
  log('locking 4 000 units under the hash');
  await send(myJetton, toNano('0.35'), beginCell()
    .storeUint(OP.transfer, 32).storeUint(1n, 64).storeCoins(4000n)
    .storeAddress(htlc).storeAddress(me).storeUint(0, 1)
    .storeCoins(toNano('0.1')).storeUint(0, 1).endCell());
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const st = await get(S.htlc, 'get_state');
    if (st.stack.readNumber() === 1) break;
  }
}
{
  const st = await get(S.htlc, 'get_state');
  log('state: funded =', st.stack.readNumber(), ', amount =', st.stack.readBigNumber().toString());
}

// ---- 5. open it with the secret ------------------------------------------------------------------
const mineBefore = await jettonBalance(myJetton.toString());
log('claiming with the secret');
await send(htlc, toNano('0.3'), beginCell()
  .storeUint(OP.claim, 32).storeUint(2n, 64).storeBuffer(secret).endCell());
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  if (await jettonBalance(myJetton.toString()) > mineBefore) break;
}
log('jetton balance after claim', (await jettonBalance(myJetton.toString())).toString());
log('htlc wallet balance       ', (await jettonBalance(htlcJetton.toString())).toString());
log('done');
