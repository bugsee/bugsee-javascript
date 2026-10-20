import { describe, expect, it } from 'vitest';
import { mapGpuInfo } from './gpu-info';

const basic = (devices: unknown[]) => ({ gpuDevice: devices });

describe('mapGpuInfo', () => {
  it('uses the ACTIVE device strings, wherever it is in the list', () => {
    const dev = (active: boolean, name: string) => ({
      vendorId: 1,
      deviceId: 2,
      active,
      vendorString: `${name}-vendor`,
      deviceString: `${name}-device`,
    });
    const expected = (name: string) => ({ vendor: `${name}-vendor`, renderer: `${name}-device` });
    expect(mapGpuInfo(basic([dev(true, 'A'), dev(false, 'B'), dev(false, 'C')]))).toEqual(
      expected('A'),
    );
    expect(mapGpuInfo(basic([dev(false, 'A'), dev(true, 'B'), dev(false, 'C')]))).toEqual(
      expected('B'),
    );
    expect(mapGpuInfo(basic([dev(false, 'A'), dev(false, 'B'), dev(true, 'C')]))).toEqual(
      expected('C'),
    );
  });

  it('takes the FIRST active device, and only a literal `active: true` counts', () => {
    expect(
      mapGpuInfo(
        basic([
          { active: true, vendorString: 'First' },
          { active: true, vendorString: 'Second' },
        ]),
      ),
    ).toEqual({ vendor: 'First' });
    expect(
      mapGpuInfo(
        basic([
          { active: 1, vendorString: 'A' },
          { active: 'yes', vendorString: 'B' },
        ]),
      ),
    ).toBeUndefined();
  });

  it('uses the only device when none is flagged active, but never guesses among several', () => {
    expect(mapGpuInfo(basic([{ vendorString: 'V', deviceString: 'R' }]))).toEqual({
      vendor: 'V',
      renderer: 'R',
    });
    expect(
      mapGpuInfo(
        basic([
          { vendorString: 'A', deviceString: 'a' },
          { vendorString: 'B', deviceString: 'b' },
        ]),
      ),
    ).toBeUndefined();
  });

  it('omits a field whose string is missing; never invents a vendor from a numeric id', () => {
    expect(mapGpuInfo(basic([{ active: true, vendorId: 4318, vendorString: 'NVIDIA' }]))).toEqual({
      vendor: 'NVIDIA',
    });
    expect(mapGpuInfo(basic([{ active: true, deviceString: 'RTX' }]))).toEqual({ renderer: 'RTX' });
    expect(mapGpuInfo(basic([{ active: true, vendorId: 4318, deviceId: 7 }]))).toBeUndefined();
    expect(
      mapGpuInfo(basic([{ active: true, vendorString: '  ', deviceString: 5 }])),
    ).toBeUndefined();
  });

  it('fills vendor/renderer/gl_version/gl_extensions from auxAttributes (trimmed)', () => {
    expect(
      mapGpuInfo({
        gpuDevice: [
          { vendorId: 4318, deviceId: 7, active: true, vendorString: '', deviceString: '' },
        ],
        auxAttributes: {
          glVendor: ' NVIDIA Corporation ',
          glRenderer: 'RTX 4090/PCIe',
          glVersion: 'OpenGL ES 3.0',
          glExtensions: 'GL_A GL_B',
        },
      }),
    ).toEqual({
      vendor: 'NVIDIA Corporation',
      renderer: 'RTX 4090/PCIe',
      gl_version: 'OpenGL ES 3.0',
      gl_extensions: 'GL_A GL_B',
    });
  });

  it('works from auxAttributes alone (no gpuDevice), and device strings win over aux per field', () => {
    expect(mapGpuInfo({ auxAttributes: { glRenderer: 'R' } })).toEqual({ renderer: 'R' });
    expect(
      mapGpuInfo({
        gpuDevice: [{ active: true, vendorString: 'DevVendor' }],
        auxAttributes: { glVendor: 'AuxVendor', glRenderer: 'AuxRenderer' },
      }),
    ).toEqual({ vendor: 'DevVendor', renderer: 'AuxRenderer' });
  });

  it('drops blank / non-string aux values and ignores a non-object aux; ids never become names', () => {
    expect(
      mapGpuInfo({
        gpuDevice: [{ active: true, vendorId: 4318, deviceId: 1 }],
        auxAttributes: { glVendor: '  ', glRenderer: 5, glVersion: null, glExtensions: ['A'] },
      }),
    ).toBeUndefined();
    expect(mapGpuInfo({ gpuDevice: [], auxAttributes: 'x' })).toBeUndefined();
    expect(mapGpuInfo({ gpuDevice: [], auxAttributes: null })).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'gpu'],
    ['no gpuDevice', {}],
    ['a non-array gpuDevice', { gpuDevice: 'x' }],
    ['an empty list', { gpuDevice: [] }],
    ['non-object devices', { gpuDevice: [1, null, 'x'] }],
  ])('returns undefined for %s', (_n, value) => {
    expect(mapGpuInfo(value)).toBeUndefined();
  });
});
