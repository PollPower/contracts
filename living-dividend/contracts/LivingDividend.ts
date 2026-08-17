export interface LivingDividendTxSubmission {
  public?: {
    txHash?: string;
    txId?: string;
  };
  txHash?: string;
  txId?: string;
}

export interface LivingDividendContract {
  callTx: {
    bumpOnMint(sourceTxSalt: Uint8Array, amount: bigint, currentTime: bigint): Promise<LivingDividendTxSubmission>;
  };
  query?: {
    hasProcessedSalt?(sourceTxSalt: Uint8Array): Promise<boolean>;
  };
}

export async function hasProcessedSaltIfAvailable(
  contract: LivingDividendContract,
  sourceTxSalt: Uint8Array,
): Promise<boolean> {
  if (!contract.query?.hasProcessedSalt) {
    return false;
  }
  return contract.query.hasProcessedSalt(sourceTxSalt);
}

export function getTxHashFromSubmission(tx: LivingDividendTxSubmission): string {
  return tx.public?.txHash ?? tx.public?.txId ?? tx.txHash ?? tx.txId ?? 'unknown';
}
