import { withBugseeProfiler } from '@bugsee/react';

interface Props {
  count: number;
}

/** A deliberately slow render (busy-loop per item) so BugseeProfiler/withBugseeProfiler's recorded
 *  ui.render span duration is visibly non-zero. */
function SlowListImpl({ count }: Props): JSX.Element {
  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    let acc = 0;
    for (let j = 0; j < 2000; j++) acc += Math.sqrt(j); // burn some CPU per item, on purpose
    items.push(`Item ${i} (${acc.toFixed(1)})`);
  }
  return (
    <div data-testid="slow-list">
      {items.map((item) => (
        <div className="slow-list-item" key={item}>
          {item}
        </div>
      ))}
    </div>
  );
}

export default withBugseeProfiler(SlowListImpl, 'SlowList');
