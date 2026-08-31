import { A } from '@solidjs/router';
import type { JSX } from 'solid-js';

export default function NotFoundPage(): JSX.Element {
  return (
    <div>
      <h2>Not found</h2>
      <p>
        <A href="/issues">Back to issues</A>
      </p>
    </div>
  );
}
