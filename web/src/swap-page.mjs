import './shim.mjs';
// swap-page.mjs — the whole visitor side of a POK→FRC swap in one page. The visitor brings a
// Tonkeeper with jettons and an FRC address to be paid at; everything else happens here:
// the secret and the ephemeral claim key are born in this browser and never leave it, the jetton
// lock is signed by the visitor's own wallet, and the FRC claim is signed here with the ephemeral
// key. The daemon on the other end is the counterparty, not a custodian — before the claim is
// signed, its FRC lock is re-verified byte for byte from the raw transaction.
//
// The deal survives a reload: everything needed to finish lives in localStorage under the swap id.
import { Address, Cell, beginCell, contractAddress, toNano } from '@ton/core';
import { TonConnectUI } from '@tonconnect/ui';
import HTLC_CODE_B64 from './htlc-code.mjs';
// the wallet's own primitives, bundled in: pure JS, no node dependencies
import { pubkeyCompressed } from '/root/free-money/freicoin-wallet/core/ecdsa.mjs';
import { parseTx, txid as txidOf } from '/root/free-money/freicoin-wallet/core/tx.mjs';
import { decodeWitness } from '/root/free-money/freicoin-wallet/core/address.mjs';
import { htlcLeaf, htlcSpk, htlcClaim, paymentHashOf } from '/root/free-money/freicoin-wallet/core/htlc.mjs';

const API = '/api-ton';
const api = (m, body) => fetch(`${API}/api/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  .then(async r => { const j = await r.json(); if (j.error) throw new Error(j.error); return j; });
const $ = id => document.getElementById(id);
const show = (id, t) => { const e = $(id); if (e) e.textContent = t; };
const step = n => { for (let i = 1; i <= 4; i++) $('s' + i).classList.toggle('on', i <= n); };
const hex = a => [...a].map(b => b.toString(16).padStart(2, '0')).join('');
const rand32 = () => hex(crypto.getRandomValues(new Uint8Array(32)));

const S_KEY = 'tonswap_active';
const saved = () => { try { return JSON.parse(localStorage.getItem(S_KEY) || 'null'); } catch { return null; } };
const save = s => localStorage.setItem(S_KEY, JSON.stringify(s));
const OP = { transfer: 0xf8a7ea5, refund: 0x72656664 };

const TERMINAL = new Set(['claimed', 'done', 'expired', 'refunded']);
let quote, ui, deal = (() => { const d = saved(); if (d && TERMINAL.has(d.phase)) { localStorage.removeItem(S_KEY); return null; } return d; })();

function fmtJ(v) { return (Number(v) / 10 ** quote.decimals).toLocaleString('ru-RU'); }
function fmtFrc(v) { return (Number(v) / 1e8).toLocaleString('ru-RU', { maximumFractionDigits: 8 }); }

// the same derivation the daemon and the contract use — nothing here is taken from the server
function tonLockAddress(walletCode) {
  const data = beginCell()
    .storeUint(BigInt('0x' + deal.hash), 256).storeUint(deal.tonDeadline, 32)
    .storeUint(0, 1).storeUint(quote.governed ? 1 : 0, 1).storeCoins(0)
    .storeRef(beginCell().storeAddress(Address.parse(quote.master)).storeAddress(Address.parse(deal.tonGiver)).storeAddress(Address.parse(deal.tonTaker)).endCell())
    .storeRef(walletCode).endCell();
  return { init: { code: Cell.fromBase64(HTLC_CODE_B64), data }, address: null };
}

async function jettonFacts() {
  const base = quote.chain === 'testnet' ? 'https://testnet.toncenter.com/api/v2' : 'https://toncenter.com/api/v2';
  const r = await fetch(`${base}/runGetMethod`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: quote.master, method: 'get_jetton_data', stack: [] }) }).then(x => x.json());
  if (!r.ok) throw new Error('жетон не читается: ' + JSON.stringify(r.error).slice(0, 100));
  return Cell.fromBase64(r.result.stack[4][1].bytes);
}
const jwData = (owner, master, code) => quote.governed
  ? beginCell().storeUint(0, 4).storeCoins(0).storeAddress(owner).storeAddress(master).endCell()
  : beginCell().storeCoins(0).storeAddress(owner).storeAddress(master).storeRef(code).endCell();
const jwOf = (owner, master, code) => {
  const si = beginCell().storeUint(0, 2).storeMaybeRef(code).storeMaybeRef(jwData(owner, master, code)).storeUint(0, 1).endCell();
  return new Address(0, si.hash());
};

// ---- step 1: the form --------------------------------------------------------------------------
async function start() {
  quote = await api('quote');
  const perToken = quote.rate * 10 ** quote.decimals / 1e8;   // FRC per one whole jetton
  show('rate', `1 ${quote.symbol} ≈ ${perToken.toLocaleString('ru-RU', { maximumFractionDigits: 6 })} FRC · лимиты ${fmtJ(quote.minJettons)}–${fmtJ(quote.maxJettons)} ${quote.symbol}`);
  try { ui = new TonConnectUI({ manifestUrl: 'https://freicoin.ru/swap/tonconnect-manifest.json', buttonRootId: 'connect' }); }
  catch (e) { show('status', 'кошелёк не инициализировался: ' + e.message + ' — обнови страницу'); return; }
  $('jettons').oninput = () => {
    const raw = BigInt(Math.round(Number($('jettons').value || 0) * 10 ** quote.decimals));
    show('frcOut', raw > 0n ? `≈ ${fmtFrc(Number(raw) * quote.rate)} FRC` : '');
  };
  $('go').onclick = begin;
  if (deal) resume(); else lockForm(false, 'Обменять');
}

async function begin() {
  try {
    if (!ui.account) return show('status', 'сначала подключи кошелёк — кнопка выше');
    const jettons = BigInt(Math.round(Number($('jettons').value || 0) * 10 ** quote.decimals));
    const payout = $('payout').value.trim();
    try { decodeWitness(payout); } catch { return show('status', 'FRC-адрес не читается — скопируй его из кошелька на freicoin.ru'); }
    const secret = rand32();
    const claimKey = rand32();
    const me = Address.parse(ui.account.address).toString({ bounceable: false, testOnly: quote.chain === 'testnet' });
    const o = await api('offer', { jettons: String(jettons), hash: paymentHashOf(secret),
      claimPub: pubkeyCompressed(claimKey), frcPayout: payout, tonGiver: me });
    deal = { id: o.id, secret, claimKey, hash: paymentHashOf(secret), jettons: String(jettons),
      frcAmount: o.frcAmount, payout, tonGiver: me, tonTaker: o.tonTaker, tonDeadline: o.tonDeadline, phase: 'lock' };
    save(deal);
    await lockJettons();
  } catch (e) { show('status', 'не вышло: ' + e.message); }
}

// ---- step 2: lock the jettons with the visitor's own wallet ------------------------------------
async function lockJettons() {
  step(2);
  lockForm(true, 'запираем токены…');
  show('status', 'считаем контракт…');
  const walletCode = await jettonFacts();
  const { init } = tonLockAddress(walletCode);
  const htlc = contractAddress(0, init);
  show('status', `запираем ${fmtJ(deal.jettons)} ${quote.symbol} в ${htlc.toString()} — подтверди в кошельке`);
  const me = Address.parse(deal.tonGiver);
  const transfer = beginCell()
    .storeUint(OP.transfer, 32).storeUint(1n, 64).storeCoins(BigInt(deal.jettons))
    .storeAddress(htlc).storeAddress(me).storeUint(0, 1)
    .storeCoins(toNano('0.05')).storeUint(0, 1).endCell();
  await ui.sendTransaction({
    validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [
      { address: htlc.toString(), amount: toNano('0.04').toString(),
        stateInit: beginCell().storeUint(6, 5).storeRef(init.code).storeRef(init.data).endCell().toBoc().toString('base64') },
      { address: jwOf(me, Address.parse(quote.master), walletCode).toString(), amount: toNano('0.13').toString(),
        payload: transfer.toBoc().toString('base64') },
    ],
  });
  deal.phase = 'wait-frc'; deal.tonAddress = htlc.toString(); save(deal);
  poll();
}

// ---- step 3: wait for the daemon's FRC lock, verify it, claim ----------------------------------
async function poll() {
  step(3);
  lockForm(true, 'сделка идёт…');
  show('status', 'Токены заперты. Ждём, пока вторая сторона запрёт FRC (это один блок Freicoin — до 20–30 минут)…');
  for (;;) {
    let st;
    try { st = await api('status', { id: deal.id }); } catch { await sleep(7000); continue; }
    if (st.state === 'frc-locked' && st.frcRawTx) {
      if ((st.frcConfirmations ?? 0) >= 1) return claimFrc(st);
      show('status', `FRC заперты в цепи и ждут подтверждения — блок скоро закроется. Забираем автоматически, как только он придёт.`);
    }
    if (st.state === 'claimed' || st.state === 'done') return finish(st);
    if (st.state === 'expired') return show('status', 'срок вышел, сделка не состоялась. Токены вернутся по таймауту — кнопка возврата появится после срока.');
    await sleep(7000);
  }
}

async function claimFrc(st) {
  // trust nothing: rebuild the lock we expect and check the daemon's transaction against it
  const leaf = htlcLeaf({ paymentHash: deal.hash, claimPub: pubkeyCompressed(deal.claimKey),
    refundPub: st.frcLock.refundPub, cltv: st.frcLock.cltv });
  const tx = parseTx(st.frcRawTx);
  const out = tx.vout[0];
  if (out.scriptPubKey !== htlcSpk(leaf)) return show('status', 'FRC-замок не совпал с расчётным — стоп, ничего не подписываем');
  if (BigInt(out.value) < BigInt(deal.frcAmount)) return show('status', `в замке ${fmtFrc(out.value)} FRC вместо ${fmtFrc(deal.frcAmount)} — стоп`);
  const realTxid = txidOf(tx);
  if (realTxid !== st.frcLock.txid) return show('status', 'txid замка не сходится с байтами — стоп');
  show('status', `FRC заперты (${fmtFrc(out.value)} FRC, транзакция ${realTxid.slice(0, 16)}…). Забираем на ${deal.payout}…`);

  const dec = decodeWitness(deal.payout);
  const payoutSpk = '00' + (dec.programHex.length / 2).toString(16).padStart(2, '0') + dec.programHex;
  const claim = htlcClaim({ prevTxid: realTxid, vout: 0, value: BigInt(out.value), refheight: st.frcLock.refheight,
    leafHex: leaf, preimage: deal.secret, claimKey: deal.claimKey, toSpk: payoutSpk, fee: 50000n });
  // The daemon is also the broadcast path, and that is the one residual trust left in this flow:
  // a server that swallowed the claim would be holding the preimage. So the raw transaction is
  // kept on screen — it can be broadcast through any Freicoin node, and the secret it reveals is
  // the same one the claim was already going to reveal.
  deal.claimRawtx = claim.rawtx; save(deal);
  const r = await api('claim', { id: deal.id, rawtx: claim.rawtx });
  deal.phase = 'claimed'; deal.frcClaimTxid = r.txid; save(deal);
  finish({ frcClaimTxid: r.txid });
}

function finish(st) {
  step(4);
  const t = st.frcClaimTxid ?? deal.frcClaimTxid;
  const raw = deal.claimRawtx;
  const payout = deal.payout;
  $('done').hidden = false;
  $('form').hidden = true;
  show('doneAddr', payout);
  const a = $('expl'); if (a && t) { a.href = 'https://freicoin.info/tx/' + t; a.hidden = false; a.textContent = 'посмотреть выплату в обозревателе'; }
  if (raw) { $('rawWrap').hidden = false; show('rawtx', raw); }
  localStorage.removeItem(S_KEY);
}

// after the deadline the jettons walk home on a single wallet message
async function refundJettons() {
  if (!deal?.tonAddress) return;
  await ui.sendTransaction({ validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [{ address: deal.tonAddress, amount: toNano('0.15').toString(),
      payload: beginCell().storeUint(OP.refund, 32).storeUint(3n, 64).endCell().toBoc().toString('base64') }] });
  show('status', 'возврат отправлен — токены вернутся на твой кошелёк');
}

function resume() {
  // the deal survived a reload; put its numbers back on screen so it does not look empty
  const jEl = $('jettons'); if (jEl) jEl.value = Number(deal.jettons) / 10 ** quote.decimals;
  const pEl = $('payout'); if (pEl) pEl.value = deal.payout;
  show('frcOut', `≈ ${fmtFrc(Number(deal.jettons) * quote.rate)} FRC`);
  show('status', 'нашли незавершённую сделку, продолжаем…');
  if (deal.phase === 'lock') lockJettons().catch(e => show('status', e.message));
  else poll();
  if (Date.now() / 1000 > deal.tonDeadline) { $('refund').hidden = false; $('refund').onclick = refundJettons; }
}

function lockForm(on, label) {
  for (const id of ['jettons', 'payout', 'go']) { const e = $(id); if (e) e.disabled = on; }
  if (label) $('go').textContent = label;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
start().catch(e => show('status', 'ошибка: ' + (e?.message || e)));
