import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function quitCodexDesktop(): Promise<void> {
  const scripts = [
    ['-e', 'tell application id "com.openai.chat" to quit'],
    ['-e', 'tell application "Codex" to quit'],
    ['-e', 'tell application "ChatGPT" to quit']
  ];
  for (const args of scripts) {
    await execFileAsync('osascript', args).catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

export async function launchCodexDesktop(): Promise<void> {
  await execFileAsync('open', ['-a', 'Codex']).catch(async () => {
    await execFileAsync('open', ['-a', 'ChatGPT']).catch(() => undefined);
  });
}
