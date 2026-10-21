import PublishReceiptCenter from './PublishReceiptCenter';
import type { PublishReceiptsModel } from '../hooks/usePublishReceipts';

export default function PublishReceiptsPage({ model, onConfigure, onOpenPublish, onAccounts }: {
  model: PublishReceiptsModel;
  onConfigure: () => void;
  onOpenPublish: () => void;
  onAccounts: () => void;
}) {
  return <PublishReceiptCenter model={model} mode="page" showEntry={false}
    onConfigure={onConfigure} onOpenPublish={onOpenPublish} onAccounts={onAccounts} />;
}
