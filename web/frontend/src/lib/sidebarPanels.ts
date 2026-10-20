/** Sidebar popovers share ownership, including hover-triggered account preview. */
export const SIDEBAR_PANEL_EVENT = 'easel:sidebar-panel';
export function openSidebarPanel(id: string) {
  window.dispatchEvent(new window.CustomEvent(SIDEBAR_PANEL_EVENT, { detail: id }));
}
