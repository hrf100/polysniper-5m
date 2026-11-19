import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { WalletAuthState } from '../types/sniper';

interface WalletAuthModalProps {
  isOpen: boolean;
  walletState: WalletAuthState;
  validationError: string | null;
  onClose: () => void;
  onUpdateField: (field: 'eoaPrivateKey' | 'proxyWalletAddress', value: string) => void;
  onConnect: () => void;
  onRefreshBalances: () => void;
}

export const WalletAuthModal: React.FC<WalletAuthModalProps> = ({
  isOpen,
  walletState,
  validationError,
  onClose,
  onUpdateField,
  onConnect,
  onRefreshBalances,
}) => {
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const statusColor =
    walletState.authTone === 'success'
      ? 'text-emerald-400'
      : walletState.authTone === 'error'
      ? 'text-rose-400'
      : walletState.authTone === 'warning'
      ? 'text-amber-300'
      : 'text-slate-400';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-modal-title"
    >
      <div className="w-full max-w-2xl bg-[#0E1420] border border-slate-700/80 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-4 h-4 text-indigo-400" aria-hidden="true" />
            <h2 id="wallet-modal-title" className="font-display text-sm font-bold text-white">
              Polymarket 私钥鉴权、代理钱包与 L2 API Key 派生
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭钱包鉴权面板"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConnect();
          }}
          className="p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-slate-400">
              私钥仅在本地浏览器内存执行 EIP-712 签名，不上传任何第三方服务器。
            </span>
            <span className={`font-medium ${statusColor}`}>{walletState.authStatus}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="space-y-1.5">
              <label htmlFor="eoa-private-key" className="block text-slate-300 font-medium">
                主钱包 / 中转钱包私钥 (EOA Private Key)
              </label>
              <div className="relative">
                <input
                  id="eoa-private-key"
                  type={showKey ? 'text' : 'password'}
                  value={walletState.eoaPrivateKey}
                  onChange={(e) => onUpdateField('eoaPrivateKey', e.target.value)}
                  placeholder="0x..."
                  autoComplete="off"
                  className="w-full bg-[#070B12] border border-slate-700 rounded-lg pl-3 pr-9 py-2.5 font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  aria-label={showKey ? '隐藏私钥' : '显示私钥'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                >
                  {showKey ? (
                    <EyeOff className="w-4 h-4" aria-hidden="true" />
                  ) : (
                    <Eye className="w-4 h-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="proxy-wallet-addr" className="block text-slate-300 font-medium">
                Polymarket 代理钱包地址 (Proxy Wallet，选填)
              </label>
              <input
                id="proxy-wallet-addr"
                type="text"
                value={walletState.proxyWalletAddress}
                onChange={(e) => onUpdateField('proxyWalletAddress', e.target.value)}
                placeholder="0x... (留空将自动通过主钱包检索)"
                autoComplete="off"
                className="w-full bg-[#070B12] border border-slate-700 rounded-lg px-3 py-2.5 font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {validationError && (
            <div
              role="alert"
              className="px-3.5 py-2.5 bg-rose-950/50 border border-rose-500/40 rounded-lg text-xs text-rose-300"
            >
              {validationError}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={walletState.isLoading}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-xs font-semibold rounded-lg text-white transition-colors whitespace-nowrap shrink-0"
              >
                {walletState.isLoading
                  ? '正在签名并查询链上资产...'
                  : '私钥签名登录并派生 API Key'}
              </button>

              {walletState.eoaAddress && (
                <button
                  type="button"
                  onClick={onRefreshBalances}
                  disabled={walletState.isLoading}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-medium rounded-lg text-slate-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>刷新余额</span>
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-medium text-slate-400 hover:text-white transition-colors"
            >
              完成关闭
            </button>
          </div>

          {walletState.eoaAddress && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-[#070B12] p-4 rounded-lg border border-slate-800 text-xs font-mono">
              <div className="space-y-1">
                <span className="text-slate-500 font-sans block">签名主钱包 (EOA)</span>
                <span className="text-slate-200 break-all block">{walletState.eoaAddress}</span>
                <span className="text-slate-400 block pt-1">
                  Polygon Gas: {walletState.maticBalance} POL
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-slate-500 font-sans block">资金 / 代理钱包 (Proxy)</span>
                <span className="text-amber-300 break-all block">
                  {walletState.proxyWalletAddress}
                </span>
                <span className="text-emerald-400 block pt-1">
                  总资产: $
                  {(walletState.usdcCashBalance + walletState.portfolioValue).toFixed(2)} USDC
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-slate-500 font-sans block">CLOB L2 API 凭证</span>
                <span className="text-indigo-300 break-all block">
                  Key: {walletState.apiKey || '本地 EIP-712 直签就绪'}
                </span>
                {walletState.apiPassphrase && (
                  <span className="text-slate-400 block pt-1">
                    Pass: {walletState.apiPassphrase.slice(0, 10)}***
                  </span>
                )}
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
};
