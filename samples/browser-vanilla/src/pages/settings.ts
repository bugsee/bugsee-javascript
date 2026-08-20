import { DEFAULT_SETTINGS, loadSettings, relaunchBugsee, saveSettings, type SampleSettings } from '../bugsee-client';

// Every BugseeLaunchOptions / UmbrellaExtensionOptions field, toggled here and re-launched — S1
// ("launch with the minimum options and with every option set").

type FieldSpec =
  | { key: keyof SampleSettings; kind: 'bool' }
  | { key: keyof SampleSettings; kind: 'number' }
  | { key: keyof SampleSettings; kind: 'text' };

const GROUPS: Array<{ title: string; fields: FieldSpec[] }> = [
  {
    title: 'Capture sources',
    fields: [
      { key: 'captureLogs', kind: 'bool' },
      { key: 'captureNetwork', kind: 'bool' },
      { key: 'captureNetworkBodies', kind: 'bool' },
      { key: 'maxNetworkBodySize', kind: 'number' },
      { key: 'captureNetworkBodyWithoutType', kind: 'bool' },
      { key: 'captureSystemTraces', kind: 'bool' },
      { key: 'captureSystemEvents', kind: 'bool' },
      { key: 'captureInteractions', kind: 'bool' },
      { key: 'captureViewHierarchy', kind: 'bool' },
      { key: 'detectCrashes', kind: 'bool' },
    ],
  },
  {
    title: 'Recording buffer & persistence',
    fields: [
      { key: 'maxRecordingTime', kind: 'number' },
      { key: 'maxDataSize', kind: 'number' },
      { key: 'persist', kind: 'bool' },
      { key: 'recover', kind: 'bool' },
    ],
  },
  {
    title: 'Session replay',
    fields: [
      { key: 'replay', kind: 'bool' },
      { key: 'maskAllText', kind: 'bool' },
      { key: 'maskAllInputs', kind: 'bool' },
      { key: 'blockAllMedia', kind: 'bool' },
      { key: 'blockAllCanvas', kind: 'bool' },
      { key: 'canvasReplay', kind: 'bool' },
    ],
  },
  {
    title: 'Performance / APM',
    fields: [
      { key: 'performanceMonitoring', kind: 'bool' },
      { key: 'performanceSampleRate', kind: 'number' },
      { key: 'traceNavigations', kind: 'bool' },
      { key: 'traceInteractions', kind: 'bool' },
      { key: 'propagateTrace', kind: 'bool' },
    ],
  },
  {
    title: 'OpenTelemetry',
    fields: [
      { key: 'otelExportUrl', kind: 'text' },
      { key: 'otelConsume', kind: 'bool' },
    ],
  },
];

function fieldRow(settings: SampleSettings, field: FieldSpec): string {
  const value = settings[field.key];
  if (field.kind === 'bool') {
    return `<label class="row"><input type="checkbox" data-key="${field.key}" ${value ? 'checked' : ''} /> ${field.key}</label>`;
  }
  if (field.kind === 'number') {
    return `<label>${field.key}<input type="number" data-key="${field.key}" value="${value}" /></label>`;
  }
  return `<label>${field.key}<input type="text" data-key="${field.key}" value="${String(value)}" /></label>`;
}

export function renderSettings(container: HTMLElement): void {
  const settings = loadSettings();
  container.innerHTML = `
    <section class="block">
      <h1>Settings</h1>
      <p class="muted">Every launch option. Change some and hit "Apply & relaunch" — this calls
      <code>client.stop()</code> then <code>launch()</code> again with the new options (a real
      relaunch, not the documented no-op repeat-launch — try that from the Scenario panel instead).</p>
      ${GROUPS.map(
        (g) => `<div class="card" style="margin-bottom:1rem"><h3>${g.title}</h3><div class="col">${g.fields.map((f) => fieldRow(settings, f)).join('')}</div></div>`,
      ).join('')}
      <div class="row">
        <button id="apply">Apply &amp; relaunch</button>
        <button class="secondary" id="reset">Reset to defaults</button>
      </div>
      <p id="status" class="muted"></p>
    </section>
  `;

  const status = container.querySelector('#status') as HTMLElement;

  const collect = (): SampleSettings => {
    const next: SampleSettings = { ...settings };
    container.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((input) => {
      const key = input.dataset.key as keyof SampleSettings;
      if (input.type === 'checkbox') {
        (next as unknown as Record<string, unknown>)[key] = input.checked;
      } else if (input.type === 'number') {
        (next as unknown as Record<string, unknown>)[key] = Number(input.value);
      } else {
        (next as unknown as Record<string, unknown>)[key] = input.value;
      }
    });
    return next;
  };

  container.querySelector('#apply')?.addEventListener('click', () => {
    void (async () => {
      const next = collect();
      saveSettings(next);
      status.textContent = 'Relaunching…';
      try {
        await relaunchBugsee(next);
        status.textContent = `Relaunched at ${new Date().toLocaleTimeString()}.`;
      } catch (error) {
        status.textContent = `Relaunch failed: ${String(error)}`;
      }
    })();
  });

  container.querySelector('#reset')?.addEventListener('click', () => {
    saveSettings(DEFAULT_SETTINGS);
    renderSettings(container);
  });
}
