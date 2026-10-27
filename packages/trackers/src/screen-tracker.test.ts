import { describe, expect, it } from 'vitest';
import { ScreenTracker } from './screen-tracker';

describe('ScreenTracker', () => {
  it('has the carrier-shared name and answers undefined before anything is set', () => {
    const t = new ScreenTracker();
    expect(t.name).toBe('screen');
    expect(t.currentRoute()).toBeUndefined();
    expect(t.currentView()).toBeUndefined();
  });

  it('holds the route and announces a change on the route channel', () => {
    const t = new ScreenTracker();
    const seen: string[] = [];
    t.on('route', (e) => seen.push(e.route));
    t.setRoute('/orders/:id');
    expect(t.currentRoute()).toBe('/orders/:id');
    expect(seen).toEqual(['/orders/:id']);
  });

  it('does not announce a repeated route, and announces a different one', () => {
    const t = new ScreenTracker();
    const seen: string[] = [];
    t.on('route', (e) => seen.push(e.route));
    t.setRoute('/a');
    t.setRoute('/a');
    t.setRoute('/b');
    t.setRoute('/a');
    expect(seen).toEqual(['/a', '/b', '/a']);
  });

  it('holds the view and announces on the view channel, de-duplicating by content', () => {
    const t = new ScreenTracker();
    const seen: unknown[] = [];
    t.on('view', (e) => seen.push(e.view));
    t.setView({ name: 'A', type: 'vue' });
    t.setView({ name: 'A', type: 'vue' }); // a different object, the same view
    t.setView({ name: 'A' }); // type differs
    t.setView({ name: 'B' }); // same (absent) type, different name
    t.setView('$$none');
    t.setView('$$none');
    expect(t.currentView()).toBe('$$none');
    expect(seen).toEqual([{ name: 'A', type: 'vue' }, { name: 'A' }, { name: 'B' }, '$$none']);
  });

  it('keeps the held values with no subscriber (a later subscriber reads them at once)', () => {
    const t = new ScreenTracker();
    t.setRoute('/x');
    t.setView({ name: 'X' });
    expect(t.currentRoute()).toBe('/x');
    expect(t.currentView()).toEqual({ name: 'X' });
  });

  it('keeps route and view independent', () => {
    const t = new ScreenTracker();
    const routes: string[] = [];
    const views: unknown[] = [];
    t.on('route', (e) => routes.push(e.route));
    t.on('view', (e) => views.push(e.view));
    t.setRoute('/r');
    expect(views).toEqual([]);
    t.setView({ name: 'V' });
    expect(routes).toEqual(['/r']);
  });

  it('a throwing subscriber reaches onError and does not stop the next one', () => {
    const errors: unknown[] = [];
    const t = new ScreenTracker((e) => errors.push(e));
    const got: string[] = [];
    t.on('route', () => {
      throw new Error('boom');
    });
    t.on('route', (e) => got.push(e.route));
    t.setRoute('/x');
    expect(got).toEqual(['/x']);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('holds a value that a throwing subscriber saw (the state is committed before announcing)', () => {
    const t = new ScreenTracker(() => {});
    t.on('route', () => {
      throw new Error('boom');
    });
    t.setRoute('/x');
    expect(t.currentRoute()).toBe('/x');
  });
});
