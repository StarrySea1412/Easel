import type { AccountItem } from './api';
import { accountConnection, type AccountConnection, type WhoamiEntry } from './whoami';

export interface DefaultAccountEntry {
  platform: string;
  name: string;
  connection: AccountConnection;
  checkedAt?: number;
}

/** Display known default identities alongside independent accounts, without
 * migrating credentials or treating a profile directory as a connected account. */
export function defaultAccountInventory(accounts: AccountItem[], identities: Record<string, WhoamiEntry>): DefaultAccountEntry[] {
  return accounts.flatMap(account => {
    const cached = identities[account.platform];
    const current = !account.identityKey || cached?.identityKey === account.identityKey ? cached : undefined;
    const snapshot = !account.identityKey || account.identity?.identityKey === account.identityKey ? account.identity : undefined;
    const connection = accountConnection(account, current);
    if (!account.supported || (account.hasLocalSession === false && !account.loggedIn && connection !== 'online')) return [];
    if (!account.loggedIn && !current?.loggedIn && !current?.name && !current?.accountId
        && current?.authState !== 'login_required'
        && !snapshot?.loggedIn && !snapshot?.name && !snapshot?.accountId) return [];
    return [{ platform: account.platform, name: current?.name || snapshot?.name || '', connection, checkedAt: current?.checkedAt }];
  });
}
