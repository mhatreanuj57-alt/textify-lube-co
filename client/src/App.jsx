import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Spinner from '@/components/Shared/Spinner';
import { useAuth } from '@/hooks/useAuth';
import AuthPage from '@/pages/AuthPage';

const ChatPage = lazy(() => import('@/pages/ChatPage'));

function ProtectedRoute({ children }) {
  const { user, loading, profile } = useAuth();

  if (loading) {
    return <Spinner fullscreen label="Loading Textify..." />;
  }

  if (!user || !profile) {
    return <Navigate to="/" replace />;
  }

  return children;
}

function PublicRoute({ children }) {
  const { user, loading, profile } = useAuth();

  if (loading) {
    return <Spinner fullscreen label="Loading Textify..." />;
  }

  if (user && profile) {
    return <Navigate to="/chat" replace />;
  }

  return children;
}

export default function App() {
  return (
    <Suspense fallback={<Spinner fullscreen label="Loading Textify..." />}>
      <Routes>
        <Route
          path="/"
          element={
            <PublicRoute>
              <AuthPage />
            </PublicRoute>
          }
        />
        <Route
          path="/chat"
          element={
            <ProtectedRoute>
              <ChatPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/chat/:conversationId"
          element={
            <ProtectedRoute>
              <ChatPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
