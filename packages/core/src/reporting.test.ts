import { describe, expect, it, vi } from 'vitest';
import { createReportingRequest, type ReportingTriggerType } from './reporting';

describe('createReportingRequest', () => {
  it('carries the source and uses a given id for both request and report', () => {
    const req = createReportingRequest({ source: { type: 'crash', origin: 'onerror' }, id: 'r1' });
    expect(req.id).toBe('r1');
    expect(req.report.id).toBe('r1');
    expect(req.source).toEqual({ type: 'crash', origin: 'onerror' });
  });

  it('generates an id when none is given', () => {
    const generateId = vi.fn(() => 'gen-1');
    const req = createReportingRequest({ source: { type: 'shake' } }, generateId);
    expect(generateId).toHaveBeenCalledTimes(1);
    expect(req.id).toBe('gen-1');
    expect(req.report.id).toBe('gen-1');
  });

  it('uses the built-in id generator when none is injected (unique non-empty ids)', () => {
    const a = createReportingRequest({ source: { type: 'shake' } });
    const b = createReportingRequest({ source: { type: 'shake' } });
    expect(a.id).toMatch(/.+/);
    expect(a.report.id).toBe(a.id);
    expect(a.id).not.toBe(b.id);
  });

  it.each<[ReportingTriggerType, string]>([
    ['crash', 'crash'],
    ['error', 'error'],
    ['assert', 'error'],
    ['shake', 'bug'],
    ['code_upload', 'bug'],
    ['unknown', 'bug'],
  ])('derives the issue type from source %s -> %s', (trigger, expected) => {
    const req = createReportingRequest({ source: { type: trigger }, id: 'x' });
    expect(req.report.type).toBe(expected);
  });

  it('lets an explicit type override the derived one', () => {
    const req = createReportingRequest({ source: { type: 'crash' }, type: 'bug', id: 'x' });
    expect(req.report.type).toBe('bug');
  });

  it.each<[ReportingTriggerType, string]>([
    ['crash', 'blocker'],
    ['error', 'high'],
    ['shake', 'high'],
  ])('derives severity from the type for source %s -> %s', (trigger, expected) => {
    expect(createReportingRequest({ source: { type: trigger }, id: 'x' }).report.severity).toBe(
      expected,
    );
  });

  it('lets an explicit severity override the derived one', () => {
    const req = createReportingRequest({ source: { type: 'crash' }, severity: 'medium', id: 'x' });
    expect(req.report.severity).toBe('medium');
  });

  it('passes through summary, description, email, labels and signatures', () => {
    const req = createReportingRequest({
      source: { type: 'code_upload' },
      id: 'x',
      summary: 'Boom',
      description: 'detail',
      email: 'a@b.c',
      labels: ['p1'],
      signatures: ['sig'],
    });
    expect(req.report).toMatchObject({
      summary: 'Boom',
      description: 'detail',
      email: 'a@b.c',
      labels: ['p1'],
      signatures: ['sig'],
    });
  });

  it('defaults labels, signatures and attributes to empty, omitting absent optionals', () => {
    const req = createReportingRequest({ source: { type: 'code_upload' }, id: 'x' });
    expect(req.report.labels).toEqual([]);
    expect(req.report.signatures).toEqual([]);
    expect(req.report.attributes).toEqual({});
    expect(req.report.summary).toBeUndefined();
    expect('summary' in req.report).toBe(false);
  });

  it('carries the capture mechanism on the source when provided', () => {
    const req = createReportingRequest({
      source: { type: 'crash', mechanism: 'uncaught' },
      id: 'x',
    });
    expect(req.source.mechanism).toBe('uncaught');
  });

  it('leaves the mechanism undefined when the source does not provide one', () => {
    const req = createReportingRequest({ source: { type: 'shake' }, id: 'x' });
    expect(req.source.mechanism).toBeUndefined();
  });
});
