// test.mjs — the whole point of the prototype: does the lock hold, and does the money come back.
// The jetton wallet is played by a treasury account, so what is under test is the HTLC itself:
// the SHA-256 hashlock, the deadline, and the two exits (claim, refund).
import { Blockchain } from '@ton/sandbox';
import { Address, Cell, beginCell, contractAddress, toNano } from '@ton/core';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';

const CODE = Cell.fromBase64(readFileSync('htlc.boc.b64', 'utf8'));
// only used to derive the wallet address the contract expects; no jetton is deployed in this test
const WALLET_CODE = Cell.fromBase64(readFileSync('jetton-wallet.boc.b64', 'utf8'));
const OP = { notify: 0x7362d09c, transfer: 0xf8a7ea5, claim: 0x636c6169, refund: 0x72656664 };

const sha256 = b => createHash('sha256').update(b).digest();
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };

// the address the contract will derive for itself under the reference layout — in this test the
// jetton wallet is not deployed at all, we simply speak as that address
const derivedWallet = (owner, master) => {
  const data = beginCell().storeCoins(0).storeAddress(owner).storeAddress(master).storeRef(WALLET_CODE).endCell();
  const si = beginCell().storeUint(0, 2).storeMaybeRef(WALLET_CODE).storeMaybeRef(data).storeUint(0, 1).endCell();
  return new Address(0, si.hash());
};
// sandbox lets us post a message from any address, which is how a deposit notice gets forged here
const speakAs = (bc, from, to, value, body) => bc.sendMessage({
  info: { type: 'internal', ihrDisabled: true, bounce: false, bounced: false, src: from, dest: to,
          value: { coins: value }, ihrFee: 0n, forwardFee: 0n, createdLt: 0n, createdAt: 0 },
  body,
});

// storage layout must match load_data() in htlc.fc
const dataCell = (hash, deadline, master, sender, recipient) => beginCell()
  .storeUint(BigInt('0x' + hash.toString('hex')), 256)
  .storeUint(deadline, 32)
  .storeUint(0, 1)                  // funded
  .storeUint(0, 1)                  // governed: this test uses the reference wallet layout
  .storeCoins(0)
  .storeRef(beginCell().storeAddress(master).storeAddress(sender).storeAddress(recipient).endCell())
  .storeRef(WALLET_CODE)
  .endCell();

const notify = (amount, from) => beginCell()
  .storeUint(OP.notify, 32).storeUint(1n, 64)
  .storeCoins(amount).storeAddress(from).storeUint(0, 1).endCell();

const claimBody = secret => beginCell()
  .storeUint(OP.claim, 32).storeUint(2n, 64).storeBuffer(secret).endCell();

const refundBody = () => beginCell().storeUint(OP.refund, 32).storeUint(3n, 64).endCell();

// exit code of the transaction that ran on `addr` (0 when it went through)
const exitOn = (res, addr) => {
  const tx = res.transactions.find(t => t.inMessage?.info?.dest?.equals(addr));
  return tx?.description?.computePhase?.exitCode ?? -1;
};
// where the outgoing jetton transfer is headed, if one was produced
const jettonDest = (res, addr) => {
  const tx = res.transactions.find(t => t.inMessage?.info?.dest?.equals(addr));
  const out = tx?.outMessages?.get(0);
  if (!out) return null;
  const s = out.body.beginParse();
  if (s.loadUint(32) !== OP.transfer) return null;
  s.loadUintBig(64); s.loadCoins();
  return s.loadAddress();
};

async function setup(deadline, now) {
  const bc = await Blockchain.create();
  bc.now = now;
  const [deployer, master, maker, taker] = await Promise.all(
    ['deployer', 'jettonMaster', 'maker', 'taker'].map(n => bc.treasury(n)));
  const secret = randomBytes(32);
  const hash = sha256(secret);
  const init = { code: CODE, data: dataCell(hash, deadline, master.address, maker.address, taker.address) };
  const addr = contractAddress(0, init);
  await deployer.send({ to: addr, value: toNano('1'), init, body: beginCell().endCell() });
  return { bc, jw: derivedWallet(addr, master.address), maker, taker, addr, secret };
}

// ---- 1. happy path: funded, then opened with the secret -----------------------------------
{
  const now = Math.floor(Date.now() / 1000);
  const { bc, jw, maker, taker, addr, secret } = await setup(now + 3600, now);

  await speakAs(bc, jw, addr, toNano('0.2'), notify(1000n, maker.address));
  const st = await bc.runGetMethod(addr, 'get_state');
  ok(st.stackReader.readNumber() === 1, 'funded flag set by transfer_notification');
  ok(st.stackReader.readBigNumber() === 1000n, 'amount recorded');

  const wrong = await taker.send({ to: addr, value: toNano('0.2'), body: claimBody(randomBytes(32)) });
  ok(exitOn(wrong, addr) === 104, 'wrong secret rejected (exit 104)');

  const good = await taker.send({ to: addr, value: toNano('0.2'), body: claimBody(secret) });
  ok(exitOn(good, addr) === 0, 'right secret accepted');
  ok(jettonDest(good, addr)?.equals(taker.address), 'jettons sent to the recipient');
}

// ---- 2. refund path: nobody ever showed the secret ----------------------------------------
{
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + 600;
  const { bc, jw, maker, addr } = await setup(deadline, now);

  await speakAs(bc, jw, addr, toNano('0.2'), notify(1000n, maker.address));
  const early = await maker.send({ to: addr, value: toNano('0.2'), body: refundBody() });
  ok(exitOn(early, addr) === 106, 'refund before the deadline rejected (exit 106)');

  bc.now = deadline + 1;
  const late = await maker.send({ to: addr, value: toNano('0.2'), body: refundBody() });
  ok(exitOn(late, addr) === 0, 'refund after the deadline goes through');
  ok(jettonDest(late, addr)?.equals(maker.address), 'jettons returned to the funder');
}

// ---- 3. the secret is worthless once the deadline has passed ------------------------------
{
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + 600;
  const { bc, jw, maker, taker, addr, secret } = await setup(deadline, now);
  await speakAs(bc, jw, addr, toNano('0.2'), notify(1000n, maker.address));
  bc.now = deadline + 1;
  const late = await taker.send({ to: addr, value: toNano('0.2'), body: claimBody(secret) });
  ok(exitOn(late, addr) === 105, 'claim after the deadline rejected (exit 105)');
}

// ---- 4. only our own jetton wallet may report a deposit ------------------------------------
{
  const now = Math.floor(Date.now() / 1000);
  const { bc, maker, taker, addr } = await setup(now + 3600, now);
  const bogus = await taker.send({ to: addr, value: toNano('0.2'), body: notify(1000n, maker.address) });
  ok(exitOn(bogus, addr) === 101, 'deposit notice from a stranger rejected (exit 101)');
}

const rescueBody = () => beginCell().storeUint(0x72657363, 32).storeUint(4n, 64).endCell();

// ---- 5. a payout must carry enough TON to reach the jetton wallet -------------------------
{
  const now = Math.floor(Date.now() / 1000);
  const { bc, jw, maker, taker, addr, secret } = await setup(now + 3600, now);
  await speakAs(bc, jw, addr, toNano('0.2'), notify(1000n, maker.address));
  const cheap = await taker.send({ to: addr, value: toNano('0.01'), body: claimBody(secret) });
  ok(exitOn(cheap, addr) === 108, 'claim with too little TON rejected (exit 108)');
}

// ---- 6. escape hatch: a month past the deadline the funder can push the jettons back -------
{
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + 600;
  const { bc, jw, maker, taker, addr, secret } = await setup(deadline, now);
  await speakAs(bc, jw, addr, toNano('0.2'), notify(1000n, maker.address));
  await taker.send({ to: addr, value: toNano('0.2'), body: claimBody(secret) });   // settles

  const early = await maker.send({ to: addr, value: toNano('0.2'), body: rescueBody() });
  ok(exitOn(early, addr) === 106, 'rescue before the grace period rejected (exit 106)');

  bc.now = deadline + 2592000 + 1;
  const late = await maker.send({ to: addr, value: toNano('0.2'), body: rescueBody() });
  ok(exitOn(late, addr) === 0, 'rescue after the grace period goes through');
  ok(jettonDest(late, addr)?.equals(maker.address), 'rescued jettons go back to the funder');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
