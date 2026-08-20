import { getClient } from '../bugsee-client';

// Support chat over a real WebSocket (server/api-plugin.ts echoes back) — S7's WebSocket capture path.

export function renderChat(container: HTMLElement): void {
  container.innerHTML = `
    <section class="block">
      <h1>Support chat</h1>
      <div id="messages" class="chat-box"></div>
      <form id="chat-form" class="row">
        <input id="chat-input" type="text" placeholder="Ask about a widget…" style="flex:1" />
        <button type="submit">Send</button>
      </form>
    </section>
  `;
  const messages = container.querySelector('#messages') as HTMLElement;
  const form = container.querySelector('#chat-form') as HTMLFormElement;
  const input = container.querySelector('#chat-input') as HTMLInputElement;

  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${window.location.host}/ws/chat`);

  const append = (from: string, text: string): void => {
    const div = document.createElement('div');
    div.className = `chat-msg${from === 'me' ? ' mine' : ''}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  };

  socket.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data as string) as { from: string; text: string };
      append(data.from, data.text);
    } catch {
      append('support', String(event.data));
    }
  });
  socket.addEventListener('open', () => {
    getClient()?.addBreadcrumb({ message: 'chat socket opened', category: 'chat', level: 'info' });
  });
  socket.addEventListener('close', () => {
    getClient()?.addBreadcrumb({ message: 'chat socket closed', category: 'chat', level: 'info' });
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text.length === 0) return;
    append('me', text);
    socket.send(JSON.stringify({ text }));
    input.value = '';
  });

  window.addEventListener('hashchange', () => socket.close(), { once: true });
}
