// mainnet.mjs — the real thing: lock POK under a hash on TON mainnet and open it with the secret.
// No jetton is deployed here; POK already exists, so the contract carries its master and its
// (governed) wallet code and derives the wallet itself.
import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { Cell, beginCell, contractAddress, toNano, Address } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const POK = Address.parse('EQBp6FAkDdHD_lLKUBI-J-Et5zQeyJlixc6f3iKHBie85Fd-');
const POK_WALLET_CODE = Cell.fromBase64(readFileSync('pok-wallet-code.b64', 'utf8'));
const HTLC_CODE = Cell.fromBase64(readFileSync('htlc.boc.b64', 'utf8'));
const OP = { transfer: 0xf8a7ea5, claim: 0x636c6169, refund: 0x72656664 };
const LOCK = 2000n * 10n ** 9n;                       // 2 000 POK, 9 decimals

const S = existsSync('state-main.json') ? JSON.parse(readFileSync('state-main.json', 'utf8')) : {};
const save = () => writeFileSync('state-main.json', JSON.stringify(S, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const raw = new TonClient({ endpoint: process.env.TON_ENDPOINT || 'https://toncenter.com/api/v2/jsonRPC' });
const retry = async (fn, tries = 8) => {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await sleep(2500 * (i + 1)); }
  }
};
const THROTTLED = new Set(['getContractState', 'runMethod', 'callGetMethod', 'getBalance']);
const client = new Proxy(raw, {
  get(t, k) {
    const v = t[k];
    if (typeof v !== 'function') return v;
    if (!THROTTLED.has(k)) return v.bind(t);
    return async (...args) => { await sleep(700); return retry(() => v.apply(t, args)); };
  },
});

const { mnemonic } = JSON.parse(readFileSync('testnet-wallet.json', 'utf8'));
const key = await mnemonicToPrivateKey(mnemonic);
const wallet = client.open(WalletContractV4.create({ workchain: 0, publicKey: key.publicKey }));
const me = wallet.address;
log('wallet', me.toString({ bounceable: false }), '| TON', Number(await client.getBalance(me)) / 1e9);

async function send(to, value, body, init) {
  const seqno = await retry(() => wallet.getSeqno());
  await retry(() => wallet.sendTransfer({
    seqno, secretKey: key.secretKey,
    messages: [internal({ to, value, body, init, bounce: !init })],
  }));
  for (let i = 0; i < 60; i++) {
    await sleep(2500);
    try { if (await retry(() => wallet.getSeqno()) > seqno) return; } catch {}
  }
  throw new Error('transfer did not confirm');
}
const get = (addr, m, stack = []) => client.runMethod(typeof addr === 'string' ? Address.parse(addr) : addr, m, stack);
async function pokBalance(owner) {
  const r = await get(POK, 'get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }]);
  const w = r.stack.readAddress();
  try { await sleep(700); return { wallet: w, balance: (await raw.runMethod(w, 'get_wallet_data')).stack.readBigNumber() }; }
  catch { return { wallet: w, balance: 0n }; }
}

const mine = await pokBalance(me);
log('our POK wallet', mine.wallet.toString(), '| balance', (mine.balance / 10n ** 9n).toString());

// ---- the lock ---------------------------------------------------------------------------------
if (!S.secret) { S.secret = randomBytes(32).toString('hex'); save(); }
if (!S.deadline) { S.deadline = Math.floor(Date.now() / 1000) + 7200; save(); }
const secret = Buffer.from(S.secret, 'hex');
const hash = createHash('sha256').update(secret).digest();
log('secret', S.secret);
log('hash  ', hash.toString('hex'));

const init = {
  code: HTLC_CODE,
  data: beginCell()
    .storeUint(BigInt('0x' + hash.toString('hex')), 256).storeUint(S.deadline, 32)
    .storeUint(0, 1).storeUint(1, 1)                    // funded = 0, governed = 1 (POK is governed)
    .storeCoins(0)
    .storeRef(beginCell().storeAddress(POK).storeAddress(me).storeAddress(me).endCell())
    .storeRef(POK_WALLET_CODE)
    .endCell(),
};
const htlc = contractAddress(0, init);
S.htlc = htlc.toString(); save();
if ((await client.getContractState(htlc)).state !== 'active') {
  log('deploying HTLC', S.htlc);
  await send(htlc, toNano('0.05'), beginCell().endCell(), init);
  for (let i = 0; i < 40 && (await client.getContractState(htlc)).state !== 'active'; i++) await sleep(3000);
}
log('htlc active');
const htlcWallet = (await get(htlc, 'get_jetton_wallet')).stack.readAddress();
const fromMaster = (await get(POK, 'get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(htlc).endCell() }])).stack.readAddress();
log('htlc POK wallet, derived by the contract:', htlcWallet.toString());
log('the same address, as POK master says    :', fromMaster.toString());
log(htlcWallet.equals(fromMaster) ? 'they agree' : 'THEY DIFFER — stop');
if (!htlcWallet.equals(fromMaster)) process.exit(1);

// ---- fund it -----------------------------------------------------------------------------------
let st = await get(htlc, 'get_state');
if (st.stack.readNumber() === 0) {
  log('locking 2 000 POK');
  await send(mine.wallet, toNano('0.2'), beginCell()
    .storeUint(OP.transfer, 32).storeUint(1n, 64).storeCoins(LOCK)
    .storeAddress(htlc).storeAddress(me).storeUint(0, 1)
    .storeCoins(toNano('0.1')).storeUint(0, 1).endCell());
  for (let i = 0; i < 40; i++) {
    await sleep(4000);
    st = await get(htlc, 'get_state');
    if (st.stack.readNumber() === 1) break;
  }
}
st = await get(htlc, 'get_state');
log('state: funded =', st.stack.readNumber(), ', amount =', (st.stack.readBigNumber() / 10n ** 9n).toString(), 'POK');

// ---- open it -------------------------------------------------------------------------------------
const before = (await pokBalance(me)).balance;
log('claiming with the secret');
await send(htlc, toNano('0.15'), beginCell()
  .storeUint(OP.claim, 32).storeUint(2n, 64).storeBuffer(secret).endCell());
for (let i = 0; i < 40; i++) {
  await sleep(4000);
  if ((await pokBalance(me)).balance > before) break;
}
log('our POK after claim :', ((await pokBalance(me)).balance / 10n ** 9n).toString());
log('htlc POK wallet     :', (await (async () => { try { return ((await raw.runMethod(htlcWallet, 'get_wallet_data')).stack.readBigNumber() / 10n ** 9n).toString(); } catch { return '0'; } })()));
log('TON left', Number(await client.getBalance(me)) / 1e9);
log('done');
