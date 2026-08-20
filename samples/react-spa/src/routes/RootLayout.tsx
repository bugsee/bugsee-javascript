import { NavLink, Outlet } from 'react-router-dom';

export default function RootLayout(): JSX.Element {
  return (
    <div className="app-shell">
      <nav className="app-nav">
        <h1>Kanbugsee</h1>
        <NavLink to="/boards" className={({ isActive }) => (isActive ? 'active' : '')}>
          Boards
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
          Settings
        </NavLink>
        <NavLink to="/scenarios" className={({ isActive }) => (isActive ? 'active' : '')}>
          Scenarios
        </NavLink>
      </nav>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
