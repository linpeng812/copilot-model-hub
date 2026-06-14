import * as vscode from 'vscode';

/** Shared output channel for the extension. */
let channel: vscode.LogOutputChannel | undefined;

export function getLogger(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Copilot Model Hub', { log: true });
  }
  return channel;
}

export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}
