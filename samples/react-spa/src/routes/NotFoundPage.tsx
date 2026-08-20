import { Link } from 'react-router-dom';

export default function NotFoundPage(): JSX.Element {
  return (
    <div>
      <h2>Not found</h2>
      <p>
        <Link to="/boards">Back to boards</Link>
      </p>
    </div>
  );
}
