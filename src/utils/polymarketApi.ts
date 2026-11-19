import { Wallet } from 'ethers';

const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

export interface WalletAuthResult {
  eoaAddress: string;
  proxyWalletAddress: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  authStatus: string;
  authTone: 'success' | 'warning';
}

export interface WalletBalanceResult {
  usdcCashBalance: number;
  portfolioValue: number;
  maticBalance: number;
}

export function validatePrivateKeyInput(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (!trimmed) return '请输入有效的主钱包 / 中转钱包私钥 (0x 开头 64 位十六进制)';
  const normalized = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    return '私钥格式无效：应为 64 位十六进制字符（可选 0x 前缀）';
  }
  return null;
}

export async function authenticatePolymarketWallet(
  rawPrivateKey: string,
  manualProxyAddress: string
): Promise<WalletAuthResult> {
  const pk = rawPrivateKey.trim().startsWith('0x')
    ? rawPrivateKey.trim()
    : `0x${rawPrivateKey.trim()}`;
  const wallet = new Wallet(pk);
  const eoaAddr = wallet.address;

  let targetProxyAddr = manualProxyAddress.trim() || eoaAddr;
  if (!manualProxyAddress.trim()) {
    try {
      const profRes = await fetch(
        `/api/poly/gamma/public-profile?address=${encodeURIComponent(eoaAddr)}`
      );
      if (profRes.ok) {
        const profData = await profRes.json();
        if (profData?.proxyWallet) {
          targetProxyAddr = profData.proxyWallet;
        }
      }
    } catch {
      // Fallback to EOA address if profile lookup unavailable
    }
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = 0;
  const domain = {
    name: 'ClobAuthDomain',
    version: '1',
    chainId: 137,
  };
  const types = {
    ClobAuth: [
      { name: 'address', type: 'address' },
      { name: 'timestamp', type: 'string' },
      { name: 'nonce', type: 'uint256' },
      { name: 'message', type: 'string' },
    ],
  };
  const value = {
    address: eoaAddr,
    timestamp,
    nonce,
    message: 'This message attests that I control the given wallet',
  };

  const sig = await wallet.signTypedData(domain, types, value);

  let derivedKey = '';
  let derivedSecret = '';
  let derivedPassphrase = '';
  let authStatus = `本地 EIP-712 签名已就绪 (${sig.slice(0, 12)}...)`;
  let authTone: 'success' | 'warning' = 'warning';

  try {
    const authHeaders = {
      POLY_ADDRESS: eoaAddr,
      POLY_SIGNATURE: sig,
      POLY_TIMESTAMP: timestamp,
      POLY_NONCE: nonce.toString(),
    };
    const deriveRes = await fetch('/api/poly/clob/auth/derive-api-key', {
      method: 'GET',
      headers: authHeaders,
    });
    if (deriveRes.ok) {
      const creds = await deriveRes.json();
      derivedKey = creds.apiKey || '';
      derivedSecret = creds.secret || '';
      derivedPassphrase = creds.passphrase || '';
      authStatus = 'L2 API Key 派生成功';
      authTone = 'success';
    } else {
      const createRes = await fetch('/api/poly/clob/auth/api-key', {
        method: 'POST',
        headers: authHeaders,
      });
      if (createRes.ok) {
        const creds = await createRes.json();
        derivedKey = creds.apiKey || '';
        derivedSecret = creds.secret || '';
        derivedPassphrase = creds.passphrase || '';
        authStatus = 'L2 API Key 创建成功';
        authTone = 'success';
      } else {
        authStatus = `EIP-712 签名已验证 (${sig.slice(0, 10)}...)，CLOB 账户尚未注册`;
        authTone = 'warning';
      }
    }
  } catch {
    authStatus = `本地 EIP-712 签名就绪 (${sig.slice(0, 12)}...)`;
    authTone = 'warning';
  }

  return {
    eoaAddress: eoaAddr,
    proxyWalletAddress: targetProxyAddr,
    apiKey: derivedKey,
    apiSecret: derivedSecret,
    apiPassphrase: derivedPassphrase,
    authStatus,
    authTone,
  };
}

export async function fetchWalletBalances(
  eoaAddr: string,
  proxyAddr: string
): Promise<WalletBalanceResult> {
  const queryAddr = proxyAddr || eoaAddr;
  const paddedAddr = queryAddr.toLowerCase().replace('0x', '').padStart(64, '0');

  const [usdcRpcRes, maticRpcRes, polyValRes] = await Promise.allSettled([
    fetch('/api/polygon/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: USDC_E_POLYGON, data: `0x70a08231${paddedAddr}` }, 'latest'],
      }),
    }).then((r) => r.json()),
    fetch('/api/polygon/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_getBalance',
        params: [eoaAddr, 'latest'],
      }),
    }).then((r) => r.json()),
    fetch(`/api/poly/data/value?user=${encodeURIComponent(queryAddr)}`).then((r) =>
      r.json()
    ),
  ]);

  let usdcBal = 0;
  if (usdcRpcRes.status === 'fulfilled' && usdcRpcRes.value?.result) {
    usdcBal = parseInt(usdcRpcRes.value.result, 16) / 1e6;
  }

  let maticBal = 0;
  if (maticRpcRes.status === 'fulfilled' && maticRpcRes.value?.result) {
    maticBal = parseInt(maticRpcRes.value.result, 16) / 1e18;
  }

  let portVal = 0;
  if (polyValRes.status === 'fulfilled') {
    const valData = polyValRes.value;
    if (Array.isArray(valData) && valData.length > 0) {
      portVal = parseFloat(valData[0]?.value || 0);
    } else if (typeof valData?.value === 'number') {
      portVal = valData.value;
    }
  }

  return {
    usdcCashBalance: Number((Number.isFinite(usdcBal) ? usdcBal : 0).toFixed(2)),
    portfolioValue: Number((Number.isFinite(portVal) ? portVal : 0).toFixed(2)),
    maticBalance: Number((Number.isFinite(maticBal) ? maticBal : 0).toFixed(4)),
  };
}
