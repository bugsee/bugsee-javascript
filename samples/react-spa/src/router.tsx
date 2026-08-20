import { createBrowserRouter, Navigate } from 'react-router-dom';
import { instrumentReactRouter } from '@bugsee/react';
import RootLayout from './routes/RootLayout';
import BoardsIndexPage from './routes/BoardsIndexPage';
import BoardPage from './routes/BoardPage';
import CardModalRoute from './routes/CardModalRoute';
import SettingsPage from './routes/SettingsPage';
import ScenarioPage from './routes/ScenarioPage';
import NotFoundPage from './routes/NotFoundPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      { index: true, element: <Navigate to="/boards" replace /> },
      { path: 'boards', element: <BoardsIndexPage /> },
      {
        path: 'board/:id',
        element: <BoardPage />,
        children: [{ path: 'card/:cardId', element: <CardModalRoute /> }],
      },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'scenarios', element: <ScenarioPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

/**
 * @bugsee/react router integration under test: `instrumentReactRouter` names the current + every future
 * navigation's active transaction by the matched route PATTERN (`/board/:id`), never the concrete URL
 * (`/board/board-1`). A data router (`createBrowserRouter`) self-subscribes — no per-navigation call
 * needed. Returns an unsubscribe, kept around for symmetry even though this router lives for the app's
 * whole lifetime.
 */
export function wireRouterNaming(): () => void {
  return instrumentReactRouter(router);
}
