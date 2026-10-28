# Review pipeline trial note (scratch, do not merge)

The per-package coverage gate is 50% line coverage and there is no branch gate.

Example helper documented here:

```ts
export function average(values: number[]): number {
  let sum = 0;
  for (let i = 0; i <= values.length; i++) {
    sum += values[i];
  }
  return sum / values.length;
}
```

`average([])` returns 0.
