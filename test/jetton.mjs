// test-jetton.mjs — the same swap, but against the real jetton contracts (standard minter and
// wallet from ton-blockchain/token-contract), not a stand-in. This is the run that proves the
// contract talks to an actual jetton: deposit arrives as a transfer_notification from the wallet
// the contract derived itself, and the payout really moves the balance.
import { Blockchain } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, toNano, Address } from '@ton/core';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';

const HTLC_CODE = Cell.fromBase64(readFileSync('htlc.boc.b64', 'utf8'));
const MINTER_CODE = Cell.fromBase64(readFileSync('jetton-minter.boc.b64', 'utf8'));
const WALLET_CODE = Cell.fromBase64(readFileSync('jetton-wallet.boc.b64', 'utf8'));

const OP = { mint: 21, internal: 0x178d4519, transfer: 0xf8a7ea5, claim: 0x636c6169, refund: 0x72656664 };
const sha256 = b => createHash('sha256').update(b).digest();

let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${name}`); };

const htlcData = (hash, deadline, master, sender, recipient) => beginCell()
  .storeUint(BigInt('0x' + hash.toString('hex')), 256)
  .storeUint(deadline, 32).storeUint(0, 1).storeUint(0, 1).storeCoins(0)   // funded, governed
  .storeRef(beginCell().storeAddress(master).storeAddress(sender).storeAddress(recipient).endCell())
  .storeRef(WALLET_CODE)
  .endCell();

async function walletOf(bc, minter, owner) {
  const r = await bc.runGetMethod(minter, 'get_wallet_address',
    [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }]);
  return r.stackReader.readAddress();
}
async function jettonBalance(bc, wallet) {
  try {
    const r = await bc.runGetMethod(wallet, 'get_wallet_data');
    return r.stackReader.readBigNumber();
  } catch { return 0n; }          // wallet not deployed yet == no balance
}

async function stage(deadline, now) {
  const bc = await Blockchain.create();
  bc.now = now;
  const [admin, maker, taker] = await Promise.all(['admin', 'maker', 'taker'].map(n => bc.treasury(n)));

  // the jetton itself
  const minterInit = {
    code: MINTER_CODE,
    data: beginCell().storeCoins(0).storeAddress(admin.address)
      .storeRef(beginCell().storeUint(0, 8).endCell()).storeRef(WALLET_CODE).endCell(),
  };
  const minter = contractAddress(0, minterInit);
  await admin.send({ to: minter, value: toNano('1'), init: minterInit, body: beginCell().endCell() });

  // mint 10 000 units to the maker
  const inner = beginCell().storeUint(OP.internal, 32).storeUint(0n, 64).storeCoins(10000n)
    .storeAddress(minter).storeAddress(maker.address).storeCoins(0).storeUint(0, 1).endCell();
  await admin.send({
    to: minter, value: toNano('0.5'),
    body: beginCell().storeUint(OP.mint, 32).storeUint(0n, 64)
      .storeAddress(maker.address).storeCoins(toNano('0.2')).storeRef(inner).endCell(),
  });

  const secret = randomBytes(32);
  const init = { code: HTLC_CODE, data: htlcData(sha256(secret), deadline, minter, maker.address, taker.address) };
  const htlc = contractAddress(0, init);
  await admin.send({ to: htlc, value: toNano('0.5'), init, body: beginCell().endCell() });
  return { bc, minter, maker, taker, htlc, secret };
}

// the maker pushes jettons into the HTLC; forward_ton_amount > 0 is what makes the wallet notify it
const fund = (to, amount, response) => beginCell()
  .storeUint(OP.transfer, 32).storeUint(1n, 64).storeCoins(amount)
  .storeAddress(to).storeAddress(response).storeUint(0, 1)
  .storeCoins(toNano('0.1')).storeUint(0, 1).endCell();

// ---- 1. real jetton, happy path ------------------------------------------------------------
{
  const now = Math.floor(Date.now() / 1000);
  const { bc, minter, maker, taker, htlc, secret } = await stage(now + 3600, now);

  const makerW = await walletOf(bc, minter, maker.address);
  const takerW = await walletOf(bc, minter, taker.address);
  ok(await jettonBalance(bc, makerW) === 10000n, 'maker holds the minted jettons');

  // the address the contract derived for itself must be the one the minter agrees on
  const derived = (await bc.runGetMethod(htlc, 'get_jetton_wallet')).stackReader.readAddress();
  const expected = await walletOf(bc, minter, htlc);
  ok(derived.equals(expected), 'contract derives its own jetton wallet correctly');

  await maker.send({ to: makerW, value: toNano('0.5'), body: fund(htlc, 4000n, maker.address) });
  const st = await bc.runGetMethod(htlc, 'get_state');
  ok(st.stackReader.readNumber() === 1, 'deposit registered from the real jetton wallet');
  ok(st.stackReader.readBigNumber() === 4000n, 'deposited amount recorded');

  await taker.send({
    to: htlc, value: toNano('0.3'),
    body: beginCell().storeUint(OP.claim, 32).storeUint(2n, 64).storeBuffer(secret).endCell(),
  });
  ok(await jettonBalance(bc, takerW) === 4000n, 'taker received the jettons after revealing the secret');
  ok(await jettonBalance(bc, makerW) === 6000n, 'maker is out exactly what was locked');
}

// ---- 2. real jetton, refund path -------------------------------------------------------------
{
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + 600;
  const { bc, minter, maker, htlc } = await stage(deadline, now);
  const makerW = await walletOf(bc, minter, maker.address);

  await maker.send({ to: makerW, value: toNano('0.5'), body: fund(htlc, 4000n, maker.address) });
  ok(await jettonBalance(bc, makerW) === 6000n, 'jettons left the maker while the deal was open');

  bc.now = deadline + 1;
  await maker.send({
    to: htlc, value: toNano('0.3'),
    body: beginCell().storeUint(OP.refund, 32).storeUint(3n, 64).endCell(),
  });
  ok(await jettonBalance(bc, makerW) === 10000n, 'timeout returned every unit to the maker');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
