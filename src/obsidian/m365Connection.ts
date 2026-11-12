import { requestUrl } from 'obsidian';
import type AgentHQPlugin from '../main';
import {
  accountLabel as m365AccountLabel,
  disconnect as m365Disconnect,
  finishDeviceCode,
  isConnected as m365IsConnected,
  needsNewPermission,
  startDeviceCode,
  DEFAULT_M365_CLIENT_ID,
} from '../core/m365/auth';
import { M365SignInModal } from './m365SignIn';

/** Microsoft calls go through Obsidian's own HTTP, as the plugin guidelines ask. */
export const obsidianFetch = (async (url: string, init?: RequestInit) => {
  const response = await requestUrl({
    url: String(url),
    method: init?.method ?? 'GET',
    headers: init?.headers as Record<string, string> | undefined,
    body: typeof init?.body === 'string' ? init.body : undefined,
    throw: false,
  });
  return new Response(response.status === 204 ? null : response.text, {
    status: response.status,
  });
}) as typeof fetch;

/** The Microsoft 365 sign-in: connect, cancel, disconnect, and keeping the page's status line current. */
export class M365Connection {
  connected = false;
  private signin: AbortController | null = null;

  constructor(
    private readonly plugin: AgentHQPlugin,
    private readonly isActive: () => boolean,
  ) {}

  async refresh(): Promise<void> {
    this.connected = await m365IsConnected();
    if (this.isActive())
      this.plugin.workspace.setM365Status({
        connected: this.connected,
        account: this.plugin.settings.m365Account || undefined,
        needsPermission: this.connected && (await needsNewPermission()),
      });
  }

  /**
   * Starts Microsoft's device sign-in. The owner opens Microsoft's page and types the code there; this plugin never
   * sees a password. Resolves when the sign-in is finished or cancelled.
   */
  async connect(): Promise<void> {
    const { plugin } = this;
    const clientId = plugin.settings.m365ClientId || DEFAULT_M365_CLIENT_ID;
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(clientId))
      throw Error(
        'Enter the Application (client) ID of your Microsoft app registration first.',
      );
    this.signin?.abort();
    const controller = new AbortController();
    this.signin = controller;
    const authority = plugin.settings.m365Authority;
    const code = await startDeviceCode(clientId, authority, obsidianFetch);
    const modal = new M365SignInModal(plugin.app, code, () =>
      controller.abort(),
    );
    modal.open();
    try {
      await finishDeviceCode(code, clientId, authority, {
        signal: controller.signal,
        f: obsidianFetch,
      });
      modal.setStatus('Approved. Reading your account name…');
      const label = await m365AccountLabel({ f: obsidianFetch });
      plugin.settings.m365Account = label;
      await plugin.saveSettings();
      modal.setStatus(
        label ? `Connected as ${label}` : 'Connected (name unavailable)',
        true,
      );
    } catch (error) {
      // Closing the window cancels on purpose; anything else is shown in the window and reported.
      if (controller.signal.aborted) return;
      modal.setStatus(
        error instanceof Error ? error.message : 'The sign-in failed.',
        true,
      );
      throw error;
    } finally {
      if (this.signin === controller) this.signin = null;
      await this.refresh();
    }
  }

  cancel(): void {
    this.signin?.abort();
  }

  /** Removes the saved token. Access granted at Microsoft stays until the owner removes it in their account. */
  async disconnect(): Promise<void> {
    await m365Disconnect();
    this.plugin.settings.m365Account = '';
    await this.plugin.saveSettings();
    await this.refresh();
  }
}
