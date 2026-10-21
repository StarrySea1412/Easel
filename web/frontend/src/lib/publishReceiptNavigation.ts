export function publishReceiptHash(receiptId?: unknown): string {
  return '#/publish-receipts' + (typeof receiptId === 'string' && /^[a-f0-9]{32}$/.test(receiptId) ? `/${receiptId}` : '');
}

export function parsePublishReceiptHash(hash: string): { receiptId?: string } | null {
  const match = /^#\/publish-receipts(?:\/([a-f0-9]{32}))?\/?$/.exec(hash);
  return match ? { receiptId: match[1] } : null;
}
