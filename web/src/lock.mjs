// lock.mjs — the page that lets a counterparty lock jettons with nothing but their own wallet.
// Everything that matters is recomputed here, in the browser, from plain parameters in the URL:
// the contract address falls out of OUR code cell (baked in at build time) plus the fields shown
// on screen, so what you see is what the money is subject to. The wallet only signs.
//
// URL: lock.html?hash=<hex64>&deadline=<unix>&master=<addr>&governed=1&giver=<addr>&taker=<addr>
//        &jettons=<raw units>&decimals=9&symbol=POK&chain=mainnet
import { Address, Cell, beginCell, contractAddress, toNano } from '@ton/core';
import { TonConnectUI } from '@tonconnect/ui';
import HTLC_CODE_B64 from './htlc-code.mjs';

const P = new URLSearchParams(location.search);
const need = k => { const v = P.get(k); if (!v) throw new Error('missing ' + k); return v; };
const CHAIN = P.get('chain') || 'mainnet';
const API = CHAIN === 'testnet' ? 'https://testnet.toncenter.com/api/v2' : 'https://toncenter.com/api/v2';
const $ = id => document.getElementById(id);
const show = (id, t) => { $(id).textContent = t; };

const params = {
  hash: need('hash').toLowerCase(),
  deadline: Number(need('deadline')),
  master: Address.parse(need('master')),
  governed: P.get('governed') === '1',
  giver: Address.parse(need('giver')),
  taker: Address.parse(need('taker')),
  jettons: BigInt(need('jettons')),
  decimals: Number(P.get('decimals') || 9),
  symbol: P.get('symbol') || 'токенов',
};

// ---- the same arithmetic the contract runs -----------------------------------------------------
const walletData = (owner, master, code) => params.governed
  ? beginCell().storeUint(0, 4).storeCoins(0).storeAddress(owner).storeAddress(master).endCell()
  : beginCell().storeCoins(0).storeAddress(owner).storeAddress(master).storeRef(code).endCell();
const jettonWalletOf = (owner, master, code) => {
  const si = beginCell().storeUint(0, 2).storeMaybeRef(code).storeMaybeRef(walletData(owner, master, code)).storeUint(0, 1).endCell();
  return new Address(0, si.hash());
};

async function jettonWalletCode() {
  const r = await fetch(`${API}/runGetMethod`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: params.master.toString(), method: 'get_jetton_data', stack: [] }),
  }).then(x => x.json());
  if (!r.ok) throw new Error('не удалось прочитать жетон: ' + JSON.stringify(r.error).slice(0, 120));
  const cellB64 = r.result.stack[4][1].bytes;              // 5th item: the jetton wallet code
  return Cell.fromBase64(cellB64);
}

function htlcInit(walletCode) {
  const data = beginCell()
    .storeUint(BigInt('0x' + params.hash), 256).storeUint(params.deadline, 32)
    .storeUint(0, 1).storeUint(params.governed ? 1 : 0, 1).storeCoins(0)
    .storeRef(beginCell().storeAddress(params.master).storeAddress(params.giver).storeAddress(params.taker).endCell())
    .storeRef(walletCode)
    .endCell();
  return { code: Cell.fromBase64(HTLC_CODE_B64), data };
}

const fmt = v => (Number(v) / 10 ** params.decimals).toLocaleString('ru-RU');
const OP_TRANSFER = 0xf8a7ea5;

async function main() {
  show('amount', `${fmt(params.jettons)} ${params.symbol}`);
  show('deadline', new Date(params.deadline * 1000).toLocaleString('ru-RU') +
    ` (через ${Math.max(0, Math.round((params.deadline - Date.now() / 1000) / 60))} мин)`);
  show('hash', params.hash);
  show('refund', params.giver.toString({ bounceable: false }));

  const walletCode = await jettonWalletCode();
  const init = htlcInit(walletCode);
  const htlc = contractAddress(0, init);
  show('contract', htlc.toString());
  show('status', 'адрес контракта посчитан этой страницей из параметров выше — кошельку остаётся подписать');

  const ui = new TonConnectUI({
    manifestUrl: 'https://freicoin.ru/swap/tonconnect-manifest.json',
    buttonRootId: 'connect',
  });

  $('lock').onclick = async () => {
    try {
      const acc = ui.account;
      if (!acc) { show('status', 'сначала подключи кошелёк'); return; }
      const me = Address.parse(acc.address);
      // the refund inside the contract goes to `giver`; signing from any other wallet
      // would hand the timeout path to a stranger
      if (!me.equals(params.giver)) {
        show('status', `подключён ${me.toString({ bounceable: false })}, а возврат в сделке настроен на ${params.giver.toString({ bounceable: false })} — это должен быть один и тот же кошелёк`);
        return;
      }
      const myJettonWallet = jettonWalletOf(me, params.master, walletCode);
      const transfer = beginCell()
        .storeUint(OP_TRANSFER, 32).storeUint(1n, 64).storeCoins(params.jettons)
        .storeAddress(htlc).storeAddress(me).storeUint(0, 1)
        .storeCoins(toNano('0.1')).storeUint(0, 1).endCell();
      show('status', 'подтверди в кошельке…');
      await ui.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [
          { address: htlc.toString(), amount: toNano('0.05').toString(),
            stateInit: beginCell().storeUint(6, 5).storeRef(init.code).storeRef(init.data).endCell().toBoc().toString('base64') },
          { address: myJettonWallet.toString(), amount: toNano('0.2').toString(),
            payload: transfer.toBoc().toString('base64') },
        ],
      });
      show('status', 'отправлено. Контракт можно смотреть тут: ' + htlc.toString());
      $('viewer').href = (CHAIN === 'testnet' ? 'https://testnet.tonviewer.com/' : 'https://tonviewer.com/') + htlc.toString();
      $('viewer').hidden = false;
    } catch (e) { show('status', 'не вышло: ' + (e?.message || e)); }
  };
}

main().catch(e => show('status', 'ошибка: ' + (e?.message || e)));
